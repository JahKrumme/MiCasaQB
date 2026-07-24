import type { Env } from './env';
import type { SessionUser } from './lib/session';

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user?: SessionUser;
    realmId?: string;
  };
};
