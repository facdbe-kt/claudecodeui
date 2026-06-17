/**
 * SSH connection manager service.
 *
 * Maintains a pool of live ssh2 connections keyed by `projectId` so remote
 * projects can reuse a single authenticated session for shell, search,
 * file-tree, and AI-CLI operations. Connections are auth'd using credentials
 * decrypted on demand via `credentialsDb.getRemoteCredential` (the raw secret
 * is never persisted in memory beyond the connect handshake and never logged).
 *
 * The manager extends EventEmitter and emits a `status` event with
 * { projectId, status, error? } whenever a connection transitions between
 * 'connecting' | 'connected' | 'disconnected' | 'error'.
 *
 * HOST KEY POLICY (trust-on-first-use, record-only for now):
 *   On the first connection we capture the host key fingerprint and log it, but
 *   we ACCEPT it unconditionally. This is a deliberate, documented interim
 *   choice: strict verification (comparing against a recorded/known fingerprint
 *   and refusing on mismatch) can be layered on later by storing the recorded
 *   fingerprint and rejecting in `hostVerifier`. The verifier is structured so
 *   that future strict mode only needs to flip the accept/reject decision.
 */

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import { EventEmitter } from 'node:events';
import crypto from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { credentialsDb } from '@/modules/database/index.js';
import type { RemoteProjectConfig } from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SSH handshake timeout (ms). */
const READY_TIMEOUT_MS = 10_000;
/** SSH-level keepalive cadence (ms). */
const KEEPALIVE_INTERVAL_MS = 30_000;
/** Idle connections are auto-disconnected after this long without activity (ms). */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Maximum number of pooled live connections. */
const MAX_CONNECTIONS = 50;
/** Connect retry attempts for transient/network errors only. */
const MAX_CONNECT_ATTEMPTS = 3;
/** Delay between connect retries (ms). */
const RETRY_DELAY_MS = 2_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Lifecycle status of a pooled SSH connection. */
export type SSHConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Payload emitted on the `status` event for every connection transition. */
export type SSHStatusEvent = {
  projectId: string;
  status: SSHConnectionStatus;
  error?: string;
};

/** Result of a one-off remote command execution. */
export type SSHExecResult = {
  stdout: string;
  stderr: string;
  code: number;
};

/**
 * Event handlers for a streaming remote command ({@link SSHConnectionManager.execStream}).
 * `onStdoutLine`/`onStderrLine` are invoked once per complete line (newline
 * stripped); `onClose` fires exactly once when the channel closes with the
 * remote exit code (or null if the channel was killed/aborted).
 */
export type SSHStreamHandlers = {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number | null) => void;
};

/**
 * Handle returned by {@link SSHConnectionManager.execStream}. `write` pushes
 * bytes to the remote process stdin (e.g. the user prompt for `claude -p`);
 * `end` closes stdin; `kill` tears the channel down (SIGINT first, then a hard
 * channel close) so an aborted chat turn stops the remote process.
 */
export type SSHStreamHandle = {
  write: (data: string) => void;
  end: () => void;
  kill: () => void;
};

/** Result of a non-throwing connection probe. */
export type SSHTestResult = {
  ok: boolean;
  error?: string;
};

/**
 * Public wrapper around a pooled ssh2 connection.
 *
 * Exposes the live `client` for advanced consumers (shell/sftp) plus the
 * metadata the manager tracks. Consumers should prefer the manager's helpers
 * (`execCommand`) over driving the client directly when possible.
 */
export type SSHConnection = {
  projectId: string;
  client: Client;
  status: SSHConnectionStatus;
  host: string;
  port: number;
  user: string;
  /** Recorded host key fingerprint (sha256 base64), captured on first connect. */
  hostKeyFingerprint: string | null;
  connectedAt: number;
  lastUsedAt: number;
};

// ---------------------------------------------------------------------------
// Internal pool entry
// ---------------------------------------------------------------------------

type PoolEntry = {
  connection: SSHConnection;
  idleTimer: NodeJS.Timeout | null;
};

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Maps a raw ssh2/socket error into a clear, user-safe message. Never includes
 * credential material. Also classifies whether the failure is transient (worth
 * retrying) vs. fatal (e.g. authentication, which must not be retried).
 */
