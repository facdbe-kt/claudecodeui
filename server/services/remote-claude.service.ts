/**
 * Remote Claude integration.
 *
 * Mirrors `queryClaudeSDK` (server/claude-sdk.js) but runs the Claude CLI ON THE
 * REMOTE HOST over SSH for projects whose `project_type === 'remote'`, streaming
 * the result back into the SAME chat UI. The websocket message shapes/sequence
 * emitted here are identical to the in-process SDK path so the frontend renders
 * remote output with zero rendering changes.
 *
 * PROVEN MECHANISM (validated live):
 *   bash -ic "cd '<remote_path>' && claude -p --output-format stream-json --verbose [--resume <session_id>]"
 *   - `bash -ic` (INTERACTIVE) so ~/.bashrc loads PATH (nvm) + auth env. `bash -lc`
 *     does NOT and yields a 403.
 *   - Job-control warnings go to STDERR; STDOUT is clean JSONL. We parse stdout only.
 *   - The user prompt is written to the process STDIN (claude -p reads stdin when no
 *     prompt arg is given) — NEVER interpolated into the shell string, so arbitrary
 *     chat text cannot inject shell.
 *
 * Event stream (one JSON object per line):
 *   {type:"system",subtype:"init",session_id,model,tools}
 *   {type:"rate_limit_event",...} (optional)
 *   {type:"assistant",message:{...content:[{type:"text",text}]...}}
 *   {type:"result",subtype:"success",is_error,result,total_cost_usd,session_id}
 * Errors arrive as an assistant text + a result with is_error:true / api_error_status.
 *
 * Each parsed event is fed through `sessionsService.normalizeMessage('claude', ...)`
 * — the exact same normalizer the local SDK path uses — so assistant/text/tool
 * frames map identically. We additionally emit the session_created / complete /
 * error / token_budget frames that `queryClaudeSDK` sends.
 */

import { projectsDb } from '@/modules/database/index.js';
import { rowToRemoteConfig } from '@/shared/remote-project.js';
import { createNormalizedMessage } from '@/shared/utils.js';
import { sessionsService } from '@/modules/providers/index.js';
import {
  sshConnectionManager,
  type SSHStreamHandle,
} from '@/services/ssh-connection-manager.service.js';
import type { AnyRecord, RemoteProjectConfig } from '@/shared/types.js';
import {
  notifyRunFailed,
  notifyRunStopped,
} from '@/services/notification-orchestrator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal writer surface shared with the local path. `WebSocketWriter` (and the
 * SSE writers) satisfy this; we keep it structural so this file does not depend
 * on the concrete class.
 */
type ChatWriter = {
  send: (data: unknown) => void;
  setSessionId?: (sessionId: string) => void;
  userId?: string | number | null;
};

type RemoteQueryOptions = AnyRecord & {
  projectId?: string;
  sessionId?: string;
  sessionSummary?: string;
  model?: string;
};

type RemoteSession = {
  handle: SSHStreamHandle;
  status: 'active' | 'aborted';
  startTime: number;
};

// ---------------------------------------------------------------------------
// Active session registry (for abort)
// ---------------------------------------------------------------------------

const activeRemoteSessions = new Map<string, RemoteSession>();

// Before a session id is known (the very first turn), abort requests cannot key
// off the captured id. We also track in-flight handles by projectId so an abort
// arriving before `init` can still stop the remote process.
const pendingByProject = new Map<string, RemoteSession>();

function registerSession(key: string, session: RemoteSession): void {
  activeRemoteSessions.set(key, session);
}

