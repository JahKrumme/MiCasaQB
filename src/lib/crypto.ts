// AES-256-GCM encryption for data at rest in D1, via the Web Crypto API.
// Design: fail closed. Any error (bad key length, tampering, wrong AAD) throws
// and is never swallowed into a fallback plaintext path. Nothing decrypted or
// keyed is ever logged.

const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new EncryptionError('Malformed base64 input');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Imports the base64-encoded TOKEN_ENCRYPTION_KEY secret as an AES-256-GCM
 * CryptoKey. Requires exactly 32 decoded bytes — a shorter or longer key is
 * rejected rather than silently truncated/padded.
 */
export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  if (!base64Key) {
    throw new EncryptionError('Encryption key is not configured');
  }
  const raw = base64ToBytes(base64Key);
  if (raw.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionError(
      `Encryption key must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${raw.length})`
    );
  }
  try {
    return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt'
    ]);
  } catch {
    throw new EncryptionError('Failed to import encryption key');
  }
}

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64, 12 random bytes, unique per encryption
}

/**
 * Encrypts arbitrary JSON-serializable data. A new random 12-byte IV is
 * generated for every call. `aad` (e.g. the realm ID) is authenticated but not
 * encrypted, binding the ciphertext to that context.
 */
export async function encryptJson(key: CryptoKey, data: unknown, aad: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const aadBytes = new TextEncoder().encode(aad);
  try {
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aadBytes as BufferSource },
      key,
      plaintext as BufferSource
    );
    return {
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      iv: bytesToBase64(iv)
    };
  } catch {
    // Fail closed — never fall back to storing plaintext.
    throw new EncryptionError('Encryption failed');
  }
}

/**
 * Decrypts a payload produced by encryptJson. Throws EncryptionError on any
 * failure (wrong key, wrong/mismatched AAD, tampered ciphertext, bad IV) —
 * callers must not catch-and-continue with stale data.
 */
export async function decryptJson<T>(key: CryptoKey, payload: EncryptedPayload, aad: string): Promise<T> {
  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);
  const aadBytes = new TextEncoder().encode(aad);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aadBytes as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    throw new EncryptionError('Decryption failed');
  }
}

/** SHA-256 hash, used for session tokens and rate-limit keys — never for passwords. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
