# Remote SSH Projects — Architecture

This document describes the layered design that lets a CloudCLI UI project live on a
**remote host over SSH** instead of the local machine. A project is now either
`local` (the historical, unchanged behaviour) or `remote`. Remote projects expose the
same file tree, editor, terminal, and Claude chat as local ones, but every file and
process operation is executed on the remote host.

The feature is **backward compatible**: existing projects default to `local` and keep
hitting the exact same code paths they did before. The local-vs-remote decision is made
at a small number of well-defined seams (listed at the end).

---

## 1. Data model (schema + migration)

Remote connection metadata lives on the existing `projects` table as nullable columns —
no new project table. Defined in `server/modules/database/schema.ts` and added to
existing databases by `server/modules/database/migrations.ts`
(`addColumnToTableIfNotExists`, idempotent):

| Column | Type / default | Meaning |
|---|---|---|
| `project_type` | `TEXT DEFAULT 'local'` | `'local'` or `'remote'` |
| `remote_host` | `TEXT DEFAULT NULL` | SSH host |
| `remote_port` | `INTEGER DEFAULT NULL` | SSH port (default 22) |
| `remote_user` | `TEXT DEFAULT NULL` | SSH username |
| `remote_path` | `TEXT DEFAULT NULL` | project root on the remote host |
| `remote_auth_type` | `TEXT DEFAULT NULL` | `'key'` \| `'password'` \| `'agent'` |
| `remote_credential_ref` | `TEXT DEFAULT NULL` | id of the encrypted credential (null for `agent`) |

A partial index `idx_projects_type` on `project_type` is created for cheap filtering.
Because every new column has a default and the migration only adds missing columns,
old rows automatically read back as `project_type = 'local'` with null remote fields.

Credentials are **not** a new table either: they are stored in `user_credentials`
(`server/modules/database/repositories/credentials.ts`) with `credential_type` of
`ssh_key` or `ssh_password`. `remote_credential_ref` holds that row's id. `agent`-auth
projects store no credential at all.

The row→config mapping is centralised in `server/shared/remote-project.js`
(`rowToRemoteConfig`) so the column names are read in exactly one place.

---

## 2. Credential encryption

`server/services/credentials-encryption.service.ts` encrypts secrets (private keys,
passwords) at rest with **AES-256-GCM**.

- Ciphertext is a self-contained, versioned string: `"v1:" + base64(iv | authTag | ciphertext)`.
  The 96-bit IV is random per call; the 128-bit GCM auth tag lets `decryptCredential`
  detect tampering or a wrong key and throw a clear error.
- The 256-bit key is derived (via `scryptSync` with a fixed non-secret salt) from the
  **`ENCRYPTION_MASTER_KEY`** environment variable.
- **If `ENCRYPTION_MASTER_KEY` is unset, an ephemeral random key is generated at startup
  with a loud warning.** Development works, but credentials encrypted under that key do
  **not** survive a restart. `ENCRYPTION_MASTER_KEY` MUST be set in production for
  credentials to persist.

`credentialsDb.createRemoteCredential` encrypts on write; `getRemoteCredential` (server
internal only) decrypts on read. API-facing callers use `getRemoteCredentialMeta`, which
never returns the secret. The decrypted secret is used only during the SSH handshake and
is never logged or stored on the connection wrapper.

---

## 3. SSH connection pool

`server/services/ssh-connection-manager.service.ts` is a process-wide singleton
(`sshConnectionManager`) that pools one live `ssh2` connection **per project**, reused
across shell, file-tree, file read/write, and Claude operations.

- **Pooling / lifecycle**: keyed by `projectId`; max 50 connections; SSH keepalive every
  30s; idle connections auto-disconnect after 15 min (idle timer is `unref`'d so it never
  keeps the process alive). It extends `EventEmitter` and emits a typed `status` event
  (`connecting` | `connected` | `disconnected` | `error`) on every transition.