function removeSession(key: string | null | undefined): void {
  if (key) activeRemoteSessions.delete(key);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates the remote working directory before it is embedded (single-quoted)
 * into the `cd` of the remote shell command. Refuses control chars and the
 * characters that could break out of single-quoting. Mirrors the defensive
 * check the file-system adapter applies to remote paths.
 */
function assertSafeRemotePath(value: string): void {
  if (!value || value.length === 0) {
    throw new Error('Remote project path is empty.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Remote project path contains control characters.');
  }
  if (value.includes("'") || value.includes('`') || value.includes('$(')) {
    throw new Error('Remote project path contains unsafe shell metacharacters.');
  }
}

/** Single-quotes a value for safe embedding in the remote shell command. */
function shellQuote(value: string): string {
  return `'${value}'`;
}

/**
 * Validates a session id before it is appended to `--resume`. Session ids are
 * UUID-like; we accept only a conservative charset so a crafted id can never
 * inject shell. Returns null if the id is unusable.
 */
function safeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/**
 * Builds the remote command string. The prompt is NOT included here — it is
 * written to stdin. Only the validated cwd and (optional) resume id are embedded.
 */
function buildRemoteCommand(remotePath: string, resumeId: string | null): string {
  assertSafeRemotePath(remotePath);
  const inner =
    `cd ${shellQuote(remotePath)} && claude -p --output-format stream-json --verbose` +
    (resumeId ? ` --resume ${resumeId}` : '');
  // Single-quote the whole interactive-shell argument; inner contains no single
  // quotes because remotePath is validated and resumeId is charset-restricted.
  return `bash -ic ${shellQuote(inner)}`;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Runs a Claude query on the remote host for a remote project. Same call
 * signature/contract as `queryClaudeSDK(command, options, ws)`.
 */
async function queryClaudeRemote(
  command: string,
  options: RemoteQueryOptions = {},
  ws: ChatWriter
): Promise<void> {
  const { sessionId, sessionSummary } = options;
  let capturedSessionId: string | null = readString(sessionId);
  let sessionCreatedSent = false;
  let resultErrored = false;
  const projectId = readString(options.projectId);

  try {
    if (!projectId) {
      throw new Error('Missing projectId for remote Claude query.');
    }

    const row = projectsDb.getProjectById(projectId);
    if (!row) {
      throw new Error(`Project ${projectId} not found.`);
    }
    if (row.project_type !== 'remote') {
      throw new Error(`Project ${projectId} is not a remote project.`);
    }

    const config: RemoteProjectConfig = rowToRemoteConfig(row);
    const remotePath = config.path;

    const resumeId = safeSessionId(sessionId);
    const remoteCommand = buildRemoteCommand(remotePath, resumeId);

    // Holds the registered session; updated once we capture the real session id.
    const session: RemoteSession = {
      // handle assigned below once execStream resolves
      handle: { write: () => {}, end: () => {}, kill: () => {} },
      status: 'active',
      startTime: Date.now(),
    };
    pendingByProject.set(projectId, session);

    const sid = (): string | null => capturedSessionId || readString(sessionId);

    const handleEvent = (raw: AnyRecord): void => {
      const type = raw.type;

      // Capture session id from init/result and propagate exactly like the SDK path.
      const eventSessionId = readString(raw.session_id);
      if (eventSessionId && !capturedSessionId) {
        capturedSessionId = eventSessionId;
        registerSession(capturedSessionId, session);
        if (typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(
            createNormalizedMessage({
              kind: 'session_created',
              newSessionId: capturedSessionId,
              sessionId: capturedSessionId,
              provider: 'claude',
            })
          );
        }
      }

      // The init/system + rate_limit events carry no chat content; the normalizer
      // ignores them. We forward everything to the normalizer (it returns [] for
      // shapes it doesn't recognize) so assistant/text/tool frames map identically.
      const normalized = sessionsService.normalizeMessage('claude', raw, sid());
      for (const msg of normalized) {
        ws.send(msg);
      }

      // Emit token budget from result usage if present (mirrors SDK path shape).
      if (type === 'result') {
        if (raw.is_error === true) {
          resultErrored = true;
        }
        const usage = raw.usage as AnyRecord | undefined;
        if (usage && typeof usage === 'object') {
          const inputTokens =
            Number(usage.input_tokens ?? 0) +
            Number(usage.cache_creation_input_tokens ?? 0) +
            Number(usage.cache_read_input_tokens ?? 0);
          const outputTokens = Number(usage.output_tokens ?? 0);
          const contextWindow = parseInt(process.env.CONTEXT_WINDOW ?? '', 10) || 160000;
          ws.send(
            createNormalizedMessage({
              kind: 'status',
              text: 'token_budget',
              tokenBudget: {
                used: inputTokens + outputTokens,
                total: contextWindow,
                inputTokens,
                outputTokens,
                breakdown: { input: inputTokens, output: outputTokens },
              },
              sessionId: sid(),
              provider: 'claude',
            })
          );
        }
      }
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      sshConnectionManager
        .execStream(
          projectId,
          remoteCommand,
          {
            onStdoutLine: (line) => {
              const trimmed = line.trim();
              if (!trimmed) return;
              let parsed: AnyRecord | null = null;
              try {
                parsed = JSON.parse(trimmed) as AnyRecord;
              } catch {
                // Non-JSON stdout (shouldn't happen for clean stream-json) is ignored.
                return;
              }
              try {
                handleEvent(parsed);
              } catch (e) {
                console.error('[remote-claude] event handling error:', e);
              }
            },
            onStderrLine: (line) => {
              // bash -ic emits harmless job-control warnings; log at debug level only.
              if (line.trim()) {
                console.log('[remote-claude][stderr]', line);
              }
            },
            onError: (e) => finish(e),
            onClose: (code) => {
              if (code && code !== 0 && !resultErrored) {
                finish(new Error(`Remote Claude exited with code ${code}.`));
              } else {
                finish();
              }
            },
          },
          config
        )
        .then((handle) => {
          session.handle = handle;
          // Write the user prompt to stdin (avoids shell injection), then close stdin
          // so `claude -p` knows the prompt is complete.
          handle.write(command ?? '');
          handle.end();
        })
        .catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
    });

    // Cleanup registry.
    removeSession(capturedSessionId);
    if (pendingByProject.get(projectId) === session) {
      pendingByProject.delete(projectId);
    }

    const wasAborted = session.status === 'aborted';

    ws.send(
      createNormalizedMessage({
        kind: 'complete',
        exitCode: wasAborted ? 1 : 0,
        aborted: wasAborted || undefined,
        isNewSession: !sessionId && !!command,
        sessionId: capturedSessionId,
        provider: 'claude',
      })
    );

    notifyRunStopped({
      userId: ws?.userId ?? null,
      provider: 'claude',
      sessionId: capturedSessionId || readString(sessionId) || null,
      sessionName: sessionSummary ?? null,
      stopReason: wasAborted ? 'aborted' : 'completed',
    } as Parameters<typeof notifyRunStopped>[0]);
  } catch (error) {
    console.error('[remote-claude] query error:', error);
    removeSession(capturedSessionId);
    if (projectId && pendingByProject.has(projectId)) {
      pendingByProject.delete(projectId);
    }

    const message = error instanceof Error ? error.message : String(error);
    ws.send(
      createNormalizedMessage({
        kind: 'error',
        content: message,
        sessionId: capturedSessionId || readString(sessionId) || null,
        provider: 'claude',
      })
    );
    notifyRunFailed({
      userId: ws?.userId ?? null,
      provider: 'claude',
      sessionId: capturedSessionId || readString(sessionId) || null,
      sessionName: sessionSummary ?? null,
      error: error instanceof Error ? error : new Error(message),
    } as Parameters<typeof notifyRunFailed>[0]);
  }
}

/**
 * Aborts an active remote Claude run by session id, killing the remote process
 * (SIGINT + channel close). Mirrors `abortClaudeSDKSession`'s boolean contract.
 */
async function abortClaudeRemoteSession(sessionId: string): Promise<boolean> {
  const session = activeRemoteSessions.get(sessionId);
  if (!session) {
    return false;
  }
  try {
    session.status = 'aborted';
    session.handle.kill();
    removeSession(sessionId);
    return true;
  } catch (error) {
    console.error(`[remote-claude] error aborting session ${sessionId}:`, error);
    return false;
  }
}

/** Whether a remote Claude session is currently running. */
function isClaudeRemoteSessionActive(sessionId: string): boolean {
  const session = activeRemoteSessions.get(sessionId);
  return Boolean(session && session.status === 'active');
}

export {
  queryClaudeRemote,
  abortClaudeRemoteSession,
  isClaudeRemoteSessionActive,
};
