/**
 * Remote-projects HTTP API.
 *
 * Manages `project_type = 'remote'` projects: testing/browsing a remote host
 * before a project exists, creating/updating/deleting remote project rows, and
 * reporting/refreshing live SSH connection status.
 *
 * Secrets are never returned to the client. Every credential is stored
 * encrypted at rest via credentialsDb, and ownership is enforced here (the
 * Phase-1 remote-credential getters are NOT user-scoped) before any credential
 * or project operation runs.
 */

import express from 'express';
import { randomUUID } from 'crypto';

import { authenticateToken } from '../middleware/auth.js';
import { credentialsDb, projectsDb } from '../modules/database/index.js';
import { sshConnectionManager } from '../services/ssh-connection-manager.service.js';
import { rowToRemoteConfig } from '../shared/remote-project.js';

const router = express.Router();

const VALID_AUTH_TYPES = new Set(['key', 'password', 'agent']);

/**
 * Rejects shell-unsafe paths. The value is later single-quoted before being
 * passed to execCommand, but we still refuse newlines/control chars and shell
 * metacharacters (backticks, $(), single quotes) defensively so a malicious
 * path can never break out of the quoting.
 */
function isShellSafePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Reject control characters (incl. newlines) and NUL.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.includes('`') || value.includes('$(') || value.includes("'")) return false;
  return true;
}

/** Single-quotes a value for safe POSIX shell interpolation. */
function shellQuote(value) {
  return `'${value}'`;
}

/**
 * Validates and normalizes the SSH connection fields shared by /test, /browse,
 * and / (create). Returns { config } on success or { error } on failure, where
 * `config` is a RemoteProjectConfig-shaped object WITHOUT a credentialRef (the
 * caller fills that in after creating the credential).
 */
function parseConnectionFields({ host, port, user, authType }) {
  if (typeof host !== 'string' || host.trim().length === 0) {
    return { error: 'remote_host is required.' };
  }
  if (typeof user !== 'string' || user.trim().length === 0) {
    return { error: 'remote_user is required.' };
  }

  let normalizedPort = 22;
  if (port !== undefined && port !== null && port !== '') {
    normalizedPort = Number(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      return { error: 'remote_port must be an integer between 1 and 65535.' };
    }
  }

  if (!VALID_AUTH_TYPES.has(authType)) {
    return { error: "remote_auth_type must be 'key', 'password', or 'agent'." };
  }

  return {
    config: {
      host: host.trim(),
      port: normalizedPort,
      user: user.trim(),
      authType,
    },
  };
}

/**
 * Verifies that the given credential id exists and belongs to `userId`. Returns
 * the numeric credential id on success, or null when missing / not owned.
 */
function assertCredentialOwnership(credentialRef, userId) {
  const credentialId = Number(credentialRef);
  if (!Number.isInteger(credentialId)) return null;
  const ownerId = credentialsDb.getRemoteCredentialUserId(credentialId);
  if (ownerId === null || ownerId !== userId) return null;
  return credentialId;
}

/**
 * Loads a remote project by id, ensuring it exists and is type remote.
 * Additionally enforces that the project's credential belongs to `userId`.
 * Returns { row, config } or { status, error }.
 */
function loadOwnedRemoteProject(projectId, userId) {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    return { status: 404, error: 'Project not found.' };
  }
  if (row.project_type !== 'remote') {
    return { status: 404, error: 'Project is not a remote project.' };
  }
  // 'agent' projects store no credential, so there is nothing to own-check.
  if (row.remote_auth_type === 'agent') {
    return { row, config: rowToRemoteConfig(row), credentialId: null };
  }
  const credentialId = assertCredentialOwnership(row.remote_credential_ref, userId);
  if (credentialId === null) {
    return { status: 404, error: 'Project not found.' };
  }
  return { row, config: rowToRemoteConfig(row), credentialId };
}

/**
 * POST /test
 * Probes an SSH connection using a throwaway credential. Stores nothing
 * permanent. Returns { ok, error? }.
 */