- **Retry**: transient/network failures (timeout, ECONNREFUSED, ENOTFOUND, host
  unreachable) retry up to 3 times; **authentication failures fail fast** (never retried)
  with a clear, credential-free message. `classifyError` maps raw ssh2/socket errors to
  user-safe text.
- **Auth modes** (`buildConnectConfig`):
  - `key` — decrypts the referenced credential and uses it as `privateKey`.
  - `password` — decrypts the referenced credential and uses it as `password`.
  - `agent` — **no stored credential**. Uses the server's SSH agent (`SSH_AUTH_SOCK`)
    and/or the first default key found in the server's `~/.ssh` (`id_rsa`, `id_ed25519`,
    `id_ecdsa`). Throws if neither is available.
- **Host key policy**: trust-on-first-use, **record-only** for now. `hostVerifier`
  captures and logs the SHA256 fingerprint, then accepts unconditionally. The verifier is
  structured so strict mode later only needs to compare against a stored fingerprint and
  call `verify(false)` on mismatch.
- **Surface**:
  - `connect` / `disconnect` / `getConnection`
  - `execCommand(projectId, cmd, config?)` — one-off command, buffers stdout/stderr/exit
    code. Used by remote search, the file tree (`find`), and folder browse.
  - `execStream(projectId, cmd, handlers, config?)` — streams output **line by line** and
    returns a handle (`write` to remote stdin, `end` to close stdin, `kill` for SIGINT +
    channel close). Used by remote Claude.
  - `testConnection(config)` — connects on a throwaway id, runs `true`, disconnects, and
    returns `{ ok, error? }` without throwing (powers the "Test connection" UI).

---

## 4. File-system adapter — "exec-first, not N SFTP round-trips"

`server/services/file-system-adapter.service.ts` exposes one uniform interface
(`IFileSystemAdapter`: `readTree`, `readFile`, `writeFile`, `mkdir`, `stat`, `exists`)
with two implementations. `getFileSystemAdapter(projectId)` returns the local one for
`project_type !== 'remote'` and the remote one otherwise.

- **`LocalFileSystemAdapter`** delegates to `fs.promises`. `readTree` re-implements the
  exact `getFileTree` logic from `server/index.js` (same node shape, same `IGNORED_DIRS`,
  same dir-first sort) so local output is byte-for-byte unchanged.
