// Verifies the short-lived signed internal identity assertion the Hub
// (MiCasaOpsHub/src/lib/serviceAssertion.ts) attaches to every call it makes
// into this app's /internal/* routes via the FINANCE Service Binding. This
// file is a deliberate, intentional duplicate of the Hub's verification
// logic (same format, same algorithm) rather than a shared package — the
// two apps are separate deployable units with separate secrets
// (FINANCE_INTERNAL_SECRET here, distinct from the Hub's own
// HUB_INTERNAL_SECRET and from Documents' DOCUMENTS_INTERNAL_SECRET), and
// this app never signs an assertion of its own, only verifies one.
import { fromBase64Url, hmacVerifyHex } from './crypto';

export interface ServiceAssertionPayload {
  /** The acting Hub user's id (their email). */
  sub: string;
  org: string;
  role: string;
  permissions: string[];
  iat: number;
  exp: number;
  jti: string;
}

export async function verifyServiceAssertion(secret: string, token: string): Promise<ServiceAssertionPayload | null> {
  if (typeof token !== 'string' || !token) return null;
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;
  const payloadB64 = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  const validSignature = await hmacVerifyHex(secret, payloadB64, signature);
  if (!validSignature) return null;

  let payload: ServiceAssertionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return null;
  }
  if (
    typeof payload.exp !== 'number' ||
    typeof payload.sub !== 'string' ||
    typeof payload.jti !== 'string' ||
    !Array.isArray(payload.permissions)
  ) {
    return null;
  }
  if (payload.exp < Date.now()) return null;

  return payload;
}
