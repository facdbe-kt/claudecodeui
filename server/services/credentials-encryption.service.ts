/**
 * Credential encryption service.
 *
 * Encrypts and decrypts credential secrets (e.g. SSH passwords/private keys)
 * at rest using AES-256-GCM. The master key is read from the
 * ENCRYPTION_MASTER_KEY environment variable; when unset an ephemeral key is
 * generated at runtime (with a loud warning) so development still works, but
 * such credentials will not survive a restart.
 *
 * Ciphertext is stored as a self-contained, versioned string:
 *   "v1:" + base64(iv | authTag | ciphertext)
 * which lets `decryptCredential` validate the GCM auth tag and detect tampering
 * or a wrong key.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256-bit key
const IV_LENGTH = 12; // 96-bit nonce, recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit GCM auth tag
const VERSION_PREFIX = 'v1:';

// Fixed, non-secret salt for key derivation. The derivation only normalises an
// arbitrary-length env value into a 32-byte key; the GCM auth tag and per-call
// random IV provide the actual integrity/uniqueness guarantees.
const KEY_DERIVATION_SALT = 'claudecodeui:credential-encryption:v1';

// ---------------------------------------------------------------------------
// Master key resolution
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

/**
 * Derives the 32-byte AES key, deriving it from ENCRYPTION_MASTER_KEY when set
 * or from an ephemeral random value otherwise. The result is cached so a single
 * process always uses one key.
 */
function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const provided = process.env.ENCRYPTION_MASTER_KEY;
  let source: string;

  if (provided && provided.trim().length > 0) {
    source = provided;
  } else {
    source = crypto.randomBytes(KEY_LENGTH).toString('hex');
    console.warn(
      '[credentials-encryption] ENCRYPTION_MASTER_KEY is not set; generated an EPHEMERAL key. ' +
        'Encrypted credentials will NOT survive a restart. Set ENCRYPTION_MASTER_KEY in production.'
    );
  }

  // scrypt normalises any-length input into a fixed 32-byte key.
  cachedKey = crypto.scryptSync(source, KEY_DERIVATION_SALT, KEY_LENGTH);
  return cachedKey;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Encrypts a plaintext secret into a versioned, self-contained string. */
export function encryptCredential(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([iv, authTag, encrypted]);
  return VERSION_PREFIX + payload.toString('base64');
}

/**
 * Decrypts a string produced by `encryptCredential`. Throws a clear error when
 * the format is unrecognised or the auth tag fails to validate (tampering or
 * wrong master key).
 */
export function decryptCredential(ciphertext: string): string {
  if (!ciphertext.startsWith(VERSION_PREFIX)) {
    throw new Error(
      '[credentials-encryption] Unrecognised ciphertext format (missing version prefix).'
    );
  }

  const payload = Buffer.from(ciphertext.slice(VERSION_PREFIX.length), 'base64');
  if (payload.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      '[credentials-encryption] Ciphertext is too short to be valid.'
    );
  }

  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error(
      '[credentials-encryption] Failed to decrypt credential: data was tampered with or the master key is wrong.'
    );
  }
}

/** Generates a random salt (hex), useful for callers that need a unique nonce. */
export function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}