router.post('/test', async (req, res) => {
  const { remote_host, remote_port, remote_user, remote_auth_type, credential } = req.body || {};

  const parsed = parseConnectionFields({
    host: remote_host,
    port: remote_port,
    user: remote_user,
    authType: remote_auth_type,
  });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  // 'agent' auth uses the server's own SSH agent / default keys: no credential.
  if (remote_auth_type === 'agent') {
    try {
      const result = await sshConnectionManager.testConnection({
        ...parsed.config,
        path: '',
        credentialRef: null,
      });
      return res.json(result);
    } catch (error) {
      console.error('Error testing remote connection:', error);
      return res.status(500).json({ error: 'Failed to test connection.' });
    }
  }

  if (typeof credential !== 'string' || credential.length === 0) {
    return res.status(400).json({ error: 'credential is required.' });
  }

  let tempCredentialId = null;
  try {
    const created = credentialsDb.createRemoteCredential(
      req.user.id,
      `__test__:${randomUUID()}`,
      remote_auth_type === 'key' ? 'ssh_key' : 'ssh_password',
      credential
    );
    tempCredentialId = Number(created.id);

    const result = await sshConnectionManager.testConnection({
      ...parsed.config,
      path: '',
      credentialRef: String(tempCredentialId),
    });

    return res.json(result);
  } catch (error) {
    console.error('Error testing remote connection:', error);
    return res.status(500).json({ error: 'Failed to test connection.' });
  } finally {
    if (tempCredentialId !== null) {
      try {
        credentialsDb.deleteRemoteCredential(tempCredentialId);
      } catch (cleanupError) {
        console.error('Error cleaning up temp credential:', cleanupError);
      }
    }
  }
});

/**
 * POST /browse
 * Lists one directory level on a remote host using a throwaway credential, so
 * the create-project UI can pick a folder before the project exists. Returns
 * { path, entries }.
 */
