import type { Env } from '../env';
import { hashPassword, verifyPassword } from './password';

export type Role = 'admin' | 'staff' | 'read_only';
export const ROLES: Role[] = ['admin', 'staff', 'read_only'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as string[]).includes(value);
}

export interface User {
  id: string;
  email: string;
  role: Role;
  isAdmin: boolean; // derived: role === 'admin'
  disabled: boolean;
  forcePasswordChange: boolean;
  themePreference: ThemePreference;
  createdAt: number;
  updatedAt: number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
  iterations: number;
  role: string;
  disabled: number;
  force_password_change: number;
  theme_preference: string;
  created_at: number;
  updated_at: number;
}

function toUser(row: UserRow): User {
  const role = isRole(row.role) ? row.role : 'staff';
  return {
    id: row.id,
    email: row.email,
    role,
    isAdmin: role === 'admin',
    disabled: row.disabled === 1,
    forcePasswordChange: row.force_password_change === 1,
    themePreference: isThemePreference(row.theme_preference) ? row.theme_preference : 'system',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function findUserByEmail(env: Env, email: string): Promise<(User & { passwordRow: UserRow }) | null> {
  const row = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`)
    .bind(email.toLowerCase().trim())
    .first<UserRow>();
  if (!row) return null;
  return { ...toUser(row), passwordRow: row };
}

export async function findUserById(env: Env, userId: string): Promise<User | null> {
  const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first<UserRow>();
  return row ? toUser(row) : null;
}

/** Rejects wrong passwords and disabled accounts alike — callers must not distinguish the two in responses. */
export async function verifyCredentials(env: Env, email: string, password: string): Promise<User | null> {
  const found = await findUserByEmail(env, email);
  if (!found) return null;
  if (found.disabled) return null;
  const ok = await verifyPassword(password, found.passwordRow);
  if (!ok) return null;
  return {
    id: found.id,
    email: found.email,
    role: found.role,
    isAdmin: found.isAdmin,
    disabled: found.disabled,
    themePreference: found.themePreference,
    forcePasswordChange: found.forcePasswordChange,
    createdAt: found.createdAt,
    updatedAt: found.updatedAt
  };
}

export async function createUser(
  env: Env,
  email: string,
  password: string,
  role: Role,
  options: { forcePasswordChange?: boolean } = {}
): Promise<User> {
  const normalizedEmail = email.toLowerCase().trim();
  const { hash, salt, iterations } = await hashPassword(password);
  const id = crypto.randomUUID();
  const now = Date.now();
  const forcePasswordChange = options.forcePasswordChange ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, iterations, role, disabled, force_password_change, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(id, normalizedEmail, hash, salt, iterations, role, forcePasswordChange, now, now)
    .run();
  return {
    id,
    email: normalizedEmail,
    role,
    isAdmin: role === 'admin',
    disabled: false,
    forcePasswordChange: !!options.forcePasswordChange,
    themePreference: 'system',
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Creates the user as an admin if the email doesn't exist yet, or updates its
 * password and role in place (keeping the original id/created_at) if it does.
 * Used by scripts/create-admin.mjs so re-running it is always safe.
 */
export async function upsertAdminUser(
  env: Env,
  email: string,
  password: string,
  isAdmin: boolean
): Promise<{ user: User; created: boolean }> {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await findUserByEmail(env, normalizedEmail);
  const { hash, salt, iterations } = await hashPassword(password);
  const now = Date.now();
  const role: Role = isAdmin ? 'admin' : 'staff';

  if (!existing) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, iterations, role, disabled, force_password_change, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
    )
      .bind(id, normalizedEmail, hash, salt, iterations, role, now, now)
      .run();
    return {
      user: {
        id,
        email: normalizedEmail,
        role,
        isAdmin,
        disabled: false,
        forcePasswordChange: false,
        themePreference: 'system',
        createdAt: now,
        updatedAt: now
      },
      created: true
    };
  }

  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, role = ?, disabled = 0, force_password_change = 0, updated_at = ?
     WHERE id = ?`
  )
    .bind(hash, salt, iterations, role, now, existing.id)
    .run();
  return {
    user: {
      id: existing.id,
      email: normalizedEmail,
      role,
      isAdmin,
      disabled: false,
      forcePasswordChange: false,
      themePreference: existing.themePreference,
      createdAt: existing.createdAt,
      updatedAt: now
    },
    created: false
  };
}

export async function listUsers(env: Env): Promise<User[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM users ORDER BY email ASC`).all<UserRow>();
  return (results ?? []).map(toUser);
}

export async function deleteUser(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId)
  ]);
}

export async function setUserRole(env: Env, userId: string, role: Role): Promise<void> {
  await env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).bind(role, Date.now(), userId).run();
}

/** Self-service Appearance preference — every authenticated user sets their own, not just admins. */
export async function setThemePreference(env: Env, userId: string, theme: ThemePreference): Promise<void> {
  await env.DB.prepare(`UPDATE users SET theme_preference = ?, updated_at = ? WHERE id = ?`).bind(theme, Date.now(), userId).run();
}

/** Disabling also revokes all of the user's existing sessions immediately. */
export async function setUserDisabled(env: Env, userId: string, disabled: boolean): Promise<void> {
  const now = Date.now();
  const statements = [env.DB.prepare(`UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?`).bind(disabled ? 1 : 0, now, userId)];
  if (disabled) statements.push(env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId));
  await env.DB.batch(statements);
}

/**
 * Admin-initiated password reset: sets a new password, flags the account so
 * the next login must change it, and revokes existing sessions so the old
 * password/session can no longer be used.
 */
export async function resetUserPassword(env: Env, userId: string, newPassword: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(newPassword);
  const now = Date.now();
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, force_password_change = 1, updated_at = ? WHERE id = ?`
      )
      .bind(hash, salt, iterations, now, userId),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId)
  ]);
}

/** Self-service password change (e.g. clearing a forced reset) — clears the force flag. */
export async function changeOwnPassword(env: Env, userId: string, newPassword: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(newPassword);
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, force_password_change = 0, updated_at = ? WHERE id = ?`
  )
    .bind(hash, salt, iterations, Date.now(), userId)
    .run();
}

export async function getRecipientEmails(env: Env): Promise<string> {
  const users = await listUsers(env);
  const active = users.filter(u => !u.disabled);
  if (active.length === 0) return 'elijahkrumme@gmail.com';
  return active.map(u => u.email).join(', ');
}
