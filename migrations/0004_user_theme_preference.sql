-- Per-user Appearance preference, set from Admin > Appearance. D1 is the
-- durable, cross-device source of truth; the client also mirrors it into
-- localStorage so the theme can be applied before the first paint (see
-- public/theme.js) without waiting on a network round trip.
ALTER TABLE users ADD COLUMN theme_preference TEXT NOT NULL DEFAULT 'system';
