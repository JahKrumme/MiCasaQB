import { describe, expect, it } from 'vitest';
import { EncryptionError, decryptJson, encryptJson, importEncryptionKey } from '../src/lib/crypto';

function randomBase64Key(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('crypto', () => {
  it('encrypts and decrypts a round trip with matching AAD', async () => {
    const key = await importEncryptionKey(randomBase64Key(32));
    const payload = { access_token: 'abc123', refresh_token: 'def456' };

    const encrypted = await encryptJson(key, payload, 'realm-1');
    expect(encrypted.ciphertext).not.toContain('abc123');

    const decrypted = await decryptJson<typeof payload>(key, encrypted, 'realm-1');
    expect(decrypted).toEqual(payload);
  });

  it('generates a unique IV for every encryption call', async () => {
    const key = await importEncryptionKey(randomBase64Key(32));
    const a = await encryptJson(key, { x: 1 }, 'realm-1');
    const b = await encryptJson(key, { x: 1 }, 'realm-1');
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('rejects an encryption key that does not decode to exactly 32 bytes', async () => {
    await expect(importEncryptionKey(randomBase64Key(16))).rejects.toThrow(EncryptionError);
    await expect(importEncryptionKey(randomBase64Key(48))).rejects.toThrow(EncryptionError);
    await expect(importEncryptionKey('')).rejects.toThrow(EncryptionError);
  });

  it('fails closed when the AAD does not match (tamper/context mismatch)', async () => {
    const key = await importEncryptionKey(randomBase64Key(32));
    const encrypted = await encryptJson(key, { x: 1 }, 'realm-1');
    await expect(decryptJson(key, encrypted, 'realm-2')).rejects.toThrow(EncryptionError);
  });

  it('fails closed when decrypting with the wrong key', async () => {
    const keyA = await importEncryptionKey(randomBase64Key(32));
    const keyB = await importEncryptionKey(randomBase64Key(32));
    const encrypted = await encryptJson(keyA, { x: 1 }, 'realm-1');
    await expect(decryptJson(keyB, encrypted, 'realm-1')).rejects.toThrow(EncryptionError);
  });

  it('fails closed when ciphertext has been tampered with', async () => {
    const key = await importEncryptionKey(randomBase64Key(32));
    const encrypted = await encryptJson(key, { x: 1 }, 'realm-1');
    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + 'abcd' };
    await expect(decryptJson(key, tampered, 'realm-1')).rejects.toThrow(EncryptionError);
  });
});