router.post('/browse', async (req, res) => {
  const { host, port, user, authType, credential, browsePath } = req.body || {};

  const parsed = parseConnectionFields({ host, port, user, authType });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const isAgent = authType === 'agent';
  if (!isAgent && (typeof credential !== 'string' || credential.length === 0)) {
    return res.status(400).json({ error: 'credential is required.' });
  }

  const targetPath =
    typeof browsePath === 'string' && browsePath.trim().length > 0 ? browsePath.trim() : '.';
  if (!isShellSafePath(targetPath)) {
    return res.status(400).json({ error: 'browsePath contains invalid characters.' });
  }

  let tempCredentialId = null;
  const ephemeralProjectId = `__browse__:${randomUUID()}`;
  try {
    // 'agent' auth stores no credential: the server authenticates with its own
    // SSH agent / default keys.
    if (!isAgent) {
      const created = credentialsDb.createRemoteCredential(
        req.user.id,
        `__browse__:${randomUUID()}`,
        authType === 'key' ? 'ssh_key' : 'ssh_password',
        credential
      );
      tempCredentialId = Number(created.id);
    }

    const config = {
      ...parsed.config,
      path: targetPath,
      credentialRef: tempCredentialId !== null ? String(tempCredentialId) : null,
    };

    // List one level: trailing slash on names marks directories (ls -p), and -A
    // includes dotfiles while skipping . and .. — all coreutils-only.
    const command = `ls -1Ap ${shellQuote(targetPath)}`;
    const result = await sshConnectionManager.execCommand(ephemeralProjectId, command, config);

    if (result.code !== 0) {
      const message = result.stderr.trim() || 'Failed to list remote directory.';
      return res.status(400).json({ error: message });
    }

    const entries = result.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0 && line !== './' && line !== '../')
      .map((line) => {
        const isDirectory = line.endsWith('/');
        return { name: isDirectory ? line.slice(0, -1) : line, isDirectory };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return res.json({ path: targetPath, entries });
  } catch (error) {
    console.error('Error browsing remote directory:', error);
    return res.status(500).json({ error: 'Failed to browse remote directory.' });
  } finally {
    try {
      await sshConnectionManager.disconnect(ephemeralProjectId);
    } catch (disconnectError) {
      console.error('Error disconnecting ephemeral browse connection:', disconnectError);
    }
    if (tempCredentialId !== null) {
      try {
        credentialsDb.deleteRemoteCredential(tempCredentialId);
      } catch (cleanupError) {
        console.error('Error cleaning up temp credential:', cleanupError);
      }
    }
  }
});

/**
 * POST /
 * Creates a remote project: stores the credential, tests the connection, and on
 * success inserts a `project_type = 'remote'` row. On test failure the
 * credential is removed and the error returned.
 */
router.post('/', async (req, res) => {
  const {
    customProjectName,
    remote_host,
    remote_port,
    remote_user,
    remote_path,
    remote_auth_type,
    credential,
  } = req.body || {};

  const parsed = parseConnectionFields({
    host: remote_host,
    port: remote_port,
    user: remote_user,
    authType: remote_auth_type,
  });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  if (typeof remote_path !== 'string' || remote_path.trim().length === 0) {
    return res.status(400).json({ error: 'remote_path is required.' });
  }
  const isAgent = remote_auth_type === 'agent';
  if (!isAgent && (typeof credential !== 'string' || credential.length === 0)) {
    return res.status(400).json({ error: 'credential is required.' });
  }

  const remotePath = remote_path.trim();

  let credentialId = null;
  try {
    // 'agent' auth stores no credential: credentialRef stays null and the
    // server authenticates with its own SSH agent / default keys.
    if (!isAgent) {
      const created = credentialsDb.createRemoteCredential(
        req.user.id,
        typeof customProjectName === 'string' && customProjectName.trim().length > 0
          ? customProjectName.trim()
          : `${parsed.config.user}@${parsed.config.host}`,
        remote_auth_type === 'key' ? 'ssh_key' : 'ssh_password',
        credential
      );
      credentialId = Number(created.id);
    }

    const testResult = await sshConnectionManager.testConnection({
      ...parsed.config,
      path: remotePath,
      credentialRef: credentialId !== null ? String(credentialId) : null,
    });

    if (!testResult.ok) {
      if (credentialId !== null) {
        credentialsDb.deleteRemoteCredential(credentialId);
        credentialId = null;
      }
      return res.status(400).json({ error: testResult.error || 'Connection test failed.' });
    }

    const row = projectsDb.createRemoteProject({
      customProjectName:
        typeof customProjectName === 'string' ? customProjectName : null,
      host: parsed.config.host,
      port: parsed.config.port,
      user: parsed.config.user,
      remotePath,
      authType: parsed.config.authType,
      credentialRef: credentialId !== null ? String(credentialId) : null,
    });

    return res.status(201).json({ project: toPublicProject(row) });
  } catch (error) {
    if (credentialId !== null) {
      try {
        credentialsDb.deleteRemoteCredential(credentialId);
      } catch (cleanupError) {
        console.error('Error cleaning up credential after failed create:', cleanupError);
      }
    }
    if (error && typeof error.message === 'string' && error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'A remote project for this host and path already exists.' });
    }
    console.error('Error creating remote project:', error);
    return res.status(500).json({ error: 'Failed to create remote project.' });
  }
});

/**
 * PUT /:projectId
 * Updates host/port/user/path and optionally the credential (re-encrypted), then
 * re-tests the connection. Requires the project to exist and be type remote.
 */
