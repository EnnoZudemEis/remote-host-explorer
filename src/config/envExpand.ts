import { ServerConfig } from '../connection/types';

/** Resolves ${env:NAME} placeholders in config values (no VS Code dependency, unit-testable). */

const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replaces ${env:NAME}; unknown variables stay as they are and are reported in `missing`. */
export function expandEnv(text: string, env: NodeJS.ProcessEnv = process.env): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = text.replace(ENV_REF, (whole, name: string) => {
    const v = env[name];
    if (v === undefined) { missing.push(name); return whole; }
    return v;
  });
  return { value, missing };
}

const FIELDS = ['host', 'username', 'localPath', 'remotePath', 'privateKeyPath'] as const;

/** Returns a copy of the server with ${env:NAME} resolved in host, username, paths and key path. */
export function expandServer(server: ServerConfig, env: NodeJS.ProcessEnv = process.env): { server: ServerConfig; missing: string[] } {
  const copy: ServerConfig = { ...server };
  const missing: string[] = [];
  for (const f of FIELDS) {
    const v = copy[f];
    if (typeof v !== 'string') continue;
    const r = expandEnv(v, env);
    (copy as unknown as Record<string, string>)[f] = r.value;
    missing.push(...r.missing);
  }
  return { server: copy, missing };
}
