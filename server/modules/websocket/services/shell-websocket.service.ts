import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import type { ClientChannel } from 'ssh2';
import { WebSocket, type RawData } from 'ws';

import { projectsDb } from '@/modules/database/index.js';
import { sshConnectionManager } from '@/services/ssh-connection-manager.service.js';
import { rowToRemoteConfig } from '@/shared/remote-project.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  projectId?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
  skipPermissions?: boolean;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
};

/**
 * Reconnect/buffer state for a remote SSH shell channel.
 *
 * Kept in a map parallel to `ptySessionsMap` (rather than widening that entry
 * with a discriminant) so the local node-pty reconnection path stays entirely
 * untouched and the two channel types never need narrowing in the hot loops.
 * The underlying ssh2 transport is pooled separately by `sshConnectionManager`
 * (keyed by projectId); this entry only owns the interactive shell channel.
 */
type RemoteShellSessionEntry = {
  channel: ClientChannel;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  projectId: string;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const remoteShellSessionsMap = new Map<string, RemoteShellSessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;

type ShellWebSocketDependencies = {
  getSessionById: (sessionId: string) => { cliSessionId?: string } | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId) {
      return `cursor-agent --resume="${sessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (hasSession && sessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${sessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = sessionId;
    if (hasSession && sessionId) {
      try {
        const existingSession = dependencies.getSessionById(sessionId);
        if (existingSession && existingSession.cliSessionId) {
          resumeId = existingSession.cliSessionId;
          if (!safeSessionIdPattern.test(resumeId)) {
            resumeId = '';
          }
        }
      } catch (error) {
        console.error('Failed to get Gemini CLI session ID:', error);
      }
    }

    if (hasSession && resumeId) {
      return `${command} --resume "${resumeId}"`;
    }
    return command;
  }

  if (provider === 'opencode') {
    if (hasSession && sessionId) {
      return `opencode --session "${sessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  const command = initialCommand || 'claude';
  const skipPermissions = readBoolean(message.skipPermissions);
  const skipFlag = skipPermissions ? ' --dangerously-skip-permissions' : '';
  if (hasSession && sessionId) {
    if (os.platform() === 'win32') {
      return `claude${skipFlag} --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude${skipFlag} }`;
    }
    return `claude${skipFlag} --resume "${sessionId}" || claude${skipFlag}`;
  }
  return `${command}${skipFlag}`;
}

/**
 * Mutable per-connection state shared by the local and remote output pipelines.
 *
 * Holds the rolling clean-text window used for auth-URL detection and the set
 * of URLs already announced, so both pipelines emit identical `output` and
 * `auth_url` frames to the frontend.
 */
type ShellOutputContext = {
  urlDetectionBuffer: string;
  announcedAuthUrls: Set<string>;
  dependencies: ShellWebSocketDependencies;
};

/**
 * Emits the `output` (and any `auth_url`) frames for a single chunk of shell
 * output to `targetWs`, mirroring the exact frame shapes the frontend expects.
 *
 * Shared by the local node-pty path and the remote SSH-channel path so URL
 * detection and frame formatting stay in one place. Mutates
 * `context.urlDetectionBuffer`/`announcedAuthUrls` in place.
 */
function emitShellOutputChunk(
  chunk: string,
  targetWs: WebSocket,
  context: ShellOutputContext
): void {
  if (targetWs.readyState !== WebSocket.OPEN) {
    return;
  }

  const { dependencies } = context;
  let outputData = chunk;
  const cleanChunk = dependencies.stripAnsiSequences(chunk);
  context.urlDetectionBuffer =
    `${context.urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

  outputData = outputData.replace(
    /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
    '[INFO] Opening in browser: $1'
  );

  const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
    const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
    if (!normalizedUrl) {
      return;
    }

    const isNewUrl = !context.announcedAuthUrls.has(normalizedUrl);
    if (isNewUrl) {
      context.announcedAuthUrls.add(normalizedUrl);
      targetWs.send(
        JSON.stringify({
          type: 'auth_url',
          url: normalizedUrl,
          autoOpen,
        })
      );
    }
  };

  const normalizedDetectedUrls = dependencies
    .extractUrlsFromText(context.urlDetectionBuffer)
    .map((url) => dependencies.normalizeDetectedUrl(url))
    .filter((url): url is string => Boolean(url));

  const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
    (url, _, urls) => !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
  );

  dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

  if (dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) && dedupedDetectedUrls.length > 0) {
    const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
      current.length > longest.length ? current : longest
    );
    emitAuthUrl(bestUrl, true);
  }

  targetWs.send(
    JSON.stringify({
      type: 'output',
      data: outputData,
    })
  );
}

/**
 * Rejects paths containing characters that could break out of a single-quoted
 * shell argument (newlines, control chars, backticks, `$()`), then single-quotes
 * the value for safe interpolation into a remote `cd` command.
 *
 * Single-quoting neutralizes every shell metacharacter except `'` itself, which
 * we escape with the standard `'\''` close/escape/reopen idiom.
 */
function quoteRemotePathForShell(remotePath: string): string {
  // Reject control chars (incl. newline/CR/tab), backticks, and `$(`; the
  // single-quote wrapper below neutralizes every other shell metacharacter.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f`]/.test(remotePath) || remotePath.includes('$(')) {
    throw new Error('Invalid remote project path');
  }
  return `'${remotePath.replace(/'/g, `'\\''`)}'`;
}

type StartRemoteShellArgs = {
  ws: WebSocket;
  data: ShellIncomingMessage;
  projectId: string;
  projectRow: ProjectRepositoryRow;
  outputContext: ShellOutputContext;
  attach: (channel: ClientChannel, sessionKey: string) => void;
};

/**
 * Establishes (or re-attaches to) an interactive SSH shell channel for a remote
 * project and bridges it to the websocket using the same frame shapes as the
 * local node-pty path, so the frontend needs no changes.
 *
 * Reconnect state lives in `remoteShellSessionsMap` (parallel to
 * `ptySessionsMap`); the underlying transport is pooled by
 * `sshConnectionManager`. On any connect/open failure we surface a red error
 * frame (the same shape the local path's outer catch emits) and close the
 * socket.
 */
async function startRemoteShell(args: StartRemoteShellArgs): Promise<void> {
  const { ws, data, projectId, projectRow, outputContext, attach } = args;

  const remotePath = projectRow.remote_path ?? '';
  const sessionId = readString(data.sessionId) || null;
  const initialCommand = readString(data.initialCommand);
  const forceRestart = readBoolean(data.forceRestart);
  const cols = readNumber(data.cols, 80);
  const rows = readNumber(data.rows, 24);

  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  if (sessionId && !safeSessionIdPattern.test(sessionId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
    return;
  }

  const remoteSessionKey = `remote_${projectId}_${sessionId ?? 'default'}`;

  // Fast-path reconnect: re-attach to a live channel, replay its buffer, and
  // resize it to the reconnecting client (mirrors the local reconnect path).
  if (!forceRestart) {
    const existing = remoteShellSessionsMap.get(remoteSessionKey);
    if (existing) {
      if (existing.timeoutId) {
        clearTimeout(existing.timeoutId);
        existing.timeoutId = null;
      }

      ws.send(
        JSON.stringify({
          type: 'output',
          data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
        })
      );

      existing.buffer.forEach((bufferedData) => {
        ws.send(JSON.stringify({ type: 'output', data: bufferedData }));
      });

      existing.ws = ws;
      attach(existing.channel, remoteSessionKey);
      existing.channel.setWindow(rows, cols, 0, 0);
      return;
    }
  }

  // Validate/quote the remote cwd before we touch the network so a bad path
  // never reaches the channel.
  const quotedRemotePath = remotePath ? quoteRemotePathForShell(remotePath) : '';

  let channel: ClientChannel;
  try {
    const config = rowToRemoteConfig(projectRow);
    const connection = await sshConnectionManager.connect(projectId, config);
    channel = await new Promise<ClientChannel>((resolve, reject) => {
      connection.client.shell({ cols, rows, term: 'xterm-256color' }, (err, ch) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(ch);
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'output',
          data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
        })
      );
    }
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    return;
  }

  const entry: RemoteShellSessionEntry = {
    channel,
    ws,
    buffer: [],
    timeoutId: null,
    projectPath: remotePath,
    sessionId,
    projectId,
  };
  remoteShellSessionsMap.set(remoteSessionKey, entry);
  attach(channel, remoteSessionKey);

  const handleChannelChunk = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (entry.buffer.length < 5000) {
      entry.buffer.push(text);
    } else {
      entry.buffer.shift();
      entry.buffer.push(text);
    }

    if (entry.ws) {
      emitShellOutputChunk(text, entry.ws, outputContext);
    }
  };

  channel.on('data', handleChannelChunk);
  // Remote stderr is part of the interactive stream the user expects to see.
  channel.stderr.on('data', handleChannelChunk);

  channel.on('close', () => {
    if (remoteShellSessionsMap.get(remoteSessionKey) !== entry) {
      return;
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(
        JSON.stringify({
          type: 'output',
          data: '\r\n\x1b[33mRemote shell closed\x1b[0m\r\n',
        })
      );
    }
    remoteShellSessionsMap.delete(remoteSessionKey);
  });

  // Emit the banner first so it leads the session, matching the local path.
  const welcomeMsg = `\x1b[36mStarting remote terminal in: ${remotePath || '~'}\x1b[0m\r\n`;
  ws.send(JSON.stringify({ type: 'output', data: welcomeMsg }));

  // Start in the project directory by writing `cd` into the channel rather than
  // relying on a one-shot `exec`: an interactive `shell()` ignores a separate
  // exec's cwd, and writing the command keeps the user's live session (history,
  // prompt, subsequent input) anchored in the project path.
  if (quotedRemotePath) {
    channel.write(`cd ${quotedRemotePath}\n`);
  }

  // Same UX as local: run the requested command once the shell is ready.
  if (initialCommand) {
    channel.write(`${initialCommand}\n`);
  }
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let remoteChannel: ClientChannel | null = null;
  let remoteSessionKey: string | null = null;
  const outputContext: ShellOutputContext = {
    urlDetectionBuffer: '',
    announcedAuthUrls: new Set<string>(),
    dependencies,
  };

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        outputContext.urlDetectionBuffer = '';
        outputContext.announcedAuthUrls.clear();

        // Remote projects drive an interactive SSH channel instead of a local
        // node-pty. We branch here only when the project row is explicitly
        // remote; every local project keeps the exact code path below.
        const projectId = readString(data.projectId) || null;
        if (projectId) {
          const projectRow = projectsDb.getProjectById(projectId);
          if (projectRow?.project_type === 'remote') {
            await startRemoteShell({
              ws,
              data,
              projectId,
              projectRow,
              outputContext,
              attach: (channel, key) => {
                remoteChannel = channel;
                remoteSessionKey = key;
              },
            });
            return;
          }
        }

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        ptySessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        if (isLoginCommand || forceRestart) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession =
          isLoginCommand || forceRestart ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;

          // Adopt the reconnecting client's terminal size. The session's PTY
          // was sized by whichever device opened it first (e.g. a narrow
          // phone); without this, a later/wider client (e.g. a desktop)
          // reuses the old width and renders cramped, because it only sends
          // an `init` here — not a follow-up `resize` — and its container
          // size never changes to trigger the ResizeObserver. Resizing after
          // the buffer replay sends SIGWINCH so the running CLI repaints its
          // live UI at the correct width. Already-committed scrollback stays
          // wrapped at the original width (inherent to one shared PTY).
          const reconnectCols = readNumber(data.cols, shellProcess.cols);
          const reconnectRows = readNumber(data.rows, shellProcess.rows);
          if (reconnectCols !== shellProcess.cols || reconnectRows !== shellProcess.rows) {
            shellProcess.resize(reconnectCols, reconnectRows);
          }
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = buildShellCommand(data, dependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);

        shellProcess = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        });

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws) {
            emitShellOutputChunk(chunk, session.ws, outputContext);
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'gemini'
                  ? 'Gemini'
                  : provider === 'opencode'
                    ? 'OpenCode'
                  : 'Claude';
          welcomeMsg = hasSession
            ? `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (remoteChannel) {
          remoteChannel.write(readString(data.data));
        } else if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        const cols = readNumber(data.cols, 80);
        const rows = readNumber(data.rows, 24);
        if (remoteChannel) {
          // ssh2 takes (rows, cols, height, width); height/width are pixel
          // hints only and 0 lets the remote infer them from rows/cols.
          remoteChannel.setWindow(rows, cols, 0, 0);
        } else if (shellProcess) {
          shellProcess.resize(cols, rows);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    // Detach the remote SSH channel on disconnect, mirroring the local node-pty
    // grace period so a reconnecting client can re-attach to the live channel.
    if (remoteSessionKey) {
      const remoteSession = remoteShellSessionsMap.get(remoteSessionKey);
      if (remoteSession) {
        remoteSession.ws = null;
        remoteSession.timeoutId = setTimeout(() => {
          if (remoteShellSessionsMap.get(remoteSessionKey as string) !== remoteSession) {
            return;
          }

          try {
            remoteSession.channel.end();
          } catch {
            /* channel already gone */
          }
          remoteShellSessionsMap.delete(remoteSessionKey as string);
        }, PTY_SESSION_TIMEOUT);
      }
    }

    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    session.ws = null;
    session.timeoutId = setTimeout(() => {
      if (ptySessionsMap.get(ptySessionKey as string) !== session) {
        return;
      }

      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