router.put('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const owned = loadOwnedRemoteProject(projectId, req.user.id);
  if (owned.error) {
    return res.status(owned.status).json({ error: owned.error });
  }

  const { remote_host, remote_port, remote_user, remote_path, credential } = req.body || {};

  const parsed = parseConnectionFields({
    host: remote_host,
    port: remote_port,
    user: remote_user,
    authType: owned.row.remote_auth_type,
  });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  if (typeof remote_path !== 'string' || remote_path.trim().length === 0) {
    return res.status(400).json({ error: 'remote_path is required.' });
  }
  const remotePath = remote_path.trim();
  const isAgent = owned.row.remote_auth_type === 'agent';

  try {
    // Re-encrypt the credential first if a new secret was supplied. 'agent'
    // projects store no credential, so any supplied credential is ignored.
    if (!isAgent && credential !== undefined && credential !== null && credential !== '') {
      if (typeof credential !== 'string') {
        return res.status(400).json({ error: 'credential must be a string.' });
      }
      credentialsDb.updateRemoteCredential(owned.credentialId, credential);
    }

    const testResult = await sshConnectionManager.testConnection({
      ...parsed.config,
      path: remotePath,
      credentialRef: owned.credentialId !== null ? String(owned.credentialId) : null,
    });
    if (!testResult.ok) {
      return res.status(400).json({ error: testResult.error || 'Connection test failed.' });
    }

    const updated = projectsDb.updateRemoteProject(projectId, {
      host: parsed.config.host,
      port: parsed.config.port,
      user: parsed.config.user,
      remotePath,
    });
    if (!updated) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    // Drop any stale pooled connection so the next use reconnects with new config.
    await sshConnectionManager.disconnect(projectId).catch(() => {});

    return res.json({ project: toPublicProject(updated) });
  } catch (error) {
    console.error('Error updating remote project:', error);
    return res.status(500).json({ error: 'Failed to update remote project.' });
  }
});

/**
 * DELETE /:projectId
 * Disconnects, removes the project row, and deletes the credential when no other
 * project still references it.
 */
router.delete('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const owned = loadOwnedRemoteProject(projectId, req.user.id);
  if (owned.error) {
    return res.status(owned.status).json({ error: owned.error });
  }

  try {
    await sshConnectionManager.disconnect(projectId).catch(() => {});

    const credentialRef = owned.row.remote_credential_ref;
    projectsDb.deleteProjectById(projectId);

    if (credentialRef) {
      const remaining = projectsDb.countProjectsByCredentialRef(credentialRef);
      if (remaining === 0) {
        credentialsDb.deleteRemoteCredential(owned.credentialId);
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting remote project:', error);
    return res.status(500).json({ error: 'Failed to delete remote project.' });
  }
});

/**
 * GET /:projectId/status
 * Reports the current SSH connection status for a remote project.
 */
router.get('/:projectId/status', (req, res) => {
  const { projectId } = req.params;
  const owned = loadOwnedRemoteProject(projectId, req.user.id);
  if (owned.error) {
    return res.status(owned.status).json({ error: owned.error });
  }

  const connection = sshConnectionManager.getConnection(projectId);
  const status = connection ? connection.status : 'disconnected';
  return res.json({ status });
});

/**
 * POST /:projectId/reconnect
 * Drops any existing pooled connection and reconnects using stored config.
 */
router.post('/:projectId/reconnect', async (req, res) => {
  const { projectId } = req.params;
  const owned = loadOwnedRemoteProject(projectId, req.user.id);
  if (owned.error) {
    return res.status(owned.status).json({ error: owned.error });
  }

  try {
    await sshConnectionManager.disconnect(projectId).catch(() => {});
    const connection = await sshConnectionManager.connect(projectId, owned.config);
    return res.json({ status: connection.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reconnect.';
    console.error('Error reconnecting remote project:', error);
    return res.status(502).json({ status: 'error', error: message });
  }
});

/**
 * Projects a remote project row into a client-safe shape. The credential
 * reference is intentionally omitted so the credential id is never exposed.
 */
function toPublicProject(row) {
  return {
    projectId: row.project_id,
    name: row.custom_project_name,
    projectType: row.project_type,
    host: row.remote_host,
    port: row.remote_port,
    user: row.remote_user,
    path: row.remote_path,
    authType: row.remote_auth_type,
  };
}

export default router;
