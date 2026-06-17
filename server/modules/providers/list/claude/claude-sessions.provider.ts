import fsp from 'node:fs/promises';
import path from 'node:path';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';
import {
  isRemoteProjectPath,
  readRemoteFileLines,
  resolveRemoteProjectByPath,
} from '@/services/remote-transcript.service.js';

const PROVIDER = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

/** Reads a local UTF-8 file and returns its lines (empty array when missing). */
async function readLocalFileLines(filePath: string): Promise<string[]> {
  const content = await fsp.readFile(filePath, 'utf8');
  return content.split('\n');
}

/**
 * Extracts the tool_use → tool_result pairs from one sub-agent transcript's
 * lines. Source-agnostic so local (fs) and remote (SSH) callers share it.
 */
function parseAgentToolsFromLines(lines: string[]): AnyRecord[] {
  const tools: AnyRecord[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as AnyRecord;

      if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const part of entry.message.content as AnyRecord[]) {
          if (part.type === 'tool_use') {
            tools.push({
              toolId: part.id,
              toolName: part.name,
              toolInput: part.input,
              timestamp: entry.timestamp,
            });
          }
        }
      }

      if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
        for (const part of entry.message.content as AnyRecord[]) {
          if (part.type !== 'tool_result') {
            continue;
          }

          const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
          if (!tool) {
            continue;
          }

          tool.toolResult = {
            content: typeof part.content === 'string'
              ? part.content
              : Array.isArray(part.content)
                ? part.content
                  .map((contentPart: AnyRecord) => contentPart?.text || '')
                  .join('\n')
                : JSON.stringify(part.content),
            isError: Boolean(part.is_error),
          };
        }
      }
    } catch {
      // Skip malformed lines that can happen during concurrent writes.
    }
  }

  return tools;
}

/**
 * Assembles a session's history from the main transcript lines, lazily pulling
 * each referenced sub-agent's tools through `resolveAgentTools`. Identical for
 * local and remote sources — only how the lines/agent files are fetched differs.
 */
async function assembleSessionMessages(
  sessionId: string,
  limit: number | null,
  offset: number,
  mainLines: string[],
  resolveAgentTools: (agentId: string) => Promise<AnyRecord[] | null>,
): Promise<ClaudeHistoryMessagesResult> {
  const messages: AnyRecord[] = [];
  for (const line of mainLines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as AnyRecord;
      if (entry.sessionId === sessionId) {
        messages.push(entry);
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  const agentIds = new Set<string>();
  for (const message of messages) {
    const agentId = message.toolUseResult?.agentId;
    if (agentId) {
      agentIds.add(String(agentId));
    }
  }

  const agentToolsCache = new Map<string, AnyRecord[]>();
  for (const agentId of agentIds) {
    const tools = await resolveAgentTools(agentId);
    if (tools && tools.length > 0) {
      agentToolsCache.set(agentId, tools);
    }
  }

  for (const message of messages) {
    const agentId = message.toolUseResult?.agentId;
    if (!agentId) {
      continue;
    }

    const agentTools = agentToolsCache.get(String(agentId));
    if (agentTools && agentTools.length > 0) {
      message.subagentTools = agentTools;
    }
  }

  const sortedMessages = messages.sort(
    (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
  );
  const total = sortedMessages.length;

  if (limit === null) {
    return sortedMessages;
  }

  const startIndex = Math.max(0, total - offset - limit);
  const endIndex = total - offset;
  const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
  const hasMore = startIndex > 0;

  return {
    messages: paginatedMessages,
    total,
    hasMore,
    offset,
    limit,
  };
}

/** Loads history for a local session by reading the on-disk transcript. */
async function getLocalSessionMessages(
  jsonLPath: string,
  sessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  const projectDir = path.dirname(jsonLPath);
  const files = await fsp.readdir(projectDir);
  const agentFiles = new Set(
    files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-')),
  );

  const mainLines = await readLocalFileLines(jsonLPath);

  return assembleSessionMessages(sessionId, limit, offset, mainLines, async (agentId) => {
    const agentFileName = `agent-${agentId}.jsonl`;
    if (!agentFiles.has(agentFileName)) {
      return null;
    }
    const lines = await readLocalFileLines(path.join(projectDir, agentFileName));
    return parseAgentToolsFromLines(lines);
  });
}

/**
 * Loads history for a remote session by reading the transcript (and any
 * referenced sub-agent transcripts) over the project's pooled SSH connection.
 */
async function getRemoteSessionMessages(
  project: NonNullable<ReturnType<typeof resolveRemoteProjectByPath>>,
  jsonLPath: string,
  sessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  const remoteDir = path.posix.dirname(jsonLPath);
  const mainLines = await readRemoteFileLines(project, jsonLPath);

  return assembleSessionMessages(sessionId, limit, offset, mainLines, async (agentId) => {
    const agentFileName = `agent-${agentId}.jsonl`;
    // `agentId` originates from transcript content; restrict to a safe charset
    // before it is composed into a remote path read over SSH.
    if (!/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(agentFileName)) {
      return null;
    }
    const lines = await readRemoteFileLines(project, path.posix.join(remoteDir, agentFileName));
    return parseAgentToolsFromLines(lines);
  });
}

async function getSessionMessages(
  sessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonLPath = session?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const remoteProject = isRemoteProjectPath(session?.project_path)
      ? resolveRemoteProjectByPath(session!.project_path as string)
      : null;

    if (remoteProject) {
      return await getRemoteSessionMessages(remoteProject, jsonLPath, sessionId, limit, offset);
    }

    return await getLocalSessionMessages(jsonLPath, sessionId, limit, offset);
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (text && !isInternalContent(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
              }));
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
            }));
          }
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        if (text && !isInternalContent(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    const totalNormalized = normalized.length;
    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const messages = normalizedLimit === null
      ? normalized
      : normalized.slice(
          Math.max(0, totalNormalized - normalizedOffset - normalizedLimit),
          Math.max(0, totalNormalized - normalizedOffset),
        );
    const hasMore = normalizedLimit === null
      ? false
      : Math.max(0, totalNormalized - normalizedOffset - normalizedLimit) > 0;

    return {
      messages,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
