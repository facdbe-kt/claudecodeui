# Remote SSH Projects

Remote SSH projects let you work on a folder that lives on **another machine** —
a dev box, a build server, a cloud VM — directly from the Claude Code UI, over a
single SSH connection. The project's files never have to be checked out locally:
the server connects to the remote host on your behalf and proxies file access,
the terminal, and Claude chat through that connection.

A project is either **local** (a folder on the machine running the server, the
classic behaviour) or **remote** (`project_type = "remote"`, a folder on a host
reached over SSH). Everything below applies only to remote projects; local
projects are unchanged.

## What works remotely

| Feature | Remote behaviour |
| --- | --- |
| **File browser / tree** | Built from a single remote `find` call. Browse the project tree just like a local project. |
| **File editor (read / write / stat)** | Reads and writes go over SFTP on the pooled connection. Saving a file writes it on the remote host. |
| **Terminal** | A real PTY on the remote host. The AI CLI runs as a clean foreground process in the remote login shell. |
| **Claude chat** | `claude` runs **on the remote host** and streams back into the same chat UI. Sessions, resume, abort, and token budget all work. |

All remote operations stay confined to the project's configured **remote path**
(paths are validated so they cannot escape it).

## Prerequisites

On the **server** (the machine running Claude Code UI):

- Network reachability and SSH access to the remote host.
- For `agent` auth: a running SSH agent (`SSH_AUTH_SOCK`) and/or a default key in
  the server's `~/.ssh` (`id_rsa`, `id_ed25519`, or `id_ecdsa`).
- `ENCRYPTION_MASTER_KEY` set in production (see below) so stored credentials
  survive restarts.

On the **remote host**:

- An SSH server you can log into with the chosen credentials.
- **For the file tree:** GNU `find` (GNU findutils). The tree is built with a
  single `find ... -printf ...` call. The BSD `find` shipped on macOS does **not**
  support `-printf`, so on a macOS remote host install `findutils`
  (`brew install findutils`) or the tree will come back empty.
- **For remote terminal and remote Claude chat:** the `claude` CLI must be
  **installed AND already logged in**, and it must be resolvable from your
  **interactive login shell**. The server runs the CLI via
  `bash -ic "cd <path> && claude ..."`. The `-i` (interactive) flag is required:
  it loads `~/.bashrc` so your `PATH` (e.g. `nvm`) and Claude auth environment
  load exactly as they do in a normal `ssh` session. A non-interactive shell can
  resolve the wrong binary or fail auth (typically a 403).

  Quick check — SSH in by hand and confirm both of these work:

  ```bash
  ssh user@remote-host
  which claude          # should print a path
  claude -p --output-format stream-json --verbose <<< "hello"   # should stream JSON, not 403
  ```

## Adding a remote project

1. Open the project list and click **New Project** to open the project wizard.
2. At the top, switch the toggle from **New Project** to **Add Remote Project**
   (the one with the server icon).
3. Fill in the connection fields:
   - **Project name** (optional display name)
   - **Host** — hostname or IP (e.g. `10.77.110.165`)
   - **Port** — defaults to `22`
   - **User** — the SSH username (e.g. `zyx`)
   - **Authentication Type** — one of the three modes below
   - **Remote Path** — the project folder on the remote host
4. Click **Test Connection** to verify the host, credentials, and path.
   A green "Connection successful" confirms it. Nothing is saved yet — the test
   uses a throwaway credential.
5. Optionally click **Browse** next to Remote Path to open the remote folder
   browser and pick the folder over SSH instead of typing the path.
6. Click **Save**. The credential is encrypted and stored, the connection is
   tested once more, and the remote project is created. It appears in the sidebar
   with a server icon and a live connection-status indicator.

> If you click **Save** without having tested first, the form runs the
> connection test inline and only creates the project if it succeeds.

### The three authentication modes

#### SSH Key (paste a private key)

Choose **SSH Key** and paste a private key (PEM/OpenSSH, starting with
`-----BEGIN OPENSSH PRIVATE KEY-----`) into the text box. The key is encrypted
at rest (AES-256-GCM) and used to authenticate to the host.

Use this when you have a dedicated key for this host and want the server to
authenticate with it regardless of any agent running on the server.

#### Password

Choose **Password** and enter the SSH login password. It is encrypted at rest
the same way and used for password authentication.

Use this when the host only allows password auth. (Key-based auth is generally
preferable.)

#### Use local SSH key / agent (no stored credential)

Choose **Use local SSH key / agent**. No credential field appears and **nothing
is stored** for this project. Instead, when the server connects, it authenticates
using:

- the server's **SSH agent** (`SSH_AUTH_SOCK`), if one is running, and/or
- the first **default key** found in the server's `~/.ssh`
  (`id_rsa`, then `id_ed25519`, then `id_ecdsa`).

Use this when the machine running Claude Code UI already has working SSH access
to the remote host (your normal `ssh user@host` works from that machine). It is
the simplest and most secure option because no secret is ever stored in the app —
and it is **unaffected by `ENCRYPTION_MASTER_KEY`** (there is nothing to encrypt).

