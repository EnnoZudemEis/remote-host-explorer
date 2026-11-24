/** Pure host-key logic for SFTP (no VS Code dependency, unit-testable). */

/** Called with the server's key fingerprint; resolves to true if the connection may proceed. */
export type HostKeyVerifier = (hostId: string, fingerprint: string) => Promise<boolean>;

export type HostKeyDecision = 'trusted' | 'new' | 'changed';

/** "host:port" key under which a fingerprint is remembered. */
export const hostId = (host: string, port: number): string => `${host.toLowerCase()}:${port}`;

/** Hex SHA-256 (as delivered by ssh2 with hostHash 'sha256') to OpenSSH style "SHA256:base64". */
export function formatFingerprint(hexSha256: string): string {
  return `SHA256:${Buffer.from(hexSha256, 'hex').toString('base64').replace(/=+$/, '')}`;
}

export function checkHostKey(known: Record<string, string>, id: string, fingerprint: string): HostKeyDecision {
  const stored = known[id];
  if (stored === undefined) return 'new';
  return stored === fingerprint ? 'trusted' : 'changed';
}
