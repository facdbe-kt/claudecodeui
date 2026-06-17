/**
 * Remote transcript I/O over SSH.
 *
 * Claude writes its session transcripts as JSONL under `~/.claude/projects/...`
 * ON THE REMOTE HOST for `project_type === 'remote'` projects. The local
 * persistence pipeline (synchronizer → DB → history reader) only ever touches
 * the LOCAL filesystem, so this module is the remote counterpart: it reads a
 * remote transcript (and its `agent-*.jsonl` siblings) over the pooled SSH
 * connection, and enumerates a host's transcripts so they can be indexed into
 * the same `sessions` table as local sessions.
 *
 * All remote paths embedded into shell commands are validated (no control chars,
 * no single quote / backtick / `$(`) and single-quoted, mirroring the defensive
 * checks the remote Claude runner applies, so a crafted path can never inject
 * shell.
 */

import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { rowToRemoteConfig } from '@/shared/remote-project.js';
import { sshConnectionManager } from '@/services/ssh-connection-manager.service.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';

/** Field/record separators (US/RS control chars) used by the scan pipeline. */
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

/**
 * One transcript discovered on a remote host, with the metadata the indexer
 * needs to upsert a session row.
 */
export type RemoteTranscriptEntry = {
  /** Absolute remote path to the `<sessionId>.jsonl` transcript. */
  jsonlPath: string;
  /** Session id (parsed from the transcript, falling back to the filename). */
  sessionId: string;
  /** The `cwd` recorded inside the transcript (the remote working directory). */
  cwd: string | null;
  /** Last-modified time in epoch milliseconds (0 when stat failed). */
  mtimeMs: number;
  /**
   * Title candidate extracted from the transcript itself (last `aiTitle` /
   * `lastPrompt` / `customTitle` event), used as a fallback when the host's
   * `history.jsonl` has no display name for the session. Null when none found.
   */
  title: string | null;
};

/** True when a project path is a synthetic remote URI key (`scheme://...`). */
export function isRemoteProjectPath(projectPath: string | null | undefined): boolean {
  return typeof projectPath === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(projectPath);
}

/**
 * Validates a remote path before it is single-quoted into a shell command.
 * Refuses control chars and the characters that could break out of quoting.
 */
function assertSafeRemotePath(value: string): void {
  if (!value) {
    throw new Error('Remote path is empty.');
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Remote path contains control characters.');
  }
  if (value.includes("'") || value.includes('`') || value.includes('$(')) {
    throw new Error('Remote path contains unsafe shell metacharacters.');
  }
}

/** Single-quotes a value for safe embedding in a remote shell command. */
function shellQuote(value: string): string {
  return `'${value}'`;
}

/**
 * Resolves the remote project row that owns a session's stored `project_path`.
 * Returns null when the path is not a remote key or the project is gone.
 */
export function resolveRemoteProjectByPath(projectPath: string): ProjectRepositoryRow | null {
  if (!isRemoteProjectPath(projectPath)) {
    return null;
  }
  return projectsDb.getRemoteProjectByPath(projectPath);
}

/**
 * Reads a remote text file and returns its lines. Throws on SSH/connection
 * failure; returns a single empty string for an empty/missing file (cat prints
 * nothing), which the line-based parsers skip. The provider uses this for both
 * the main transcript and its `agent-*.jsonl` siblings so remote history parses
 * through the exact same code path as local history.
 */
export async function readRemoteFileLines(
  project: ProjectRepositoryRow,
  remotePath: string,
): Promise<string[]> {
  assertSafeRemotePath(remotePath);
  const config = rowToRemoteConfig(project);
  const result = await sshConnectionManager.execCommand(
    project.project_id,
    `cat ${shellQuote(remotePath)} 2>/dev/null || true`,
    config,
  );
  return result.stdout.split('\n');
}

/**
 * Encodes an absolute project path into Claude's transcript directory name.
 * Claude stores each project's sessions under
 * `~/.claude/projects/<encoded>/`, where the encoding replaces every
 * non-alphanumeric character with `-` (e.g. `/home/u/a_b` →
 * `-home-u-a-b`). Returns '' for an empty path. The result is `[A-Za-z0-9-]`
 * only, so it is always safe to embed in a shell command.
 */