function classifyError(err: unknown): { message: string; transient: boolean } {
  const e = err as
    | (Error & { level?: string; code?: string })
    | undefined;
  const level = e?.level ?? '';
  const code = e?.code ?? '';
  const raw = (e?.message ?? String(err ?? '')).toLowerCase();

  // Authentication failures are fatal: never retry, and surface a clear hint.
  if (
    level === 'client-authentication' ||
    raw.includes('authentication') ||
    raw.includes('all configured authentication methods failed') ||
    raw.includes('permission denied')
  ) {
    return {
      message: 'Authentication failed: check the username and credential.',
      transient: false,
    };
  }

  // Handshake/connection timeout.
  if (raw.includes('timed out') || raw.includes('timeout') || code === 'ETIMEDOUT') {
    return {
      message: 'Connection timed out: the host did not respond in time.',
      transient: true,
    };
  }

  // Host unreachable / DNS / refused — transient network conditions.
  if (code === 'ECONNREFUSED' || raw.includes('econnrefused')) {
    return {
      message: 'Connection refused: nothing is listening on that host and port.',
      transient: true,
    };
  }
  if (code === 'ENOTFOUND' || raw.includes('enotfound') || raw.includes('getaddrinfo')) {
    return {
      message: 'Host not found: check the hostname.',
      transient: true,
    };
  }
  if (
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  ) {
    return {
      message: 'Host unreachable: the network connection to the host failed.',
      transient: true,
    };
  }

  // Default: treat as transient network noise but keep the message generic.
  return {
    message: 'Failed to connect to the remote host.',
    transient: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

class SSHConnectionManager extends EventEmitter {
  private pool = new Map<string, PoolEntry>();

  /**
   * Establishes a new ssh2 connection for `projectId`, or returns the existing
   * live one. Retries up to MAX_CONNECT_ATTEMPTS for transient/network errors
   * only (authentication failures fail fast).
   */
  async connect(
    projectId: string,
    config: RemoteProjectConfig
  ): Promise<SSHConnection> {
    const existing = this.pool.get(projectId);
    if (existing && existing.connection.status === 'connected') {
      this.touch(projectId);
      return existing.connection;
    }

    if (
      !this.pool.has(projectId) &&
      this.pool.size >= MAX_CONNECTIONS
    ) {
      throw new Error(
        `SSH connection limit reached (${MAX_CONNECTIONS}); close an existing connection first.`
      );
    }

    const connectConfig = this.buildConnectConfig(config);

    let lastError: { message: string; transient: boolean } | null = null;
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      this.emitStatus(projectId, 'connecting');
      try {
        const connection = await this.openClient(
          projectId,
          config,
          connectConfig
        );
        return connection;
      } catch (err) {
        const classified = classifyError(err);
        lastError = classified;
        if (!classified.transient || attempt === MAX_CONNECT_ATTEMPTS) {
          break;
        }
        await sleep(RETRY_DELAY_MS);
      }
    }

    const message = lastError?.message ?? 'Failed to connect to the remote host.';
    this.emitStatus(projectId, 'error', message);
    throw new Error(message);
  }

  /** Returns the live connection wrapper for `projectId`, or null. */
  getConnection(projectId: string): SSHConnection | null {
    const entry = this.pool.get(projectId);
    if (!entry || entry.connection.status !== 'connected') return null;
    return entry.connection;
  }

  /** Closes and removes the pooled connection for `projectId` (idempotent). */
  async disconnect(projectId: string): Promise<void> {
    const entry = this.pool.get(projectId);
    if (!entry) return;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }

    this.pool.delete(projectId);

    await new Promise<void>((resolve) => {
      const client = entry.connection.client;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      client.once('close', done);
      try {
        client.end();
      } catch {
        done();
      }
      // Guard against a client that never emits 'close'.
      setTimeout(done, 2_000);
    });

    if (entry.connection.status !== 'error') {
      this.emitStatus(projectId, 'disconnected');
    }
  }

  /**
   * Runs a single command over the pooled connection (opening one if needed),
   * collecting stdout/stderr and the exit code. Reused by remote search,
   * file-tree, and AI-CLI callers, so it stays a clean, self-contained helper.
   */
  async execCommand(
    projectId: string,
    cmd: string,
    config?: RemoteProjectConfig
  ): Promise<SSHExecResult> {
    let connection = this.getConnection(projectId);
    if (!connection) {
      if (!config) {
        throw new Error(
          `No live SSH connection for project ${projectId}; pass a config to connect.`
        );
      }
      connection = await this.connect(projectId, config);
    }

    this.touch(projectId);

    return new Promise<SSHExecResult>((resolve, reject) => {
      connection!.client.exec(cmd, (err, channel) => {
        if (err) {
          reject(new Error(classifyError(err).message));
          return;
        }

        let stdout = '';
        let stderr = '';
        let code = 0;

        channel.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        channel.on('exit', (exitCode: number | null) => {
          code = exitCode ?? 0;
        });
        channel.on('close', () => {
          resolve({ stdout, stderr, code });
        });
        channel.on('error', (e: Error) => {
          reject(new Error(classifyError(e).message));
        });
      });
    });
  }

  /**
   * Runs a command over the pooled connection (opening one lazily if needed) and
   * STREAMS its output line-by-line instead of buffering. Unlike `execCommand`
   * this returns a handle so the caller can write to the remote stdin, and tear
   * the channel down on abort. stdout and stderr are buffered separately and
   * split on newlines so partial chunks are never delivered mid-line; callers
   * parse stdout only (the remote `bash -ic` prints harmless job-control noise to
   * stderr).
   *
   * The returned promise resolves after `connect()` succeeds and the channel is
   * open; per-line/close events are delivered through `handlers`.
   */
  async execStream(
    projectId: string,
    cmd: string,
    handlers: SSHStreamHandlers,
    config?: RemoteProjectConfig
  ): Promise<SSHStreamHandle> {
    let connection = this.getConnection(projectId);
    if (!connection) {
      if (!config) {
        throw new Error(
          `No live SSH connection for project ${projectId}; pass a config to connect.`
        );
      }
      connection = await this.connect(projectId, config);
    }

    this.touch(projectId);

    return new Promise<SSHStreamHandle>((resolve, reject) => {
      connection!.client.exec(cmd, (err, channel) => {
        if (err) {
          reject(new Error(classifyError(err).message));
          return;
        }

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let closed = false;
        let exitCode: number | null = null;

        const flushLines = (
          buffer: string,
          emit?: (line: string) => void
        ): string => {
          let idx = buffer.indexOf('\n');
          while (idx !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (emit) emit(line);
            idx = buffer.indexOf('\n');
          }
          return buffer;
        };

        channel.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString('utf8');
          stdoutBuffer = flushLines(stdoutBuffer, handlers.onStdoutLine);
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          stderrBuffer += chunk.toString('utf8');
          stderrBuffer = flushLines(stderrBuffer, handlers.onStderrLine);
        });
        channel.on('exit', (code: number | null) => {
          exitCode = code;
        });
        channel.on('close', () => {
          if (closed) return;
          closed = true;
          // Flush any trailing partial line (no terminating newline).
          if (stdoutBuffer.length > 0 && handlers.onStdoutLine) {
            handlers.onStdoutLine(stdoutBuffer.replace(/\r$/, ''));
          }
          if (stderrBuffer.length > 0 && handlers.onStderrLine) {
            handlers.onStderrLine(stderrBuffer.replace(/\r$/, ''));
          }
          this.touch(projectId);
          handlers.onClose?.(exitCode);
        });
        channel.on('error', (e: Error) => {
          handlers.onError?.(new Error(classifyError(e).message));
        });

        resolve({
          write: (data: string) => {
            try {
              channel.write(data);
            } catch {
              /* channel may already be closed */
            }
          },
          end: () => {
            try {
              channel.end();
            } catch {
              /* ignore */
            }
          },
          kill: () => {
            try {
              // Best-effort interrupt, then force the channel closed.
              channel.signal('INT');
            } catch {
              /* signal may be unsupported by the remote sshd */
            }
            try {
              channel.close();
            } catch {
              /* ignore */
            }
          },
        });
      });
    });
  }

  /**
   * Connects, runs a trivial check, and disconnects — never throwing. Returns a
   * user-safe `{ ok, error? }` result for the "Test connection" UI. The probe
   * uses a fresh, dedicated connection so it never disturbs a pooled session.
   */
  async testConnection(config: RemoteProjectConfig): Promise<SSHTestResult> {
    const probeId = `__test__:${crypto.randomUUID()}`;
    try {
      await this.connect(probeId, config);
      const result = await this.execCommand(probeId, 'true', config);
      if (result.code !== 0) {
        return {
          ok: false,
          error: 'Connected, but the remote check command failed.',
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Connection failed.',
      };
    } finally {
      await this.disconnect(probeId).catch(() => {
        /* best-effort cleanup */
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Builds the ssh2 ConnectConfig, decrypting the referenced credential. The
   * decrypted secret is used only here and is never stored on the wrapper or
   * logged.
   *
   * For `authType === 'agent'` no per-project credential is read. Instead the
   * server authenticates with its own SSH agent (when `SSH_AUTH_SOCK` is set)
   * and/or the first default private key found in the server's `~/.ssh`.
   */
  private buildConnectConfig(config: RemoteProjectConfig): ConnectConfig {
    const base: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.user,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    };

    if (config.authType === 'agent') {
      let hasAuth = false;

      const authSock = process.env.SSH_AUTH_SOCK;
      if (authSock) {
        base.agent = authSock;
        hasAuth = true;
      }

      const defaultKey = this.readDefaultLocalKey();
      if (defaultKey) {
        base.privateKey = defaultKey;
        hasAuth = true;
      }

      if (!hasAuth) {
        throw new Error(
          'No local SSH agent or default key found for agent auth.'
        );
      }

      return base;
    }

    const credentialId = Number(config.credentialRef);
    if (!Number.isFinite(credentialId)) {
      throw new Error('Invalid credential reference for remote project.');
    }

    const credential = credentialsDb.getRemoteCredential(credentialId);
    if (!credential) {
      throw new Error('Remote credential not found.');
    }

    if (config.authType === 'key') {
      base.privateKey = credential.value;
    } else {
      base.password = credential.value;
    }

    return base;
  }

  /**
   * Reads the first existing default private key from the server's `~/.ssh`
   * (id_rsa, id_ed25519, id_ecdsa) and returns its contents, or null when none
   * exist. Used for `agent` auth so it works even without a running SSH agent.
   */
  private readDefaultLocalKey(): string | null {
    const sshDir = path.join(os.homedir(), '.ssh');
    const candidates = ['id_rsa', 'id_ed25519', 'id_ecdsa'];
    for (const name of candidates) {
      const keyPath = path.join(sshDir, name);
      try {
        if (fs.existsSync(keyPath)) {
          return fs.readFileSync(keyPath, 'utf8');
        }
      } catch {
        /* unreadable key file — try the next candidate */
      }
    }
    return null;
  }

  /**
   * Opens a single ssh2 Client and resolves once it is ready (or rejects on the
   * first error). Wires the host-key verifier and post-ready lifecycle
   * handlers. Resolution/rejection settle exactly once.
   */
  private openClient(
    projectId: string,
    config: RemoteProjectConfig,
    connectConfig: ConnectConfig
  ): Promise<SSHConnection> {
    return new Promise<SSHConnection>((resolve, reject) => {
      const client = new Client();
      let settled = false;
      let capturedFingerprint: string | null = null;

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      client.once('error', onError);

      client.once('ready', () => {
        if (settled) return;
        settled = true;
        client.removeListener('error', onError);

        const now = Date.now();
        const connection: SSHConnection = {
          projectId,
          client,
          status: 'connected',
          host: config.host,
          port: config.port,
          user: config.user,
          hostKeyFingerprint: capturedFingerprint,
          connectedAt: now,
          lastUsedAt: now,
        };

        const entry: PoolEntry = { connection, idleTimer: null };
        this.pool.set(projectId, entry);
        this.armIdleTimer(projectId);

        // After ready, treat transport-level errors/close as a disconnect of
        // the pooled connection rather than a connect failure.
        client.on('error', (err) => {
          const classified = classifyError(err);
          connection.status = 'error';
          this.emitStatus(projectId, 'error', classified.message);
        });
        client.on('close', () => {
          this.handleUnexpectedClose(projectId);
        });

        this.emitStatus(projectId, 'connected');
        resolve(connection);
      });

      client.connect({
        ...connectConfig,
        // Trust-on-first-use, record-only (see file header). We capture and log
        // the fingerprint, then accept. Strict mode would compare `fingerprint`
        // against a stored value here and call verify(false) on mismatch.
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          capturedFingerprint = crypto
            .createHash('sha256')
            .update(key)
            .digest('base64');
          console.log(
            `[ssh] host key for project=${projectId} ${config.host}:${config.port} ` +
              `SHA256:${capturedFingerprint} (accepted, record-only)`
          );
          verify(true);
        },
      });
    });
  }

  /** Marks a connection as recently used and re-arms its idle timer. */
  private touch(projectId: string): void {
    const entry = this.pool.get(projectId);
    if (!entry) return;
    entry.connection.lastUsedAt = Date.now();
    this.armIdleTimer(projectId);
  }

  /** (Re)starts the idle auto-disconnect timer for a connection. */
  private armIdleTimer(projectId: string): void {
    const entry = this.pool.get(projectId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      console.log(
        `[ssh] idle timeout: disconnecting project=${projectId} after ${IDLE_TIMEOUT_MS}ms`
      );
      void this.disconnect(projectId);
    }, IDLE_TIMEOUT_MS);
    // Don't keep the event loop alive solely for the idle timer.
    if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
  }

  /** Handles a transport closing outside of an explicit `disconnect` call. */
  private handleUnexpectedClose(projectId: string): void {
    const entry = this.pool.get(projectId);
    if (!entry) return;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const wasError = entry.connection.status === 'error';
    this.pool.delete(projectId);
    if (!wasError) {
      this.emitStatus(projectId, 'disconnected');
    }
  }

  /** Emits a typed `status` event for a connection transition. */
  private emitStatus(
    projectId: string,
    status: SSHConnectionStatus,
    error?: string
  ): void {
    const payload: SSHStatusEvent = { projectId, status };
    if (error) payload.error = error;
    this.emit('status', payload);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** Process-wide SSH connection manager singleton. */
export const sshConnectionManager = new SSHConnectionManager();

export type { SSHConnectionManager };
