/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 */

import { getConnection } from '@/modules/database/connection.js';
import {
  decryptCredential,
  encryptCredential,
} from '@/services/credentials-encryption.service.js';
import type {
  CreateCredentialResult,
  CredentialPublicRow,
  RemoteCredentialMeta,
  RemoteCredentialWithValue,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const credentialsDb = {
  /** Stores a new credential and returns a safe (no raw value) result. */
  createCredential(
    userId: number,
    credentialName: string,
    credentialType: string,
    credentialValue: string,
    description: string | null = null
  ): CreateCredentialResult {
    const db = getConnection();
    const result = db
      .prepare(
        'INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)'
      )
      .run(userId, credentialName, credentialType, credentialValue, description);
    return {
      id: result.lastInsertRowid,
      credentialName,
      credentialType,
    };
  },

  /**
   * Lists credentials for a user (excluding raw values).
   * Optionally filters by credential type (e.g. 'github_token').
   */
  getCredentials(
    userId: number,
    credentialType: string | null = null
  ): CredentialPublicRow[] {
    const db = getConnection();

    if (credentialType) {
      return db
        .prepare(
          'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at DESC'
        )
        .all(userId, credentialType) as CredentialPublicRow[];
    }

    return db
      .prepare(
        'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as CredentialPublicRow[];
  },

  /**
   * Returns the raw credential value for the most recent active
   * credential of the given type, or null if none exists.
   */
  getActiveCredential(
    userId: number,
    credentialType: string
  ): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
      )
      .get(userId, credentialType) as { credential_value: string } | undefined;
    return row?.credential_value ?? null;
  },

  /** Permanently removes a credential. Returns true if a row was deleted. */
  deleteCredential(userId: number, credentialId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?')
      .run(credentialId, userId);
    return result.changes > 0;
  },

  /** Enables or disables a credential without deleting it. */
  toggleCredential(
    userId: number,
    credentialId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, credentialId, userId);
    return result.changes > 0;
  },

  // -------------------------------------------------------------------------
  // Remote (SSH) credentials
  //
  // Reuses the user_credentials table; credential_value stores the AES-256-GCM
  // encrypted secret. Reads decrypt only via getRemoteCredential (server
  // internal). API-facing callers must use getRemoteCredentialMeta, which never
  // returns the plaintext.
  // -------------------------------------------------------------------------

  /**
   * Stores a new remote credential with its secret encrypted at rest.
   * Returns the new credential id and non-secret metadata (never the value).
   */
  createRemoteCredential(
    userId: number,
    name: string,
    type: string,
    value: string,
    description: string | null = null
  ): CreateCredentialResult {
    const db = getConnection();
    const encrypted = encryptCredential(value);
    const result = db
      .prepare(
        'INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)'
      )
      .run(userId, name, type, encrypted, description);
    console.log(
      `[credentials] created remote credential id=${result.lastInsertRowid}`
    );
    return {
      id: result.lastInsertRowid,
      credentialName: name,
      credentialType: type,
    };
  },

  /**
   * Returns the DECRYPTED remote credential (value + metadata) for
   * server-internal use such as the SSH manager. Returns null when not found.
   */
  getRemoteCredential(
    credentialId: number
  ): RemoteCredentialWithValue | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT id, credential_name, credential_type, credential_value, description FROM user_credentials WHERE id = ?'
      )
      .get(credentialId) as
      | {
          id: number;
          credential_name: string;
          credential_type: string;
          credential_value: string;
          description: string | null;
        }
      | undefined;

    if (!row) return null;
    console.log(`[credentials] accessed remote credential id=${row.id}`);
    return {
      id: row.id,
      name: row.credential_name,
      type: row.credential_type,
      description: row.description,
      hasValue: true,
      value: decryptCredential(row.credential_value),
    };
  },

  /**
   * Returns non-secret metadata for a remote credential, suitable for API
   * responses. NEVER returns the plaintext value. Returns null when not found.
   */
  getRemoteCredentialMeta(credentialId: number): RemoteCredentialMeta | null {
    const db = getConnection();
    const row = db
      .prepare(
        'SELECT id, credential_name, credential_type, description, credential_value FROM user_credentials WHERE id = ?'
      )
      .get(credentialId) as
      | {
          id: number;
          credential_name: string;
          credential_type: string;
          description: string | null;
          credential_value: string;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      name: row.credential_name,
      type: row.credential_type,
      description: row.description,
      hasValue: row.credential_value.length > 0,
    };
  },

  /**
   * Re-encrypts and stores a new secret value for a remote credential.
   * Returns true when a row was updated.
   */
  updateRemoteCredential(credentialId: number, newValue: string): boolean {
    const db = getConnection();
    const encrypted = encryptCredential(newValue);
    const result = db
      .prepare('UPDATE user_credentials SET credential_value = ? WHERE id = ?')
      .run(encrypted, credentialId);
    if (result.changes > 0) {
      console.log(`[credentials] updated remote credential id=${credentialId}`);
    }
    return result.changes > 0;
  },

  /**
   * Returns the owning user id for a credential, or null when the credential
   * does not exist. Used by API routes to enforce per-user ownership before
   * touching the (non-user-scoped) remote credential accessors.
   */
  getRemoteCredentialUserId(credentialId: number): number | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT user_id FROM user_credentials WHERE id = ?')
      .get(credentialId) as { user_id: number } | undefined;
    return row?.user_id ?? null;
  },

  /** Permanently removes a remote credential. Returns true if a row was deleted. */
  deleteRemoteCredential(credentialId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM user_credentials WHERE id = ?')
      .run(credentialId);
    if (result.changes > 0) {
      console.log(`[credentials] deleted remote credential id=${credentialId}`);
    }
    return result.changes > 0;
  },
};
