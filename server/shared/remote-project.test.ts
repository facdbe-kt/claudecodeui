import assert from 'node:assert/strict';
import test from 'node:test';

import { rowToRemoteConfig } from '@/shared/remote-project.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';

/**
 * Builds a remote project row, defaulting every column so each test can override
 * only the fields it exercises. Mirrors the shape returned by the projects repo.
 */
function makeRemoteRow(overrides: Partial<ProjectRepositoryRow> = {}): ProjectRepositoryRow {
  return {
    project_id: 'proj-remote-1',
    project_path: '/virtual/remote/proj-remote-1',
    custom_project_name: null,
    isStarred: 0,
    isArchived: 0,
    group_id: null,
    project_type: 'remote',
    remote_host: '10.77.110.165',
    remote_port: 2222,
    remote_user: 'zyx',
    remote_path: '/home/zyx/project',
    remote_auth_type: 'key',
    remote_credential_ref: 'v1:abc123',
    ...overrides,
  };
}

test('rowToRemoteConfig maps a fully-populated remote row to the config shape', () => {
  const config = rowToRemoteConfig(makeRemoteRow());

  assert.deepEqual(config, {
    host: '10.77.110.165',
    port: 2222,
    user: 'zyx',
    path: '/home/zyx/project',
    authType: 'key',
    credentialRef: 'v1:abc123',
  });
});

test('rowToRemoteConfig defaults port to 22 when remote_port is null', () => {
  const config = rowToRemoteConfig(makeRemoteRow({ remote_port: null }));
  assert.equal(config.port, 22);
});

test('rowToRemoteConfig defaults authType to "key" when remote_auth_type is null', () => {
  const config = rowToRemoteConfig(makeRemoteRow({ remote_auth_type: null }));
  assert.equal(config.authType, 'key');
});

test('rowToRemoteConfig falls back to empty strings for null host/user/path', () => {
  const config = rowToRemoteConfig(
    makeRemoteRow({ remote_host: null, remote_user: null, remote_path: null })
  );

  assert.equal(config.host, '');
  assert.equal(config.user, '');
  assert.equal(config.path, '');
});

test('rowToRemoteConfig tolerates a null credential ref (agent mode) without throwing', () => {
  let config: ReturnType<typeof rowToRemoteConfig>;
  assert.doesNotThrow(() => {
    config = rowToRemoteConfig(
      makeRemoteRow({ remote_auth_type: 'agent', remote_credential_ref: null })
    );
  });

  // @ts-expect-error assigned inside doesNotThrow above
  assert.equal(config.authType, 'agent');
  // @ts-expect-error assigned inside doesNotThrow above
  assert.equal(config.credentialRef, '');
});
