/**
 * Remote session synchronizer.
 *
 * The per-provider synchronizers only scan the LOCAL `~/.claude` home, so they
 * never see transcripts that Claude writes on a remote host. This service is the
 * remote counterpart: for every `project_type === 'remote'` project it SSH-scans
 * the host's `~/.claude/projects`, finds the transcripts whose recorded `cwd`
 * matches the project's remote path, and upserts them into the same `sessions`
 * table as local sessions — backfilling each row's remote `jsonl_path` so the
 * history reader can stream it back over SSH.
 *
 * Because each scan is an SSH round trip (and an unreachable host can take tens
 * of seconds to time out), it NEVER runs inline with a project-list request.
 * Instead the project list returns the current DB contents immediately and calls
 * {@link remoteSessionSynchronizer.triggerBackgroundSync} fire-and-forget, so
 * fresh remote sessions show up on the next load. Background passes are
 * throttled per project and skip long-dormant projects; the UI can still force
 * an immediate refresh via {@link remoteSessionSynchronizer.synchronizeProjectNow}.
 */

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { normalizeProjectPath, normalizeSessionName } from '@/shared/utils.js';
import {
  listRemoteClaudeTranscripts,
  readRemoteHistoryDisplayMap,
} from '@/services/remote-transcript.service.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';

const DEFAULT_SESSION_NAME = 'Untitled Claude Session';

/** Minimum gap between automatic background syncs of the same project. */
const BACKGROUND_RESYNC_MIN_MS = 30_000;
/**
 * A project whose newest session activity is older than this is considered
 * dormant: once it has been synced at least once in this process it is skipped
 * by background passes (a manual refresh still works). Keeps idle remote hosts
 * from being re-scanned on every project-list load.
 */
const DORMANT_MS = 14 * 24 * 60 * 60 * 1000;

/** project_id → last successful background/auto sync time (epoch ms). */
const lastSyncAt = new Map<string, number>();
/**
 * project_id → in-flight scan promise. Concurrent callers (e.g. a manual
 * refresh arriving while a background pass scans the same project) coalesce onto
 * the existing promise instead of launching a second SSH scan, and a manual
 * refresh awaits the real result rather than getting a misleading no-op.
 */
const inFlight = new Map<string, Promise<number>>();
/** Guards against overlapping background sweeps. */
let backgroundRunning = false;

/** Most recent session activity (epoch ms) recorded for a project, or 0. */
function projectLatestActivityMs(project: ProjectRepositoryRow): number {
  let latest = 0;
  for (const row of sessionsDb.getSessionsByProjectPath(project.project_path)) {
    const ts = Date.parse(row.updated_at ?? row.created_at ?? '');
    if (Number.isFinite(ts) && ts > latest) {
      latest = ts;
    }
  }
  return latest;
}

/**
 * Whether a project should be auto-synced by a background pass right now.
 * Always syncs a project not yet seen this process (initial discovery / catches
 * changes made while the server was down); otherwise debounces and skips
 * long-dormant projects.
 */
function isEligibleForBackgroundSync(project: ProjectRepositoryRow): boolean {
  const last = lastSyncAt.get(project.project_id);
  if (last === undefined) {
    return true;
  }
  const now = Date.now();
  if (now - last < BACKGROUND_RESYNC_MIN_MS) {
    return false;
  }
  const latestActivity = projectLatestActivityMs(project);
  if (latestActivity > 0 && now - latestActivity > DORMANT_MS) {
    return false;
  }
  return true;
}

/**
 * Scans one remote project and upserts every transcript that belongs to it.
 * Returns the number of sessions indexed.
 */
