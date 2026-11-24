export type Protocol = 'ftp' | 'ftps' | 'sftp';

/** SFTP only: connect through this SSH server (like OpenSSH ProxyJump). */
export interface JumpHostConfig {
  host: string;
  port?: number;
  username: string;
  /** Private key for the jump host (no passphrase support, use the agent for protected keys). */
  privateKeyPath?: string;
  useAgent?: boolean;
}

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
  /** Also exclude everything matched by the .gitignore in the server's local folder. */
  useGitignore?: boolean;
  /** Keep a local copy of files that are overwritten or deleted by transfers (.vscode/remote-host-backup). */
  backupBeforeOverwrite?: boolean;
  /** Treat files that differ only in line endings (CRLF/LF) as equal when comparing. */
  ignoreLineEndings?: boolean;
  /** SFTP: authenticate with the running SSH agent (SSH_AUTH_SOCK / Pageant / OpenSSH pipe). */
  useAgent?: boolean;
  /** SFTP: reach the server through a jump host (bastion). */
  jumpHost?: JumpHostConfig;
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

export interface TransferOptions {
  /** Set the modification time of the target (remote: SFTP only, local: always). */
  mtimeMs?: number;
  /** Called with the number of bytes transferred so far. */
  onProgress?: (bytes: number) => void;
}

export interface RemoteClient {
  connect(): Promise<void>;
  list(path: string): Promise<RemoteEntry[]>;
  readFile(path: string): Promise<Buffer>;
  /** mtimeMs: if given, the remote modification time is set to it (SFTP; ignored by FTP). */
  writeFile(path: string, data: Buffer, mtimeMs?: number): Promise<void>;
  /**
   * Streams a local file to the server without loading it into memory. The data goes to a temporary
   * name first and replaces the target afterwards, so an interrupted upload never leaves a half file.
   */
  uploadFile(local: string, remote: string, opts?: TransferOptions): Promise<void>;
  /** Streams a remote file to a local path (temporary name first, then renamed). */
  downloadFile(remote: string, local: string, opts?: TransferOptions): Promise<void>;
  /** Sets Unix permissions (e.g. 0o755). */
  chmod(path: string, mode: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, isDirectory: boolean): Promise<void>;
  close(): Promise<void>;
}
