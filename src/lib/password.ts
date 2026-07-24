// Staff password hashing via PBKDF2-HMAC-SHA256 (Web Crypto), since scrypt/argon2
// are not available in the Workers runtime. 100,000 iterations is the Workers
// runtime's hard cap for PBKDF2 (crypto.subtle throws NotSupportedError above
// it) — below OWASP's current 600,000 recommendation, but the highest this
// platform allows; a random 16-byte salt per user plus login rate limiting
// (src/lib/rateLimit.ts) offsets the lower iteration count.

import { base64ToBytes, bytesToBase64 } from './crypto';

export const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH_BYTES = 16;
const KEY_LENGTH_BITS = 256;

export interface PasswordHash {
  hash: string; // base64
  salt: string; // base64
  iterations: number;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_LENGTH_BITS
  );
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
  const bits = await deriveBits(password, salt, iterations);
  return {
    hash: bytesToBase64(new Uint8Array(bits)),
    salt: bytesToBase64(salt),
    iterations
  };
}

export async function verifyPassword(
  password: string,
  stored: { password_hash: string; password_salt: string; iterations: number }
): Promise<boolean> {
  const salt = base64ToBytes(stored.password_salt);
  const bits = await deriveBits(password, salt, stored.iterations);
  const computed = bytesToBase64(new Uint8Array(bits));
  return timingSafeEqual(computed, stored.password_hash);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

/** Generates a random, high-entropy temporary password for admin-initiated resets. */
export function generateTemporaryPassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length];
  return out;
}
