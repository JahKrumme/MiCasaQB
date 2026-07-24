// Minimal ambient typings for the handful of Node built-ins used by test
// helpers (which run under plain Node, not the Workers runtime). Kept local
// and narrow instead of pulling in @types/node globally, since its DOM-ish
// globals (Request/Response/etc.) would otherwise collide with
// @cloudflare/workers-types' ambient declarations used by src/.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
  const path: { dirname: typeof dirname; join: typeof join };
  export default path;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

interface ImportMeta {
  url: string;
}