async function synchronizeRemoteProject(
  project: ProjectRepositoryRow,
  since: Date | null,
): Promise<number> {
  const remotePath = project.remote_path;
  if (!remotePath) {
    return 0;
  }

  // Claude buckets transcripts by the working directory they were started in.
  // Only index files whose `cwd` matches this project's remote path so two
  // projects on the same host never absorb each other's sessions.
  const targetCwd = normalizeProjectPath(remotePath);
  const sinceMs = since ? since.getTime() : 0;

  const entries = await listRemoteClaudeTranscripts(project);
  // Resolve display names the same way the local synchronizer does: prefer the
  // host's history.jsonl display, then a title embedded in the transcript.
  const historyMap = await readRemoteHistoryDisplayMap(project);

  let processed = 0;
  for (const entry of entries) {
    if (!entry.sessionId || !entry.cwd) {
      continue;
    }
    // Incremental scan: skip transcripts untouched since the last scan.
    if (sinceMs && entry.mtimeMs && entry.mtimeMs <= sinceMs) {
      continue;
    }
    if (normalizeProjectPath(entry.cwd) !== targetCwd) {
      continue;
    }

    const existing = sessionsDb.getSessionById(entry.sessionId);
    const updatedAt = entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : undefined;

    // Preserve an existing real name (e.g. a live-chat summary); otherwise
    // resolve from history.jsonl → transcript title → placeholder, mirroring
    // the local synchronizer's precedence.
    let customName: string | undefined;
    if (existing?.custom_name && existing.custom_name !== DEFAULT_SESSION_NAME) {
      customName = undefined;
    } else {
      const resolved = historyMap.get(entry.sessionId) ?? entry.title ?? undefined;
      customName = normalizeSessionName(resolved, DEFAULT_SESSION_NAME);
    }

    sessionsDb.createSession(
      entry.sessionId,
      'claude',
      project.project_path,
      customName,
      updatedAt, // createdAt: only applied on first insert
      updatedAt,
      entry.jsonlPath,
    );
    processed += 1;
  }

  return processed;
}

/**
 * Runs one project's scan, coalescing concurrent callers onto a single in-flight
 * SSH scan so a manual refresh and a background pass never scan the same project
 * twice at once (and the manual caller awaits the real result).
 */
function runProjectSync(project: ProjectRepositoryRow): Promise<number> {
  const existing = inFlight.get(project.project_id);
  if (existing) {
    return existing;
  }

  const run = (async () => {
    try {
      const processed = await synchronizeRemoteProject(project, null);
      lastSyncAt.set(project.project_id, Date.now());
      return processed;
    } finally {
      inFlight.delete(project.project_id);
    }
  })();

  inFlight.set(project.project_id, run);
  return run;
}

export const remoteSessionSynchronizer = {
  /**
   * Scans every active remote project over SSH and indexes its transcripts.
   * Per-project failures are isolated and logged so one unreachable host never
   * aborts the rest of the sweep. Kept for explicit full syncs; routine refresh
   * goes through {@link triggerBackgroundSync}.
   */
  async synchronize(since?: Date): Promise<number> {
    const projects = projectsDb.getRemoteProjects();
    let processed = 0;

    for (const project of projects) {
      try {
        processed += await synchronizeRemoteProject(project, since ?? null);
      } catch (error) {
        console.warn(
          `[remote-sync] scan failed for project ${project.project_id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return processed;
  },

  /**
   * Fire-and-forget background sweep of eligible remote projects. Returns
   * immediately; never throws. Safe to call on every project-list load — a
   * single sweep runs at a time, each project is debounced, and dormant projects
   * are skipped. Newly created sessions still appear instantly because the live
   * chat path persists them directly.
   */
  triggerBackgroundSync(): void {
    if (backgroundRunning) {
      return;
    }
    backgroundRunning = true;

    void (async () => {
      try {
        const projects = projectsDb.getRemoteProjects();
        for (const project of projects) {
          if (!isEligibleForBackgroundSync(project)) {
            continue;
          }
          try {
            await runProjectSync(project);
          } catch (error) {
            console.warn(
              `[remote-sync] background scan failed for project ${project.project_id}:`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } finally {
        backgroundRunning = false;
      }
    })();
  },

  /**
   * Forces an immediate scan of ONE remote project, bypassing the debounce and
   * dormant checks. Backs the manual "refresh" action in the UI. Resolves with
   * the number of sessions indexed; throws on connection/scan failure so the
   * caller can surface it.
   */
  async synchronizeProjectNow(projectId: string): Promise<number> {
    const project = projectsDb.getProjectById(projectId);
    if (!project || project.project_type !== 'remote') {
      throw new Error(`Project ${projectId} is not a remote project.`);
    }
    return runProjectSync(project);
  },
};
