import { FtpRemoteClient } from './ftpClient';
import { ResilientClient } from './resilient';
import { SftpRemoteClient } from './sftpClient';
import { HostKeyVerifier } from './hostKey';
import { RemoteClient, ServerConfig } from './types';

export async function createClient(
  cfg: ServerConfig,
  password: string,
  verifyHostKey?: HostKeyVerifier,
  jumpPassword?: string,
): Promise<RemoteClient> {
  const client = new ResilientClient(() =>
    cfg.protocol === 'sftp' ? new SftpRemoteClient(cfg, password, verifyHostKey, jumpPassword) : new FtpRemoteClient(cfg, password),
  );
  await client.connect();
  return client;
}
