import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptCredential,
  encryptCredential,
} from '@/services/credentials-encryption.service.js';

// NOTE: the AES master key is derived once and cached at module load (see
// `getMasterKey` in credentials-encryption.service.ts). Every test in THIS file
// therefore shares one process-wide key — which is exactly what the round-trip
// and tamper assertions need. The "different master key" scenario cannot reuse
// this already-cached module, so it loads a SECOND, freshly-imported copy of the
// module in a child process with a different ENCRYPTION_MASTER_KEY; see the
// dedicated test below. The whole file is CI-safe: no SSH host, no network, and
// fully deterministic (the only randomness is the per-call IV, which round-trips
// back to the same plaintext).

const VERSION_PREFIX = 'v1:';

test('encryptCredential/decryptCredential round-trips a simple secret', () => {
  const plaintext = 'super-secret-password';
  const encrypted = encryptCredential(plaintext);

  assert.equal(decryptCredential(encrypted), plaintext);
});

test('encryptCredential round-trips an empty string', () => {
  const encrypted = encryptCredential('');
  assert.equal(decryptCredential(encrypted), '');
});

test('encryptCredential round-trips unicode and special characters', () => {
  const plaintext = '密码🔐 — "quotes" \'apostrophes\' \t\n\\ $(rm -rf /) `whoami`';
  const encrypted = encryptCredential(plaintext);
  assert.equal(decryptCredential(encrypted), plaintext);
});

test('encryptCredential round-trips a long ~3KB fake private key', () => {
  const fakeKey =
    '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
    'b3BlbnNzaC1rZXktdjEAAAAA'.repeat(160) +
    '\n-----END OPENSSH PRIVATE KEY-----\n';
  assert.ok(fakeKey.length >= 3000, 'fixture should be at least ~3KB');

  const encrypted = encryptCredential(fakeKey);
  assert.equal(decryptCredential(encrypted), fakeKey);
});

test('encrypted output starts with the version prefix and is not the plaintext', () => {
  const plaintext = 'reveal-me';
  const encrypted = encryptCredential(plaintext);

  assert.ok(encrypted.startsWith(VERSION_PREFIX), 'should carry the v1 prefix');
  assert.notEqual(encrypted, plaintext);
  assert.ok(!encrypted.includes(plaintext), 'ciphertext must not embed the plaintext');
});

test('encryptCredential produces a distinct ciphertext per call (random IV)', () => {
  const plaintext = 'same-input';
  const first = encryptCredential(plaintext);
  const second = encryptCredential(plaintext);

  assert.notEqual(first, second, 'random IV should make each ciphertext unique');
  assert.equal(decryptCredential(first), plaintext);
  assert.equal(decryptCredential(second), plaintext);
});

test('decryptCredential throws on a tampered ciphertext (GCM auth tag fails)', () => {
  const encrypted = encryptCredential('integrity-protected');

  // Flip the final base64 character to mutate the authenticated ciphertext body
  // without changing its length/format. Pick a replacement that actually differs.
  const lastChar = encrypted.slice(-1);
  const replacement = lastChar === 'A' ? 'B' : 'A';
  const tampered = encrypted.slice(0, -1) + replacement;

  assert.notEqual(tampered, encrypted);
  assert.throws(() => decryptCredential(tampered), /Failed to decrypt|tampered|too short/i);
});

test('decryptCredential throws on a wrong/garbage format (no version prefix)', () => {
  assert.throws(
    () => decryptCredential('not-a-valid-ciphertext'),
    /Unrecognised ciphertext format/i
  );
});

test('decryptCredential throws when the payload is too short to be valid', () => {
  // Correct prefix, but the base64 body decodes to fewer bytes than iv+tag.
  const tooShort = VERSION_PREFIX + Buffer.from('short').toString('base64');
  assert.throws(() => decryptCredential(tooShort), /too short/i);
});

test('decryptCredential fails under a different master key (separate module instance)', async () => {
  // The master key is cached at module load, so this scenario MUST run in a
  // fresh process. We encrypt under one key, then attempt to decrypt that exact
  // ciphertext in a child process whose ENCRYPTION_MASTER_KEY differs. A wrong
  // key fails the GCM auth tag, which surfaces as the standard decrypt error.
  //
  // The child scripts are written as real `.ts` files inside the repo tree (not
  // passed via `--eval`) so tsx applies this project's `@/` path alias exactly
  // like the test runner does. They are cleaned up in `finally`.
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');

  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, '..', '..');
  const tsconfig = path.join(projectRoot, 'server', 'tsconfig.json');
  const serviceSpecifier = '@/services/credentials-encryption.service.js';

  // Scratch dir lives under server/ so the `@/` alias (server/*) resolves.
  const scratchDir = mkdtempSync(path.join(here, 'cred-xkey-'));
  const encryptFile = path.join(scratchDir, 'encrypt.ts');
  const decryptFile = path.join(scratchDir, 'decrypt.ts');

  const runChild = (file: string, masterKey: string): string =>
    execFileSync('npx', ['tsx', '--tsconfig', tsconfig, file], {
      cwd: projectRoot,
      env: { ...process.env, ENCRYPTION_MASTER_KEY: masterKey },
    })
      .toString()
      .trim();

  try {
    // 1) Encrypt under key "alpha".
    writeFileSync(
      encryptFile,
      `import { encryptCredential } from '${serviceSpecifier}';\n` +
        `process.stdout.write(encryptCredential('cross-key-secret'));\n`
    );
    const ciphertext = runChild(encryptFile, 'alpha-master-key');
    assert.ok(ciphertext.startsWith(VERSION_PREFIX), 'child should emit a v1 ciphertext');

    // 2) Decrypt the SAME ciphertext under key "beta": the auth tag must fail.
    writeFileSync(
      decryptFile,
      `import { decryptCredential } from '${serviceSpecifier}';\n` +
        `try {\n` +
        `  decryptCredential(${JSON.stringify(ciphertext)});\n` +
        `  process.stdout.write('UNEXPECTED_SUCCESS');\n` +
        `} catch {\n` +
        `  process.stdout.write('EXPECTED_FAILURE');\n` +
        `}\n`
    );
    const result = runChild(decryptFile, 'beta-master-key');
    assert.equal(result, 'EXPECTED_FAILURE', 'wrong master key must fail the auth tag');

    // Sanity check: the SAME key round-trips the cross-process ciphertext,
    // proving the failure above is the key mismatch and not a transport bug.
    const sameKeyResult = runChild(decryptFile, 'alpha-master-key');
    assert.equal(sameKeyResult, 'UNEXPECTED_SUCCESS', 'matching key must decrypt successfully');
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