export function encodeClaudeProjectDir(remotePath: string): string {
  if (!remotePath) {
    return '';
  }
  return remotePath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Enumerates the Claude transcripts for ONE remote project (excluding `agent-*`
 * sub-agent files). It scans only that project's encoded directory
 * (`~/.claude/projects/<encoded>/`) rather than the whole tree, which on hosts
 * with many projects is the difference between scanning tens vs. thousands of
 * files. For each file it returns the path, mtime, parsed session id, recorded
 * `cwd`, and a title candidate. A single pooled SSH command does all the work to
 * avoid per-file round trips.
 */
export async function listRemoteClaudeTranscripts(
  project: ProjectRepositoryRow,
): Promise<RemoteTranscriptEntry[]> {
  const config = rowToRemoteConfig(project);

  const encodedDir = encodeClaudeProjectDir(project.remote_path ?? '');
  if (!encodedDir) {
    return [];
  }

  // One bash pipeline: for every transcript print
  // `path<US>mtime<US>cwdLine<US>titleLine<RS>`. The first line containing
  // `"cwd"` carries the working dir + session id; the last line matching a
  // title field is the freshest session title. `encodedDir` is `[A-Za-z0-9-]`
  // only, and the script uses only double quotes internally, so the whole
  // program can be single-quoted safely.
  const script =
    `ROOT="$HOME/.claude/projects/${encodedDir}"; [ -d "$ROOT" ] || exit 0; ` +
    'find "$ROOT" -maxdepth 1 -type f -name "*.jsonl" ! -name "agent-*" -print0 2>/dev/null | ' +
    'while IFS= read -r -d "" f; do ' +
    'mt=$(stat -c %Y "$f" 2>/dev/null) || mt=$(stat -f %m "$f" 2>/dev/null) || mt=0; ' +
    'line=$(grep -m1 "\\"cwd\\"" "$f" 2>/dev/null); ' +
    'tl=$(grep -aE "\\"(aiTitle|lastPrompt|customTitle)\\"" "$f" 2>/dev/null | tail -n 1); ' +
    'printf "%s\\037%s\\037%s\\037%s\\036" "$f" "$mt" "$line" "$tl"; ' +
    'done';

  const result = await sshConnectionManager.execCommand(
    project.project_id,
    `bash -c ${shellQuote(script)}`,
    config,
  );

  const entries: RemoteTranscriptEntry[] = [];
  for (const record of result.stdout.split(RECORD_SEP)) {
    if (!record) {
      continue;
    }
    const [jsonlPath, mtimeRaw, cwdLine, titleLine] = record.split(FIELD_SEP);
    if (!jsonlPath) {
      continue;
    }

    const mtimeSeconds = Number(mtimeRaw);
    const mtimeMs = Number.isFinite(mtimeSeconds) ? mtimeSeconds * 1000 : 0;

    // Session id is the filename stem; the in-file `sessionId` (when present)
    // takes precedence so renamed/edited files still map correctly.
    const fileStem = path.posix.basename(jsonlPath).replace(/\.jsonl$/, '');
    let sessionId = fileStem;
    let cwd: string | null = null;

    if (cwdLine && cwdLine.trim()) {
      try {
        const parsed = JSON.parse(cwdLine.trim()) as Record<string, unknown>;
        if (typeof parsed.cwd === 'string') {
          cwd = parsed.cwd;
        }
        if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
      } catch {
        // Non-JSON line (shouldn't happen) — fall back to filename-derived id.
      }
    }

    let title: string | null = null;
    if (titleLine && titleLine.trim()) {
      try {
        const parsed = JSON.parse(titleLine.trim()) as Record<string, unknown>;
        const candidate = parsed.aiTitle ?? parsed.lastPrompt ?? parsed.customTitle;
        if (typeof candidate === 'string' && candidate.trim()) {
          title = candidate.trim();
        }
      } catch {
        // Ignore unparseable title lines.
      }
    }

    entries.push({ jsonlPath, sessionId, cwd, mtimeMs, title });
  }

  return entries;
}

/**
 * Reads the remote host's `~/.claude/history.jsonl` and builds a
 * `sessionId → display` map (first value wins), mirroring how the local
 * synchronizer resolves session display names. Returns an empty map when the
 * file is absent or unreadable so naming degrades gracefully.
 */
export async function readRemoteHistoryDisplayMap(
  project: ProjectRepositoryRow,
): Promise<Map<string, string>> {
  const config = rowToRemoteConfig(project);
  const result = await sshConnectionManager.execCommand(
    project.project_id,
    'cat "$HOME/.claude/history.jsonl" 2>/dev/null || true',
    config,
  );

  const map = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const key = parsed.sessionId;
      const value = parsed.display;
      if (typeof key === 'string' && typeof value === 'string' && !map.has(key)) {
        map.set(key, value);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return map;
}
