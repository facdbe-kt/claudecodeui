import type { ProjectRepositoryRow, RemoteProjectConfig } from '@/shared/types.js';

/**
 * Derives the normalized SSH connection config for a remote project from its
 * database row.
 *
 * Centralizes the `remote_*` column → {@link RemoteProjectConfig} mapping so
 * every remote-aware consumer (shell websocket, search, file-tree, AI-CLI)
 * builds the same shape from a project row instead of duplicating the field
 * plumbing inline. Defaults `port` to the SSH standard (22) when the row leaves
 * it unset.
 *
 * The row must belong to a `project_type === 'remote'` project; the `remote_*`
 * columns are `null` for local projects, so callers should branch on
 * `project_type` before mapping.
 */
export function rowToRemoteConfig(row: ProjectRepositoryRow): RemoteProjectConfig {
  return {
    host: row.remote_host ?? '',
    port: row.remote_port ?? 22,
    user: row.remote_user ?? '',
    path: row.remote_path ?? '',
    authType: row.remote_auth_type ?? 'key',
    // `agent` rows store no credential, so a null ref maps cleanly to ''.
    credentialRef: row.remote_credential_ref ?? '',
  };
}
