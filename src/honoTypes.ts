import type { Env } from './env';
import type { SessionUser } from './lib/session';
import type { ServiceAssertionPayload } from './lib/serviceAssertion';

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user?: SessionUser;
    realmId?: string;
    // Set by requireServiceAssertion (src/middleware/internalAuth.ts) on the
    // /internal/* routes the Hub calls via the FINANCE service binding —
    // distinct from `user`, which is set by the staff-facing session cookie
    // and never populated on these machine-to-machine routes.
    serviceAssertion?: ServiceAssertionPayload;
  };
};
