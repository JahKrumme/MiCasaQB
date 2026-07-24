import type { Env } from '../env';
import { decryptJson, encryptJson, importEncryptionKey } from './crypto';

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: string;
  access_token_expires_at: number; // epoch ms
  refresh_token_expires_at: number | null; // epoch ms
  realm_id: string;
}

export interface StoredConnection {
  realmId: string;
  bundle: TokenBundle;
  tokenVersion: number;
  keyVersion: number;
}

const CURRENT_KEY_VERSION = 1;

/**
 * Maps a key_version column value to the Worker secret holding that key.
 * To rotate: add a new secret (e.g. TOKEN_ENCRYPTION_KEY_V2), bump
 * CURRENT_KEY_VERSION, and add a case here. Existing rows keep decrypting
 * with whichever key produced them until they are next re-saved (which always
 * re-encrypts under CURRENT_KEY_VERSION).
 */
function resolveKeyForVersion(env: Env, keyVersion: number): string {
  switch (keyVersion) {
    case 1:
      return env.TOKEN_ENCRYPTION_KEY;
    default:
      throw new Error(`Unknown encryption key_version: ${keyVersion}`);
  }
}

export class TokenRepository {
  constructor(private readonly env: Env) {}

  private get db(): D1Database {
    return this.env.DB;
  }

  async getConnection(realmId: string): Promise<StoredConnection | null> {
    const row = await this.db
      .prepare(
        `SELECT realm_id, encrypted_token_bundle, encryption_iv, key_version, token_version
         FROM qbo_connections WHERE realm_id = ?`
      )
      .bind(realmId)
      .first<{
        realm_id: string;
        encrypted_token_bundle: string;
        encryption_iv: string;
        key_version: number;
        token_version: number;
      }>();

    if (!row) return null;

    const key = await importEncryptionKey(resolveKeyForVersion(this.env, row.key_version));
    const bundle = await decryptJson<TokenBundle>(
      key,
      { ciphertext: row.encrypted_token_bundle, iv: row.encryption_iv },
      row.realm_id
    );

    return {
      realmId: row.realm_id,
      bundle,
      tokenVersion: row.token_version,
      keyVersion: row.key_version
    };
  }

  /** Returns the realm_id of the single active connection, if any. */
  async getActiveRealmId(): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT realm_id FROM qbo_connections ORDER BY updated_at DESC LIMIT 1`)
      .first<{ realm_id: string }>();
    return row?.realm_id ?? null;
  }

  /** First-time save on OAuth callback. Always starts/bumps token_version. */
  async upsertConnection(realmId: string, bundle: TokenBundle): Promise<void> {
    const key = await importEncryptionKey(resolveKeyForVersion(this.env, CURRENT_KEY_VERSION));
    const { ciphertext, iv } = await encryptJson(key, bundle, realmId);
    const now = Date.now();

    await this.db
      .prepare(
        `INSERT INTO qbo_connections
           (realm_id, encrypted_token_bundle, encryption_iv, key_version,
            access_token_expires_at, refresh_token_expires_at, token_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(realm_id) DO UPDATE SET
           encrypted_token_bundle = excluded.encrypted_token_bundle,
           encryption_iv = excluded.encryption_iv,
           key_version = excluded.key_version,
           access_token_expires_at = excluded.access_token_expires_at,
           refresh_token_expires_at = excluded.refresh_token_expires_at,
           token_version = qbo_connections.token_version + 1,
           updated_at = excluded.updated_at`
      )
      .bind(
        realmId,
        ciphertext,
        iv,
        CURRENT_KEY_VERSION,
        bundle.access_token_expires_at,
        bundle.refresh_token_expires_at,
        now,
        now
      )
      .run();
  }

  /**
   * Saves a refreshed token bundle only if the stored token_version still
   * matches `expectedVersion` (optimistic concurrency). Returns saved: false
   * — without throwing — if another request already refreshed first; the
   * caller is expected to reload and use that newer bundle instead of ever
   * overwriting it with a stale one.
   */
  async saveRefreshedTokens(
    realmId: string,
    expectedVersion: number,
    bundle: TokenBundle
  ): Promise<{ saved: boolean }> {
    const key = await importEncryptionKey(resolveKeyForVersion(this.env, CURRENT_KEY_VERSION));
    const { ciphertext, iv } = await encryptJson(key, bundle, realmId);
    const now = Date.now();

    const result = await this.db
      .prepare(
        `UPDATE qbo_connections SET
           encrypted_token_bundle = ?,
           encryption_iv = ?,
           key_version = ?,
           access_token_expires_at = ?,
           refresh_token_expires_at = ?,
           token_version = token_version + 1,
           updated_at = ?
         WHERE realm_id = ? AND token_version = ?`
      )
      .bind(ciphertext, iv, CURRENT_KEY_VERSION, bundle.access_token_expires_at, bundle.refresh_token_expires_at, now, realmId, expectedVersion)
      .run();

    return { saved: (result.meta.changes ?? 0) > 0 };
  }

  async deleteConnection(realmId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM qbo_connections WHERE realm_id = ?`).bind(realmId).run();
  }
}
