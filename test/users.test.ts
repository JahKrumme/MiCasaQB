import { describe, expect, it } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import { createUser, findUserByEmail, upsertAdminUser } from '../src/lib/users';
import { verifyPassword } from '../src/lib/password';

describe('upsertAdminUser', () => {
  it('creates a new admin when the email does not exist', async () => {
    const env = createTestEnv();
    const { user, created } = await upsertAdminUser(env, 'new-admin@micasacarehomes.example', 'a-strong-password-123', true);

    expect(created).toBe(true);
    expect(user.isAdmin).toBe(true);
    expect(user.email).toBe('new-admin@micasacarehomes.example');

    const stored = await findUserByEmail(env, 'new-admin@micasacarehomes.example');
    expect(stored).not.toBeNull();
    await expect(verifyPassword('a-strong-password-123', stored!.passwordRow)).resolves.toBe(true);
  });

  it('updates password and admin status in place when the email already exists', async () => {
    const env = createTestEnv();
    const original = await createUser(env, 'existing@micasacarehomes.example', 'original-password-123', 'staff');

    const { user, created } = await upsertAdminUser(env, 'existing@micasacarehomes.example', 'brand-new-password-456', true);

    expect(created).toBe(false);
    expect(user.id).toBe(original.id); // same account, not a new row
    expect(user.isAdmin).toBe(true);
    expect(user.createdAt).toBe(original.createdAt);
    expect(user.updatedAt).toBeGreaterThanOrEqual(original.createdAt);

    const stored = await findUserByEmail(env, 'existing@micasacarehomes.example');
    await expect(verifyPassword('original-password-123', stored!.passwordRow)).resolves.toBe(false);
    await expect(verifyPassword('brand-new-password-456', stored!.passwordRow)).resolves.toBe(true);
  });

  it('persists admin status across separate reads', async () => {
    const env = createTestEnv();
    await upsertAdminUser(env, 'persist@micasacarehomes.example', 'a-strong-password-123', true);

    const firstRead = await findUserByEmail(env, 'persist@micasacarehomes.example');
    const secondRead = await findUserByEmail(env, 'PERSIST@MicasaCareHomes.example');
    expect(firstRead?.isAdmin).toBe(true);
    expect(secondRead?.isAdmin).toBe(true);

    await upsertAdminUser(env, 'persist@micasacarehomes.example', 'a-strong-password-123', false);
    const afterDemotion = await findUserByEmail(env, 'persist@micasacarehomes.example');
    expect(afterDemotion?.isAdmin).toBe(false);
  });

  it('normalizes email case and whitespace consistently with createUser', async () => {
    const env = createTestEnv();
    await createUser(env, '  Mixed-Case@Micasacarehomes.Example  ', 'a-strong-password-123', 'staff');

    const found = await findUserByEmail(env, 'mixed-case@micasacarehomes.example');
    expect(found).not.toBeNull();
    expect(found?.email).toBe('mixed-case@micasacarehomes.example');
  });
});