If no agent and no default key are available on the server, agent auth fails with
"No local SSH agent or default key found for agent auth."

## ENCRYPTION_MASTER_KEY

Stored credentials (the **SSH Key** and **Password** modes) are encrypted at rest
with AES-256-GCM. The encryption key is derived from the `ENCRYPTION_MASTER_KEY`
environment variable.

**If `ENCRYPTION_MASTER_KEY` is not set**, the server generates a random
**ephemeral** key at startup (and logs a warning). Encryption still works while
the process runs, but the key is lost on restart — so previously stored
key/password credentials can no longer be decrypted and those remote projects
will fail to connect until you re-enter the credential.

`agent` mode stores no credential, so it is **not affected** by this setting.

**In production, always set `ENCRYPTION_MASTER_KEY`** to a stable, secret value.
Add it to your `.env`:

```bash
# .env
# Stable secret used to encrypt stored SSH credentials at rest (AES-256-GCM).
# Any sufficiently long random string works; it is normalised to a 32-byte key.
# Keep it secret and stable — changing it makes existing stored credentials
# undecryptable.
ENCRYPTION_MASTER_KEY=replace-with-a-long-random-secret
```

Generate a strong value, for example:

```bash
openssl rand -hex 32
```

## Troubleshooting / FAQ

### Connection fails when testing or saving

The error message tells you which class of failure it is:

- **"Authentication failed: check the username and credential."** — wrong user,
  wrong key/password, or (for agent mode) the server's agent/key isn't authorized
  on the host. Authentication failures are **not** retried.
- **"Connection timed out: the host did not respond in time."** — host is up but
  slow/filtered, or the wrong port. Transient failures are retried a few times
  automatically.
- **"Connection refused: nothing is listening on that host and port."** — wrong
  port, or sshd isn't running.
- **"Host not found: check the hostname."** — DNS/typo in the host field.
- **"Host unreachable: the network connection to the host failed."** — network/route
  problem between server and host.

### "claude works in my terminal but not in the app"

This is almost always a **login-environment** difference. The app runs
`bash -ic "cd <path> && claude ..."`; if `claude` isn't on the `PATH` of your
**interactive** shell (for example it's only added by a login-only profile, or by
something `ssh`'s non-login session skips), it won't be found.

Fix it by making sure `claude` is resolvable from `~/.bashrc` (interactive
shells). Verify with:

```bash
ssh user@remote-host
bash -ic 'which claude'   # must print claude's path
```

If `which claude` is empty here, add its directory (or the `nvm` init) to
`~/.bashrc` so interactive shells pick it up.

### Remote Claude returns 403 / "not authenticated"

`claude` is installed but not logged in on the remote host (or it's running under
a different env than your login shell). SSH into the host and authenticate the CLI
there as the same user, then confirm:

```bash
ssh user@remote-host
claude -p --output-format stream-json --verbose <<< "ping"   # should stream JSON
```

Once that works over a plain interactive SSH session, remote chat will work in the
app.

### The file tree is empty

The remote file tree needs **GNU `find`** (`-printf` support). Hosts shipping only
BSD `find` (notably macOS) produce no tree. Install GNU findutils on the remote
host (`brew install findutils` on macOS; it's already present on most Linux
distros) and reopen the project.

### Generating / authorizing an SSH key

If you don't have a key yet, create one and copy the **public** half to the host:

```bash
# On the server (or wherever you keep the key)
ssh-keygen -t ed25519 -C "claudecodeui-remote"

# Authorize it on the remote host
ssh-copy-id user@remote-host
# or append ~/.ssh/id_ed25519.pub to the host's ~/.ssh/authorized_keys
```

Then either paste the **private** key (`~/.ssh/id_ed25519`) into **SSH Key** mode,
or — if the key lives in the server's `~/.ssh` or agent — just use
**Use local SSH key / agent** mode and store nothing.

## Security notes

- **Credentials encrypted at rest.** Stored SSH keys and passwords are encrypted
  with AES-256-GCM (versioned `v1:` payload, GCM auth tag) using a key derived
  from `ENCRYPTION_MASTER_KEY`. Secrets are never returned to the client and are
  decrypted only at connect time.
- **Per-user ownership.** Remote projects and their credentials are scoped to the
  owning user; the API enforces ownership before any credential or project
  operation.
- **Host-key trust-on-first-use.** On the first connection the host key
  fingerprint is captured and logged, then accepted (record-only). There is no
  strict pinning yet, so verify you are connecting to the host you expect.
- **Single-hop SSH only.** Connections are a direct SSH session to the host. There
  is no built-in jump-host / `ProxyJump` chaining; if you need a bastion, terminate
  it at the network layer (e.g. a tunnel the server can reach).
- **`agent` mode stores no secret at all** and is the most secure choice when the
  server already has SSH access to the host.

## See also

- `examples/remote-project-config.example.json` — a representative remote project
  configuration for each auth mode, with field notes.
