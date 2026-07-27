// Test-only signer for constructing service assertions to POST at
// /internal/* routes — production code in this app only ever verifies an
// assertion (src/lib/serviceAssertion.ts), it never signs one (only the Hub
// does, in MiCasaOpsHub/src/lib/serviceAssertion.ts). This mirrors that
// signing logic just enough to build fixtures for internal.test.ts.
async function hmacSignHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message) as BufferSource);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface TestAssertionClaims {
  sub: string;
  org: string;
  role: string;
  permissions: string[];
  iat?: number;
  exp?: number;
  jti?: string;
}

export async function signTestAssertion(secret: string, claims: TestAssertionClaims): Promise<string> {
  const now = Date.now();
  const payload = {
    sub: claims.sub,
    org: claims.org,
    role: claims.role,
    permissions: claims.permissions,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + 60_000,
    jti: claims.jti ?? crypto.randomUUID()
  };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSignHex(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}