- **`RemoteFileSystemAdapter`** is backed by the pooled SSH connection and **lazy-connects**
  (a file read can be the first operation, before any terminal opened a connection):
  - **File tree via a SINGLE `find` exec** — the load-bearing optimisation. Instead of N
    SFTP `readdir`+`stat` round-trips per directory (slow on high-latency links, and the
    test hosts ship only coreutils — no node/rg), the whole subtree is fetched in **one**
    `find <root> -mindepth 1 -maxdepth N -printf '<fmt>'` call. The GNU findutils `-printf`
    format emits `%y\0%m\0%s\0%T@\0%p\0\0` (type, octal mode, size, mtime epoch, path),
    NUL-delimited so any byte except NUL survives parsing. The flat stream is reassembled
    into the **same nested `FileEntry` tree** the local adapter produces (indexed by path,
    children linked in a second pass, ignored dirs/hidden files filtered, every level
    sorted). This requires **GNU `find` (`-printf`)** on the remote host.
  - **read / write / stat / exists / mkdir via SFTP.** A fresh SFTP session is opened over
    the pooled connection. SFTP status codes are mapped to Node-style `ENOENT` / `EACCES`
    errors so callers branch identically to local fs. `mkdir({recursive})` walks ancestors
    (SFTP mkdir is non-recursive).
  - **Path safety**: every path is single-quoted before exec and additionally rejected if
    it contains control chars or shell metacharacters (`` ` ``, `$(`, `'`).

---

## 5. Remote terminal (`bash -ic`, foreground exec) — and why

`server/modules/websocket/services/shell-websocket.service.ts` keeps the local `node-pty`
path entirely unchanged and adds a **parallel** remote SSH-channel path
(`remoteShellSessionsMap`, separate from `ptySessionsMap`). For a remote project it opens
an interactive SSH channel with a PTY and runs:

```
bash -ic '<cd into remote_path && exec the CLI/shell as foreground>'
```

The AI CLI (or login shell) runs as a **clean foreground process**, the same way the local
`node-pty` path execs it directly — not nested under an interactive prompt — so the
frontend needs no changes.

**Why `bash -ic` (interactive) is required:** the remote login environment (PATH with
nvm, plus the CLI's auth/login env) is configured in `~/.bashrc`, which only loads for an
**interactive** shell. A non-interactive shell (or `bash -lc`) resolves the wrong binary
and/or fails CLI authentication (e.g. a 403). The remote cwd is validated and quoted
before it is interpolated into the `cd`.

---

## 6. Remote Claude chat (stream-json over SSH, reusing the local normalizer)

`server/services/remote-claude.service.ts` (`queryClaudeRemote`) mirrors the in-process
SDK path (`queryClaudeSDK`) but runs the Claude CLI **on the remote host** over SSH:

```
bash -ic "cd '<remote_path>' && claude -p --output-format stream-json --verbose [--resume <id>]"
```

- `bash -ic` for the same login-env reason as the terminal (`bash -lc` yields a 403).
- The user prompt is written to the remote process **stdin** (claude `-p` reads stdin when
  no prompt arg is given), **never** interpolated into the shell string — so arbitrary chat
  text cannot inject shell. The cwd is validated/quoted and `--resume <id>` is charset-restricted.
- Output is streamed line-by-line via `sshConnectionManager.execStream`. STDOUT is clean
  JSONL (one event per line); `bash -ic`'s harmless job-control warnings go to STDERR and
  are ignored for parsing.
- **Each parsed event is fed through the SAME `sessionsService.normalizeMessage('claude', …)`
  the local SDK path uses**, and the service emits the same `session_created` / `complete` /
  `error` / `token_budget` frames `queryClaudeSDK` sends. The frontend renders remote output
  with **zero rendering changes**.
- Active runs are tracked for abort (by session id, plus a pending-by-project map for the
  first turn before the id is known); `abortClaudeRemoteSession` does SIGINT + channel close.

---

## 7. HTTP API

`server/routes/remote-projects.js` (auth-required, per-user ownership enforced):

| Method & path | Purpose |
|---|---|
| `POST /api/remote-projects/test` | Probe a connection with a throwaway credential; stores nothing. |
| `POST /api/remote-projects/browse` | List one directory level (`ls -1Ap`) on a remote host before the project exists. |
| `POST /api/remote-projects` | Create: store credential → test → insert the `remote` row. Rolls back the credential on failure. |
| `PUT /api/remote-projects/:id` | Update host/port/user/path (and optionally re-encrypt the credential), re-test, drop the stale pooled connection. |
| `DELETE /api/remote-projects/:id` | Disconnect, delete the row, delete the credential when no other project references it. |
| `GET /api/remote-projects/:id/status` | Current pooled SSH status. |
| `POST /api/remote-projects/:id/reconnect` | Drop and re-establish the pooled connection. |

Secrets are never returned (`toPublicProject` omits the credential ref). `agent` projects
skip the credential-ownership check since they store none. Ephemeral test/browse
credentials and connections are always cleaned up in `finally`.

---

## 8. Frontend

`src/components/project-creation-wizard/`:

- `ProjectCreationWizard.tsx` — a "New / Add Remote Project" toggle.
- `components/RemoteProjectForm.tsx` — host / port / user / path, auth mode
  (`key` | `password` | `agent`), and a **Test Connection** action.
- `components/RemoteFolderBrowserModal.tsx` — browse and pick a remote folder over SSH
  (drives `POST /browse`).
- The sidebar shows a Server icon plus live connection status for remote projects.
- The terminal and chat send `projectId` so the server's remote branches activate.
- API client namespace: `api.remoteProjects.*` (`src/utils/api.js`).
- i18n strings live under `remoteProject.*` in every locale.

---

## 9. Local vs. remote data flow

**Open the file tree**
- Local: `GET /api/projects/:id/files` → `LocalFileSystemAdapter.readTree` → recursive
  `fs.promises` walk.
- Remote: same endpoint → `RemoteFileSystemAdapter.readTree` → **one** `find -printf` exec
  over the pooled SSH connection → flat NUL-delimited stream parsed into the same nested tree.

**Edit (read/save) a file**
- Local: file read/write endpoints → `LocalFileSystemAdapter.readFile`/`writeFile` → `fs.promises`.
- Remote: same endpoints, after `validateRemotePathInProject` confirms the path stays under
  `remote_path` → `RemoteFileSystemAdapter` → SFTP `readFile`/`writeFile` (lazy-connecting if
  no pooled connection exists yet).

**Open a terminal**
- Local: shell WebSocket spawns a `node-pty` process (`ptySessionsMap`).
- Remote: shell WebSocket opens an SSH PTY channel and runs `bash -ic '<cd && exec shell/CLI>'`
  as a foreground process (`remoteShellSessionsMap`); transport pooled by `sshConnectionManager`.

**Send a Claude chat message**
- Local: chat WebSocket `claude-command` → `queryClaudeSDK` (in-process SDK) → normalizer → UI.
- Remote: chat WebSocket detects `options.projectId` maps to a `remote` row → `queryClaudeRemote`
  → `bash -ic "cd … && claude -p --output-format stream-json …"` over SSH (prompt via stdin) →
  JSONL parsed → **same** `normalizeMessage('claude', …)` → UI.

---

## 10. Seams where local vs. remote branch

These are the only places the code decides local vs. remote:

1. **File APIs in `server/index.js`** — the per-project file endpoints branch on
   `projectRow.project_type === 'remote'`, call `validateRemotePathInProject`, and obtain an
   adapter via `getFileSystemAdapter(projectId)`. (`getFileSystemAdapter` itself also branches
   on `project_type`.)
2. **Shell-websocket init** — `server/modules/websocket/services/shell-websocket.service.ts`
   branches when `projectRow?.project_type === 'remote'` to the SSH-channel path instead of
   `node-pty`.
3. **Chat-websocket `claude-command`** — `server/modules/websocket/services/chat-websocket.service.ts`
   (`isRemoteProject(options)` → row `project_type === 'remote'`) routes to `queryClaudeRemote`
   (and `abortClaudeRemoteSession`) instead of the local SDK path.

The shared row→config mapping (`server/shared/remote-project.js`) and the connection pool /
adapters keep the rest of the system provider-agnostic.

---

## 11. Extension points

- **Strict host-key verification** — `hostVerifier` in `ssh-connection-manager.service.ts`
  already captures the fingerprint; store it and reject on mismatch to upgrade from TOFU
  record-only to strict.
- **More auth providers / methods** — `buildConnectConfig` is the single place that turns a
  `RemoteProjectConfig` into an ssh2 `ConnectConfig`; add new auth types there and to the
  route validation set.
- **Multi-hop / jump host (ProxyJump)** — would be added in `buildConnectConfig`/`openClient`
  by chaining ssh2 connections; not currently supported.
- **Other remote AI CLIs** — `queryClaudeRemote` is Claude-specific but the `execStream` +
  normalizer pattern generalises to any CLI that emits stream-json.

---

## 12. Current limitations / gotchas

- **`ENCRYPTION_MASTER_KEY` must be set in production**, or encrypted credentials do not
  survive a restart (an ephemeral key is generated otherwise).
- The remote host needs **`claude` installed AND authenticated** in the interactive login
  env for remote chat/terminal to work (`bash -ic` loads that env; `bash -lc` does not).
- The remote file tree needs **GNU `find` with `-printf`** (GNU findutils). BSD/macOS `find`
  does not support `-printf`.
- **Host-key verification is trust-on-first-use, record-only** (no mismatch rejection yet).
- **No multi-hop / jump-host** support.
- One pooled connection per project; connections idle out after 15 minutes and reconnect on
  next use.
- The reference remote host validated during development was `zyx@10.77.110.165`.
