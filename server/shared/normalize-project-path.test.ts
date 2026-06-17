import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProjectPath } from '@/shared/utils.js';

test('normalizeProjectPath preserves the ssh:// scheme double-slash', () => {
  assert.equal(
    normalizeProjectPath('ssh://zyx@10.77.110.165:2222/home/zyx/project'),
    'ssh://zyx@10.77.110.165:2222/home/zyx/project',
  );
});

test('normalizeProjectPath is idempotent on a remote URI key', () => {
  const once = normalizeProjectPath('ssh://zyx@host:22/home/zyx/proj');
  assert.equal(normalizeProjectPath(once), once);
});

test('normalizeProjectPath trims a trailing slash from a remote path', () => {
  assert.equal(
    normalizeProjectPath('ssh://zyx@host:22/home/zyx/proj/'),
    'ssh://zyx@host:22/home/zyx/proj',
  );
});

test('normalizeProjectPath collapses dot segments in the remote path only', () => {
  assert.equal(
    normalizeProjectPath('ssh://zyx@host:22/home/zyx/./a/../proj'),
    'ssh://zyx@host:22/home/zyx/proj',
  );
});

test('normalizeProjectPath still normalizes plain local paths', () => {
  assert.equal(normalizeProjectPath('/home/zyx/proj/'), '/home/zyx/proj');
  assert.equal(normalizeProjectPath('/home/zyx/./proj'), '/home/zyx/proj');
});
