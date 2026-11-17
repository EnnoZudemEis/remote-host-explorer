export type Protocol = 'ftp' | 'ftps' | 'sftp';

export interface ServerConfig {
  name: string;
  protocol: Protocol;
  host: string;
  port?: number;
  username: string;
  /** Password is stored in SecretStorage, not in the JSON file. */
  privateKeyPath?: string;
  /** Local folder relative to the workspace root. */
  localPath: string;
  /** Remote root folder. */
  remotePath: string;
  exclude?: string[];
  uploadOnSave?: boolean;
  /** FTPS only: accept self-signed / invalid certificates. Default: false (certificate is verified). */
  allowSelfSigned?: boolean;
  /** Offset in minutes added to remote timestamps (FTP without timezone). */
  timeOffsetMinutes?: number;
}

export interface RemoteEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  /** Modification time in ms since epoch. */
  mtime: number;
  permissions?: string;
}

export interface RemoteClient {
  connect(): Promise<void>;
  list(path: string): Promise<RemoteEntry[]>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, isDirectory: boolean): Promise<void>;
  close(): Promise<void>;
}
