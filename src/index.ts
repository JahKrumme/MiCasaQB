import { Hono } from 'hono';
import type { AppEnv } from './honoTypes';
import { securityHeaders } from './middleware/security';
import { authRoutes } from './routes/auth';
import { qboRoutes } from './routes/qbo';
import { qboApiRoutes } from './routes/qboApi';
import { chatRoutes } from './routes/chat';
import { adminRoutes } from './routes/admin';
import { invitationRoutes } from './routes/invitations';
import { cronRoutes } from './routes/cron';
import { internalRoutes } from './routes/internal';

const app = new Hono<AppEnv>();

app.use('*', securityHeaders);

// Lightweight, unauthenticated liveness check. Deliberately returns no
// connection state, token presence, or any other detail — replaces the old
// /health debug page, which leaked token prefixes and Supabase errors.
app.get('/api/health', c => c.json({ status: 'ok' }));

// Unauthenticated app-version check used by the in-app update control and the
// service worker. Deliberately exposes nothing beyond a build identifier —
// no secrets, env vars, paths, or DB state — and is never cached so a client
// always sees what's actually deployed right now.
app.get('/api/version', c => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    version: c.env.APP_VERSION || 'dev',
    builtAt: c.env.APP_BUILT_AT || null
  });
});

app.route('/api/auth', authRoutes);
app.route('/api/qbo', qboRoutes);
app.route('/api/qbo', qboApiRoutes);
app.route('/api/chat', chatRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/invitations', invitationRoutes);
app.route('/api/cron', cronRoutes);
// Called by the Mi Casa Operations Hub via the FINANCE Service Binding —
// not part of the staff-facing /api/* surface, protected by a signed
// service assertion instead of a session cookie (see
// src/middleware/internalAuth.ts).
app.route('/internal', internalRoutes);

app.notFound(c => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[UNHANDLED ERROR]', err instanceof Error ? err.message : 'unknown');
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
