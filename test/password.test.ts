import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password';

describe('password hashing', () => {
  it('verifies a correct password and rejects an incorrect one', async () => {
    const { hash, salt, iterations } = await hashPassword('correct-horse-battery-staple');
    const stored = { password_hash: hash, password_salt: salt, iterations };
    await expect(verifyPassword('correct-horse-battery-staple', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', stored)).resolves.toBe(false);
  });

  it('uses a unique random salt per hash, so identical passwords hash differently', async () => {
    const a = await hashPassword('same-password-both-times');
    const b = await hashPassword('same-password-both-times');
    expect(a.salt).not.toEqual(b.salt);
    expect(a.hash).not.toEqual(b.hash);
  });
});
