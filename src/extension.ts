import * as vscode from 'vscode';
import { t } from './l10n';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { loadServers, saveServers, configUri, passwordKey } from './config/config';
import { createClient } from './connection/factory';
import { expandHome } from './connection/sftpClient';
import { RemoteClient, RemoteEntry, ServerConfig } from './connection/types';
import { RemoteNode, RemoteTreeProvider } from './views/remoteTree';
import { TransferTracker, TransferSnapshot, fmtBytes, fmtDuration } from './progress';
import { fmtSize, CompareLayout, CompareNode, CompareTreeProvider, collectDiffItems, FileNode, ServerLabels, STATUS_ORDER, statusNames, summaryText } from './views/compareTree';
import { DiffDecorationProvider } from './views/diffDecorations';
import { compareTrees, DiffItem, DiffStatus, isDifference, Side } from './compare/compare';
import { log, initLog, showLog } from './log';
import { expandServer } from './config/envExpand';
import { parseMode, symbolicToOctal } from './connection/mode';
import { buildMatcher, searchTree } from './compare/search';
import { parseGitignore } from './compare/gitignore';
import { isTargetNewer, selectBySource, selectForDelete, TransferSource } from './compare/transfer';
import { backupPath, formatStamp, mapToRemote, safeLocalPath } from './connection/paths';
import { checkHostKey, HostKeyVerifier } from './connection/hostKey';
import { makeExcluder } from './compare/glob';
import { RemoteFileSystem, REMOTE_FS_SCHEME, remoteFsUri } from './fs/remoteFs';
import { openServerForm } from './views/serverForm';
import { applyHunk, computeHunks, splitLines } from './compare/hunks';
import { PendingData, PendingState } from './pending/pendingState';
import { PendingFileNode, PendingNode, PendingServerNode, PendingTreeProvider } from './views/pendingTree';
import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export function activate(ctx: vscode.ExtensionContext) {
  initLog(ctx);
  let servers: ServerConfig[] = [];
  let current: ServerConfig | undefined;
  const clients = new Map<string, RemoteClient>(); // one connection per server name

  const dropClient = async () => {
    for (const c of clients.values()) {
      try { await c.close(); } catch { /* ignore */ }
    }
    clients.clear();
  };

  /** SFTP host keys the user has accepted (kept in the extension's global state, not in the workspace). */
  const KNOWN_KEYS = 'knownHostKeys';
  const verifyHostKey: HostKeyVerifier = async (id, fingerprint) => {
    const known = ctx.globalState.get<Record<string, string>>(KNOWN_KEYS, {});
    const decision = checkHostKey(known, id, fingerprint);
    if (decision === 'trusted') return true;
    log(`Host key of ${id}: ${decision === 'new' ? 'unknown' : 'CHANGED'} (${fingerprint})`);
    const isNew = decision === 'new';
    const trust = isNew ? t('Trust') : t('Accept new key');
    const answer = await vscode.window.showWarningMessage(
      isNew ? t('Unknown server {0}', id) : t('WARNING: The host key of {0} has changed!', id),
      {
        modal: true,
        detail: isNew
          ? t('Fingerprint: {0}\n\nOnly trust it if the fingerprint matches your server.', fingerprint)
          : t('Previously known: {0}\nNow: {1}\n\nThis can be an attack (man-in-the-middle) or a reinstalled server. If in doubt, cancel.', known[id], fingerprint),
      },
      trust,
    );
    if (!answer) { log(`Host key of ${id} rejected.`); return false; }
    log(`Host key of ${id} accepted.`);
    await ctx.globalState.update(KNOWN_KEYS, { ...known, [id]: fingerprint });
    return true;
  };

  /** Keychain key per server name, computed from the RAW config so it matches what the form stores. */
  const secretKeys = new Map<string, string>();
  const secretKey = (server: ServerConfig) => secretKeys.get(server.name) ?? passwordKey(server);

  const AUTH_ERROR = /authentication|auth.*fail|All configured authentication methods failed|\b530\b|login (incorrect|failed)/i;

  const getClientFor = async (server: ServerConfig): Promise<RemoteClient | undefined> => {
    let client = clients.get(server.name);
    if (!client) {
      const stored = await ctx.secrets.get(secretKey(server));
      let pw = stored;
      if (pw === undefined && server.useAgent) pw = ''; // the SSH agent needs no password
      if (pw === undefined) {
        // Config written by hand: ask once and remember in the keychain.
        pw = await vscode.window.showInputBox({
          prompt: t('Password for {0}@{1} ({2})', server.username, server.host, server.name),
          password: true,
          ignoreFocusOut: true,
        });
        if (pw === undefined) return undefined;
      }
      // Jump host: password from the keychain or a prompt (not needed with a key or the agent).
      const jump = server.jumpHost;
      const jumpKey = jump ? passwordKey({ protocol: 'sftp', username: jump.username, host: jump.host }) : '';
      const jumpStored = jump ? await ctx.secrets.get(jumpKey) : undefined;
      let jumpPw = jumpStored ?? '';
      if (jump && jumpStored === undefined && !jump.useAgent && !jump.privateKeyPath) {
        const asked = await vscode.window.showInputBox({
          prompt: t('Password for jump host {0}@{1}', jump.username, jump.host),
          password: true,
          ignoreFocusOut: true,
        });
        if (asked === undefined) return undefined;
        jumpPw = asked;
      }
      log(`Connecting to ${server.name} (${server.protocol}://${server.host})${jump ? ` via jump host ${jump.host}` : ''} …`);
      try {
        client = await createClient(server, pw, verifyHostKey, jumpPw);
      } catch (e) {
        log(`Connection to ${server.name} failed: ${(e as Error).message}`);
        // A stored jump host password that no longer works: ask again once.
        if (jump && jumpStored !== undefined && !jump.useAgent && !jump.privateKeyPath
            && /^Jump host/.test((e as Error).message) && AUTH_ERROR.test((e as Error).message)) {
          const again = await vscode.window.showInputBox({
            prompt: t('Login to jump host {0} failed. Enter the password again', jump.host),
            password: true,
            ignoreFocusOut: true,
          });
          if (again === undefined) throw e;
          jumpPw = again;
          client = await createClient(server, pw, verifyHostKey, jumpPw);
          await ctx.secrets.store(jumpKey, jumpPw);
          log(`Connected to ${server.name} via jump host ${jump.host}.`);
          clients.set(server.name, client);
          await ctx.secrets.store(secretKey(server), pw);
          return client;
        }
        // A stored password that no longer works: ask again once instead of failing forever.
        if (stored === undefined || server.useAgent || !AUTH_ERROR.test((e as Error).message)) throw e;
        const again = await vscode.window.showInputBox({
          prompt: t('Login to {0} failed. Enter the password again', server.name),
          password: true,
          ignoreFocusOut: true,
        });
        if (again === undefined) throw e;
        pw = again;
        client = await createClient(server, pw, verifyHostKey);
      }
      log(`Connected to ${server.name}.`);
      if (jump && jumpPw && jumpStored === undefined) await ctx.secrets.store(jumpKey, jumpPw); // only after a successful login
      clients.set(server.name, client);
      await ctx.secrets.store(secretKey(server), pw); // only after a successful login
    }
    return client;
  };
  const getClient = async () => (current ? getClientFor(current) : undefined);

  const tree = new RemoteTreeProvider(getClient, () => current);
  const view = vscode.window.createTreeView('remoteHost.tree', { treeDataProvider: tree, showCollapseAll: true });
  ctx.subscriptions.push(view);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'remoteHost.selectServer';
  ctx.subscriptions.push(statusBar);

  /** Title, status bar and context keys follow the selected server. */
  const refreshUi = async () => {
    view.title = current ? `Remote Host: ${current.name}` : 'Remote Host';
    if (current) {
      statusBar.text = `$(server) ${current.name}${current.uploadOnSave ? ' $(cloud-upload)' : ''}`;
      statusBar.tooltip = `${current.protocol}://${current.username}@${current.host}${current.remotePath}\n${t('Click to switch server')}`
        + (current.uploadOnSave ? `\n${t('Upload on save is ON')}` : '');
      statusBar.show();
    } else statusBar.hide();
    await vscode.commands.executeCommand('setContext', 'remoteHost.hasServers', servers.length > 0);
    await vscode.commands.executeCommand('setContext', 'remoteHost.isSftp', current?.protocol === 'sftp');
  };

  const reload = async () => {
    // ${env:NAME} placeholders are resolved here only; the file (and the settings form) keep the raw text.
    secretKeys.clear();
    servers = (await loadServers()).map((raw) => {
      const { server, missing } = expandServer(raw);
      secretKeys.set(server.name, passwordKey(raw));
      if (missing.length) log(`Server ${server.name}: environment variable(s) not set: ${[...new Set(missing)].join(', ')}`);
      return server;
    });
    pendingState.prune(servers.map((sv) => sv.name));
    pendingChanged();
    if (!current || !servers.find((s) => s.name === current!.name)) current = servers[0];
    else current = servers.find((s) => s.name === current!.name); // pick up edited settings
    await refreshUi();
    await dropClient();
    for (const sv of servers) await loadGitignore(sv);
    tree.refresh();
  };

  const localRoot = () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root && current ? path.join(root, current.localPath) : undefined;
  };
  /** Remote path of a local file on the given server (default: the active one). */
  const toRemote = (localFile: string, server: ServerConfig | undefined = current) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root && server ? mapToRemote(server, root, localFile) : undefined;
  };
  /** Local path for a remote path of the active server; throws for unsafe names or paths outside the root. */
  const toLocal = (remote: string) => safeLocalPath(localRoot()!, path.posix.relative(current!.remotePath, remote));

  const run = <T>(title: string, fn: () => Promise<T>) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
      try { return await fn(); } catch (e) {
        log(`ERROR (${title}): ${(e as Error).message}`);
        vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
      }
    });

  /** Thrown inside an upload when the user pressed Cancel in the progress notification. */
  class TransferCancelled extends Error {}
  /** Tracker, report function and cancel token of one upload notification; each runUpload has its own, so parallel uploads do not mix. */
  interface UploadContext { tracker: TransferTracker; report: (force?: boolean) => void; token: vscode.CancellationToken }
  const transferContext = new AsyncLocalStorage<UploadContext>();
  interface UploadStats { bytes: number; ms: number; files: number; cancelled: boolean }

  const progressText = (s: TransferSnapshot) => [
    s.totalFiles > 1 ? `${s.fileNumber}/${s.totalFiles}` : '',
    s.name ? (s.fileSize > 0 ? `${s.name} (${fmtBytes(s.fileBytes)} / ${fmtBytes(s.fileSize)})` : s.name) : t('Preparing'),
    s.totalBytes > 0 ? `${Math.floor(s.percent)} %` : '',
    s.speed ? `${fmtBytes(s.speed)}/s` : '',
    s.etaSeconds !== undefined ? t('about {0} left', fmtDuration(s.etaSeconds)) : '',
  ].filter(Boolean).join(' · ');

  /** Counts the files (and bytes) uploadPath would transfer, so the progress knows its total up front. */
  async function scanUpload(local: string, remote: string, server: ServerConfig | undefined): Promise<{ files: number; bytes: number }> {
    let stat: vscode.FileStat;
    try { stat = await vscode.workspace.fs.stat(vscode.Uri.file(local)); } catch { return { files: 0, bytes: 0 }; }
    if (!(stat.type & vscode.FileType.Directory)) return { files: 1, bytes: stat.size };
    let files = 0; let bytes = 0;
    try {
      for (const [name] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(local))) {
        if (isExcluded(path.posix.join(remote, name), server)) continue;
        const sub = await scanUpload(path.join(local, name), path.posix.join(remote, name), server);
        files += sub.files; bytes += sub.bytes;
      }
    } catch { /* unreadable folder: counted as far as possible */ }
    return { files, bytes };
  }

  /**
   * Like run(), but for uploads: shows file x/y, current file, bytes, percent, speed and time left,
   * and has a Cancel button (takes effect between files). uploadPath feeds the tracker.
   */
  const runUpload = (
    title: string, jobs: { local: string; remote?: string }[], server: ServerConfig | undefined, fn: () => Promise<unknown>,
  ): Thenable<UploadStats> =>
    runTransfer(title, async () => {
      let files = 0; let bytes = 0;
      for (const j of jobs) {
        if (!j.remote) continue;
        const sc = await scanUpload(j.local, j.remote, server);
        files += sc.files; bytes += sc.bytes;
      }
      return { files, bytes };
    }, fn);

  /** Counts the files (and bytes) downloadEntry would transfer. */
  async function scanDownload(c: RemoteClient, e: RemoteEntry): Promise<{ files: number; bytes: number }> {
    if (!e.isDirectory) return { files: 1, bytes: e.size };
    let files = 0; let bytes = 0;
    try {
      for (const child of await c.list(e.path)) {
        if (isExcluded(child.path)) continue;
        const sub = await scanDownload(c, child);
        files += sub.files; bytes += sub.bytes;
      }
    } catch { /* unreadable folder: counted as far as possible */ }
    return { files, bytes };
  }

  /** Same progress notification as runUpload, for downloads. */
  const runDownload = (title: string, scan: () => Promise<{ files: number; bytes: number }>, fn: () => Promise<unknown>) =>
    runTransfer(title, scan, fn);

  /** Progress notification with a tracker for any transfer: scan gives the totals, fn does the work via uploadPath / downloadFileTo. */
  const runTransfer = (
    title: string, scan: () => Promise<{ files: number; bytes: number }>, fn: () => Promise<unknown>,
  ): Thenable<UploadStats> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const stats: UploadStats = { bytes: 0, ms: 0, files: 0, cancelled: false };
        progress.report({ message: t('Preparing') });
        const { files, bytes } = await scan();
        const tracker = new TransferTracker(files, bytes);
        let lastShown = 0; let lastPercent = 0;
        const report = (force?: boolean) => {
          const now = Date.now();
          if (!force && now - lastShown < 250) return; // do not flood the progress UI
          lastShown = now;
          const snap = tracker.snapshot();
          progress.report({ message: progressText(snap), increment: Math.max(0, snap.percent - lastPercent) });
          lastPercent = Math.max(lastPercent, snap.percent);
        };
        try { await transferContext.run({ tracker, report, token }, fn); } catch (e) {
          if (e instanceof TransferCancelled) {
            stats.cancelled = true;
            log(`Transfer cancelled after ${tracker.files} of ${files} file(s)`);
          } else {
            log(`ERROR (${title}): ${(e as Error).message}`);
            vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
          }
        }
        stats.bytes = tracker.bytes; stats.files = tracker.files; stats.ms = tracker.snapshot().elapsedMs;
        return stats;
      },
    );

  /** "Uploaded 3 item(s) to X (1.2 MB in 4 s)." or the cancelled variant. */
  const uploadSummary = (items: number, servers: string, bytes: number, ms: number, cancelled: boolean) =>
    cancelled
      ? t('Upload cancelled. {0} item(s) uploaded to {1} ({2}).', items, servers, fmtBytes(bytes))
      : t('Uploaded {0} item(s) to {1} ({2} in {3}).', items, servers, fmtBytes(bytes), fmtDuration(ms / 1000));

  /** Patterns from each server's .gitignore (only for servers with useGitignore). */
  const gitignorePatterns = new Map<string, string[]>();
  const loadGitignore = async (server: ServerConfig) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!server.useGitignore || !root) { gitignorePatterns.delete(server.name); return; }
    try {
      const file = vscode.Uri.file(path.join(root, server.localPath, '.gitignore'));
      const { patterns, unsupported, negations } = parseGitignore(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
      gitignorePatterns.set(server.name, patterns);
      log(`.gitignore for ${server.name}: ${patterns.length} patterns${unsupported ? `, ${unsupported} negation(s) not supported and ignored (files they re-include stay excluded): ${negations.slice(0, 10).join(' ')}` : ''}`);
    } catch {
      gitignorePatterns.delete(server.name); // no .gitignore in the local folder
    }
  };
  const effectiveExcludes = (server: ServerConfig | undefined): string[] =>
    server ? [...(server.exclude ?? []), ...(gitignorePatterns.get(server.name) ?? [])] : [];

  /** Writes a local file and, if known, gives it the remote modification time (so later compares skip it). */
  const writeLocal = async (local: string, data: Uint8Array, mtimeMs?: number) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
    await vscode.workspace.fs.writeFile(vscode.Uri.file(local), data);
    if (mtimeMs) { try { await fsp.utimes(local, mtimeMs / 1000, mtimeMs / 1000); } catch { /* best effort */ } }
  };

  /** Byte progress of the file currently being transferred by a bulk action (set by transferBatch). */
  let onBytes: ((bytes: number) => void) | undefined;

  /** Streams a remote file to disk (no full copy in memory) and logs it. */
  const downloadFileTo = async (c: RemoteClient, serverName: string | undefined, remote: string, local: string, mtimeMs?: number, size = 0) => {
    const ctx = transferContext.getStore();
    if (ctx?.token.isCancellationRequested) throw new TransferCancelled();
    let onProgress = onBytes;
    if (ctx) {
      ctx.tracker.startFile(path.posix.basename(remote), size);
      ctx.report(true);
      onProgress = (bytes) => { ctx.tracker.addBytes(bytes); ctx.report(); };
    }
    await c.downloadFile(remote, local, { mtimeMs, onProgress });
    if (ctx) { ctx.tracker.finishFile(); ctx.report(true); }
    log(`↓ ${serverName}: ${remote}`);
    await markSynced(servers.find((sv) => sv.name === serverName), local); // now equals that server
  };

  /** Stores a copy of data under .vscode/remote-host-backup (only if the server has the option on). */
  const saveBackup = async (
    server: ServerConfig | undefined, stamp: string, relPath: string,
    /** Lazy: the (possibly remote) file is only read when the backup option is on. */
    data: Uint8Array | (() => Promise<Uint8Array>),
  ) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!server?.backupBeforeOverwrite || !root) return;
    const target = backupPath(root, server.name, stamp, relPath);
    await writeLocal(target, typeof data === 'function' ? await data() : data);
    log(`Backup: ${target}`);
  };
  /** Backs up an existing local file before it is overwritten by a download. */
  const backupLocalFile = async (server: ServerConfig | undefined, stamp: string, relPath: string, local: string) => {
    if (!server?.backupBeforeOverwrite) return;
    let data: Uint8Array;
    try { data = await vscode.workspace.fs.readFile(vscode.Uri.file(local)); } catch { return; } // nothing to back up
    await saveBackup(server, stamp, relPath, data);
  };

  // ---- Pending uploads: which local files still have to go to which server ----
  const pendingState = new PendingState(ctx.workspaceState.get<PendingData>('pendingUploads'));
  let pendingTree: PendingTreeProvider | undefined;
  let pendingView: vscode.TreeView<PendingNode> | undefined;
  let pendingSaveTimer: NodeJS.Timeout | undefined;
  const pendingChanged = () => {
    pendingTree?.refresh();
    if (pendingView) {
      const total = pendingState.total();
      pendingView.badge = total ? { value: total, tooltip: t('{0} to upload', total) } : undefined;
    }
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = setTimeout(() => void ctx.workspaceState.update('pendingUploads', pendingState.toJSON()), 500);
  };
  const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  /** Workspace relative posix path, the key of a file in the pending lists. */
  const pendingKey = (fsPath: string) => {
    const root = workspaceRoot();
    if (!root) return undefined;
    const rel = path.relative(root, fsPath);
    return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel.split(path.sep).join('/');
  };
  /** sha1 of a local file; undefined for very large or unreadable files (those always count as changed). */
  const hashFile = async (fsPath: string): Promise<string | undefined> => {
    try {
      const st = await fsp.stat(fsPath);
      if (!st.isFile() || st.size > 50 * 1024 * 1024) return undefined;
      return createHash('sha1').update(await fsp.readFile(fsPath)).digest('hex');
    } catch { return undefined; }
  };
  /** The local file now equals the version on this server (after an upload or a download). */
  const markSynced = async (server: ServerConfig | undefined, fsPath: string) => {
    const rel = pendingKey(fsPath);
    if (!server || !rel) return;
    pendingState.markSynced(server.name, rel, await hashFile(fsPath));
    pendingChanged();
  };
  const PENDING_IGNORE = /(^|\/)(\.git|\.vscode\/remote-host-backup)(\/|$)|\.part(-\d+-\d+)?$/;
  /** A local file was created or changed (editor, other tool, AI): pending for every server that maps it. */
  const trackChange = async (fsPath: string) => {
    const rel = pendingKey(fsPath);
    if (!rel || PENDING_IGNORE.test(rel)) return;
    if (!(await fsp.stat(fsPath).then((st) => st.isFile(), () => false))) return; // folders and vanished files
    const targets = servers.filter((sv) => {
      const remote = toRemote(fsPath, sv);
      return !!remote && !isExcluded(remote, sv);
    });
    if (!targets.length) return;
    const hash = await hashFile(fsPath);
    for (const server of targets) pendingState.markChanged(server.name, rel, hash);
    pendingChanged();
  };

  let notifyRemoteChanged: (server: ServerConfig | undefined, remotePath: string) => void = () => undefined;

  async function uploadPath(c: RemoteClient, local: string, remote: string, server = current): Promise<void> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(local));
    if (stat.type & vscode.FileType.Directory) {
      await c.mkdir(remote);
      for (const [name] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(local))) {
        if (isExcluded(path.posix.join(remote, name), server)) continue;
        await uploadPath(c, path.join(local, name), path.posix.join(remote, name), server);
      }
    } else {
      const ctx = transferContext.getStore();
      if (ctx?.token.isCancellationRequested) throw new TransferCancelled();
      let onProgress = onBytes;
      if (ctx) {
        ctx.tracker.startFile(path.basename(local), stat.size);
        ctx.report(true);
        onProgress = (bytes) => { ctx.tracker.addBytes(bytes); ctx.report(); };
      }
      await c.uploadFile(local, remote, { mtimeMs: stat.mtime, onProgress });
      if (ctx) { ctx.tracker.finishFile(); ctx.report(true); }
      log(`↑ ${server?.name}: ${remote}`);
      notifyRemoteChanged(server, remote);
      await markSynced(server, local);
    }
  }

  async function downloadEntry(c: RemoteClient, e: RemoteEntry): Promise<void> {
    const local = toLocal(e.path);
    if (e.isDirectory) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(local));
      for (const child of await c.list(e.path)) {
        if (!isExcluded(child.path)) await downloadEntry(c, child);
      }
    } else {
      await downloadFileTo(c, current?.name, e.path, local, e.mtime, e.size);
    }
  }

  /** Exclude patterns of a server (default: the active one), applied to a remote path. */
  function isExcluded(remotePath: string, server = current): boolean {
    if (!server) return false;
    const rel = path.posix.relative(server.remotePath, remotePath);
    return makeExcluder(effectiveExcludes(server))(rel, path.posix.basename(remotePath));
  }

  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('remoteHost.showLog', () => showLog());

  reg('remoteHost.forgetHostKeys', async () => {
    await ctx.globalState.update(KNOWN_KEYS, {});
    await dropClient();
    vscode.window.showInformationMessage(t('Saved SFTP host keys were deleted. You will be asked again on the next connection.'));
  });

  reg('remoteHost.openConfig', async () => {
    const uri = configUri();
    if (!uri) return vscode.window.showWarningMessage(t('Open a workspace folder first.'));
    if (!(await loadServers()).length) await saveServers([]);
    vscode.window.showTextDocument(uri);
  });

  reg('remoteHost.addServer', async () => {
    const ask = (prompt: string, value?: string, password = false) =>
      vscode.window.showInputBox({ prompt, value, password, ignoreFocusOut: true });
    const name = await ask(t('Server name (e.g. Test, Live)')); if (!name) return;
    const protocol = (await vscode.window.showQuickPick(['sftp', 'ftp', 'ftps'], { placeHolder: t('Protocol') })) as ServerConfig['protocol'];
    if (!protocol) return;
    const host = await ask(t('Host')); if (!host) return;
    const username = await ask(t('Username')); if (username === undefined) return;
    const password = await ask(t('Password (stored in the system keychain)'), '', true); if (password === undefined) return;
    const remotePath = await ask(t('Remote root path'), '/'); if (!remotePath) return;
    const localPath = await ask(t('Local folder relative to workspace'), '.'); if (!localPath) return;
    const cfg: ServerConfig = { name, protocol, host, username, remotePath, localPath, exclude: ['.git', 'node_modules'] };
    await ctx.secrets.store(passwordKey(cfg), password);
    await saveServers([...(await loadServers()), cfg]);
    current = cfg;
    await reload();
  });

  reg('remoteHost.selectServer', async () => {
    const pick = await vscode.window.showQuickPick(servers.map((s) => s.name), { placeHolder: t('Select server') });
    if (!pick) return;
    current = servers.find((s) => s.name === pick);
    await refreshUi();
    tree.refresh();
  });

  reg('remoteHost.refresh', () => tree.refresh());

  /**
   * Uploads and comparisons read the file from disk. Unsaved editors would silently be left out, so the
   * user is asked to save them first. Returns false if the action should be cancelled.
   */
  const ensureSaved = async (files?: string[]): Promise<boolean> => {
    const wanted = files?.map((f) => path.normalize(f));
    const dirty = vscode.workspace.textDocuments.filter((d) =>
      d.isDirty && d.uri.scheme === 'file'
      && (!wanted || wanted.some((f) => { const p = path.normalize(d.uri.fsPath); return p === f || p.startsWith(f + path.sep); })));
    if (!dirty.length) return true;
    const save = t('Save and continue');
    const skip = t('Continue without saving');
    const names = dirty.slice(0, 5).map((d) => path.basename(d.uri.fsPath)).join(', ') + (dirty.length > 5 ? ', …' : '');
    const pick = await vscode.window.showWarningMessage(
      t('Unsaved changes are not included: {0}', names), { modal: true }, save, skip);
    if (pick === save) { for (const d of dirty) await d.save(); return true; }
    return pick === skip;
  };

  /** Which servers to upload to. With several servers configured the user chooses (active server first). */
  const pickUploadServers = async (): Promise<ServerConfig[]> => {
    if (servers.length <= 1) return current ? [current] : [];
    const items = [...servers]
      .sort((x, y) => Number(y.name === current?.name) - Number(x.name === current?.name))
      .map((sv) => ({
        label: sv.name,
        description: sv.name === current?.name ? t('active') : undefined,
        detail: `${sv.protocol}://${sv.host}${sv.remotePath}`,
        picked: sv.name === current?.name,
        sv,
      }));
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: t('Upload to which server? (several possible)'),
      ignoreFocusOut: true,
    });
    return picks?.map((p) => p.sv) ?? [];
  };

  reg('remoteHost.upload', async (arg?: RemoteNode | vscode.Uri, selected?: vscode.Uri[]) => {
    if (arg instanceof RemoteNode) {
      // Remote tree: the node belongs to the active server.
      const c = await getClient(); if (!c || !current) return;
      const remote = arg.entry.path; const local = toLocal(remote);
      await runUpload(t('Uploading {0}', path.basename(local)), [{ local, remote }], current, () => uploadPath(c, local, remote));
      tree.refresh();
      return;
    }
    // Explorer / editor: several files may be selected, and the target server is chosen here.
    const uris = selected?.length ? selected : [arg ?? vscode.window.activeTextEditor?.document.uri].filter(
      (u): u is vscode.Uri => !!u);
    if (!uris.length) return;
    if (!(await ensureSaved(uris.map((u) => u.fsPath)))) return;
    const targets = await pickUploadServers();
    if (!targets.length) return;
    let uploaded = 0; let totalBytes = 0; let totalMs = 0; let cancelled = false;
    for (const server of targets) {
      const c = await getClientFor(server);
      if (!c) { vscode.window.showWarningMessage(t('No connection to "{0}".', server.name)); continue; }
      const jobs = uris.map((u) => ({ local: u.fsPath, remote: toRemote(u.fsPath, server) }));
      const outside = jobs.filter((j) => !j.remote).length;
      if (outside) vscode.window.showWarningMessage(
        t('{0} file(s) are outside the local folder of "{1}" and were skipped.', outside, server.name));
      const what = jobs.length === 1 ? path.basename(jobs[0].local) : t('{0} items', jobs.length);
      const res = await runUpload(t('Uploading {0} to {1}', what, server.name), jobs, server, async () => {
        for (const j of jobs) {
          if (!j.remote) continue;
          if (!(await vscode.workspace.fs.stat(vscode.Uri.file(j.local)).then((st) => st.type & vscode.FileType.Directory, () => 0))) {
            await c.mkdir(path.posix.dirname(j.remote));
          }
          await uploadPath(c, j.local, j.remote, server);
          uploaded++;
        }
      });
      totalBytes += res.bytes; totalMs += res.ms;
      if (res.cancelled) { cancelled = true; break; }
    }
    if (uploaded || cancelled) vscode.window.showInformationMessage(
      uploadSummary(uploaded, targets.map((sv) => sv.name).join(', '), totalBytes, totalMs, cancelled));
    tree.refresh();
  });

  reg('remoteHost.download', async (node: RemoteNode) => {
    const c = await getClient(); if (!c || !node) return;
    const res = await runDownload(t('Downloading {0}', node.entry.name), () => scanDownload(c, node.entry), () => downloadEntry(c, node.entry));
    if (res.cancelled) vscode.window.showInformationMessage(t('Download cancelled. {0} file(s) downloaded ({1}).', res.files, fmtBytes(res.bytes)));
  });

  reg('remoteHost.newFile', async (node: RemoteNode) => {
    const name = await vscode.window.showInputBox({ prompt: t('New file name') });
    const c = await getClient(); if (!name || !c) return;
    await run(t('Creating file'), () => c.writeFile(path.posix.join(node.entry.path, name), Buffer.alloc(0)));
    tree.refresh();
  });

  reg('remoteHost.newFolder', async (node: RemoteNode) => {
    const name = await vscode.window.showInputBox({ prompt: t('New folder name') });
    const c = await getClient(); if (!name || !c) return;
    await run(t('Creating folder'), () => c.mkdir(path.posix.join(node.entry.path, name)));
    tree.refresh();
  });

  reg('remoteHost.rename', async (node: RemoteNode) => {
    const name = await vscode.window.showInputBox({ prompt: t('New name'), value: node.entry.name });
    const c = await getClient(); if (!name || !c || name === node.entry.name) return;
    await run(t('Renaming'), () => c.rename(node.entry.path, path.posix.join(path.posix.dirname(node.entry.path), name)));
    tree.refresh();
  });

  reg('remoteHost.delete', async (node: RemoteNode) => {
    const deleteLabel = t('Delete');
    const ok = await vscode.window.showWarningMessage(
      t('Delete {0} on {1}?', node.entry.path, current?.name ?? ''), { modal: true }, deleteLabel);
    const c = await getClient(); if (ok !== deleteLabel || !c) return;
    await run(t('Deleting'), () => c.remove(node.entry.path, node.entry.isDirectory));
    tree.refresh();
  });

  reg('remoteHost.chmod', async (node: RemoteNode) => {
    const c = await getClient(); if (!c || !node) return;
    const input = await vscode.window.showInputBox({
      prompt: t('Permissions for {0} (octal, e.g. 644 or 755)', node.entry.name),
      value: symbolicToOctal(node.entry.permissions) ?? '',
      validateInput: (v) => (parseMode(v) === undefined ? t('Enter 3 or 4 octal digits, e.g. 644') : undefined),
    });
    const mode = input === undefined ? undefined : parseMode(input);
    if (mode === undefined) return;
    await run(`chmod ${mode.toString(8)} ${node.entry.name}`, async () => {
      await c.chmod(node.entry.path, mode);
      log(`chmod ${mode.toString(8)} ${current?.name}: ${node.entry.path}`);
    });
    tree.refresh();
  });

  reg('remoteHost.searchRemote', async (node?: RemoteNode) => {
    const c = await getClient(); if (!c || !current) return;
    const server = current;
    const root = node?.entry.isDirectory ? node.entry.path : server.remotePath;
    const query = await vscode.window.showInputBox({
      prompt: t('Search in {0} (text or pattern like *.php)', root),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : t('Enter a search text')),
    });
    if (!query?.trim()) return;
    await loadGitignore(server);
    const limit = 500;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Searching on {0}', server.name), cancellable: true },
      (progress, token) => searchTree((d) => c.list(d), root, buildMatcher(query), {
        limit,
        exclude: effectiveExcludes(server),
        isCancelled: () => token.isCancellationRequested,
        onFolder: (d) => progress.report({ message: d }),
      }),
    );
    log(`Search "${query}" in ${server.name}:${root}: ${result.hits.length} hits, ${result.folders} folders, ${result.unreadable} unreadable${result.truncated ? ', truncated' : ''}${result.cancelled ? ', cancelled' : ''}`);
    if (!result.hits.length) {
      vscode.window.showInformationMessage(t('No matches for "{0}" ({1} folders searched).', query, result.folders));
      return;
    }
    const notes = [
      t('{0} match(es)', result.hits.length),
      result.truncated ? t('limit of {0} reached, refine the search', limit) : '',
      result.unreadable ? t('{0} folder(s) unreadable', result.unreadable) : '',
      result.cancelled ? t('search cancelled') : '',
    ].filter(Boolean).join(' · ');
    const pick = await vscode.window.showQuickPick(
      result.hits.map((e) => ({
        label: `${e.isDirectory ? '$(folder)' : '$(file)'} ${e.name}`,
        description: path.posix.relative(root, path.posix.dirname(e.path)) || '.',
        detail: `${e.isDirectory ? '' : `${fmtSize(e.size)} · `}${new Date(e.mtime).toLocaleString()}`,
        entry: e,
      })),
      { placeHolder: notes, matchOnDescription: true },
    );
    if (!pick) return;
    if (pick.entry.isDirectory) {
      await vscode.commands.executeCommand('remoteHost.tree.focus');
      await view.reveal(new RemoteNode(pick.entry), { select: true, focus: true, expand: true });
    } else {
      await vscode.window.showTextDocument(remoteFsUri(server.name, pick.entry.path));
    }
  });

  reg('remoteHost.copyPath', (node: RemoteNode) => vscode.env.clipboard.writeText(node.entry.path));

  // ---- Compare / Sync with Local ----
  const compareTree = new CompareTreeProvider();
  const compareView = vscode.window.createTreeView('remoteHost.compare', {
    treeDataProvider: compareTree,
    showCollapseAll: true,
    canSelectMany: true,
  });
  ctx.subscriptions.push(compareView);
  // Restore layout + status filter from the last session.
  compareTree.layout = ctx.workspaceState.get<CompareLayout>('compareLayout', 'tree');
  // 'unchanged' is hidden by default; the filter can show it.
  compareTree.hidden = new Set(ctx.workspaceState.get<DiffStatus[]>('compareHiddenStatuses', ['unchanged']));
  /** True if the last comparison was cancelled, i.e. the result is only partial. */
  let compareIncomplete = false;
  const diffDecorations = new DiffDecorationProvider();
  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider(diffDecorations));
  const refreshCompareView = () =>
    updateCompareView(compareTree.items, serverCompare && { a: serverCompare.a.name, b: serverCompare.b.name });
  const updateCompareView = (items: DiffItem[], labels?: ServerLabels) => {
    const diffs = items.filter((i) => isDifference(i.status));
    compareView.badge = diffs.length
      ? { value: diffs.length, tooltip: t('{0} differences', diffs.length) } : undefined;
    const visible = compareTree.visibleItems;
    const shownDiffs = visible.filter((i) => isDifference(i.status)).length;
    const shownSame = visible.length - shownDiffs;
    let msg = diffs.length ? summaryText(items, labels) : undefined;
    if (msg && shownDiffs !== diffs.length) msg += ` — ${t('Filter active: {0} of {1} visible', shownDiffs, diffs.length)}`;
    if (msg && shownSame) msg += ` · ${t('incl. {0} unchanged', shownSame)}`;
    if (compareIncomplete) msg = `${msg ?? ''} — ${t('INCOMPLETE (comparison cancelled)')}`.trimStart();
    compareView.message = msg;
    diffDecorations.refresh();
  };
  let compareRemoteRoot = '';

  // Active server-to-server comparison (undefined = local <-> current server).
  let serverCompare: { a: ServerConfig; b: ServerConfig; aRoot: string; bRoot: string } | undefined;

  // Serves remote file content (read-only views): remotehost:/<remote path>?<server name>
  const remoteContentChanged = new vscode.EventEmitter<vscode.Uri>();
  ctx.subscriptions.push(
    remoteContentChanged,
    vscode.workspace.registerTextDocumentContentProvider('remotehost', {
      onDidChange: remoteContentChanged.event,
      async provideTextDocumentContent(uri) {
        const server = servers.find((s) => s.name === uri.query) ?? current;
        const c = server ? await getClientFor(server) : undefined;
        if (!c) throw new Error(t('No connection to "{0}".', server?.name ?? uri.query));
        try {
          return (await c.readFile(uri.path)).toString('utf8');
        } catch (e) {
          // Surface the real error instead of showing the file as empty.
          throw new Error(t('Remote file could not be read: {0}', (e as Error).message));
        }
      },
    }),
  );
  const remoteUri = (p: string, server: ServerConfig | undefined = current) =>
    vscode.Uri.from({ scheme: 'remotehost', path: p, query: server?.name ?? '' });
  /** Opened diffs and editors must not keep showing the old server version after a transfer. */
  notifyRemoteChanged = (server, remotePath) => {
    if (!server) return;
    remoteContentChanged.fire(remoteUri(remotePath, server));
    remoteFs.notifyChanged(server.name, remotePath);
  };

  const localSide: Side = {
    async list(dir) {
      const out = [];
      for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))) {
        try {
          const st = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, name)));
          out.push({ name, isDirectory: !!(type & vscode.FileType.Directory), size: st.size, mtime: st.mtime });
        } catch (e) {
          // e.g. a broken symlink: skip this entry instead of failing the whole folder
          log(`Skipped (unreadable): ${path.join(dir, name)}: ${(e as Error).message}`);
        }
      }
      return out;
    },
    async read(p) {
      return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(p)));
    },
  };
  const remoteSide = (c: RemoteClient): Side => ({
    async list(dir) {
      return (await c.list(dir)).map((e) => ({ name: e.name, isDirectory: e.isDirectory, size: e.size, mtime: e.mtime }));
    },
    read: (p) => c.readFile(p),
  });

  reg('remoteHost.compareFolder', async (arg?: RemoteNode | vscode.Uri) => {
    const c = await getClient();
    if (!c || !current) return;
    if (!localRoot()) return vscode.window.showWarningMessage(t('Open a workspace folder first.'));
    let remote: string;
    let local: string;
    if (arg instanceof vscode.Uri) {
      const mapped = toRemote(arg.fsPath);
      if (!mapped) return vscode.window.showWarningMessage(t('Folder is outside the mapped local folder.'));
      remote = mapped;
      local = arg.fsPath;
    } else {
      remote = arg?.entry.isDirectory ? arg.entry.path : current.remotePath;
      local = toLocal(remote);
    }
    if (!(await ensureSaved([local]))) return;
    await loadGitignore(current); // pick up .gitignore edits since the last compare
    let cancelled = false;
    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Comparing with {0}', current.name), cancellable: true },
      async (progress, token) => {
        try {
          const result = await compareTrees(localSide, remoteSide(c), local, remote, {
            includeUnchanged: true,
            exclude: effectiveExcludes(current),
            excludeBase: path.posix.relative(current!.remotePath, remote),
            ignoreLineEndings: current!.ignoreLineEndings,
            mtimeToleranceMs: current!.protocol === 'sftp' ? 2000 : 120000,
            isCancelled: () => token.isCancellationRequested,
            onProgress: (p) => progress.report({ message: p }),
          });
          cancelled = token.isCancellationRequested;
          return result;
        } catch (e) {
          vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
          return undefined;
        }
      },
    );
    if (!items) return;
    compareIncomplete = cancelled;
    if (cancelled) vscode.window.showWarningMessage(t('Comparison cancelled: the result is incomplete.'));
    log(`Comparison local ↔ ${current.name}: ${summaryText(items) || 'no differences'}${cancelled ? ' (cancelled)' : ''}`);
    compareRemoteRoot = remote;
    serverCompare = undefined;
    compareTree.setItems(items);
    updateCompareView(items);
    compareView.title = t('Differences: {0} ({1})', current.name, items.filter((i) => isDifference(i.status)).length);
    if (!items.some((i) => isDifference(i.status))) vscode.window.showInformationMessage(t('No differences with {0}.', current.name));
    else await vscode.commands.executeCommand('remoteHost.compare.focus');
  });

  reg('remoteHost.compareFile', async (arg?: RemoteNode | vscode.Uri) => {
    if (!current) return;
    let remote: string | undefined;
    let local: string;
    if (arg instanceof RemoteNode) {
      remote = arg.entry.path;
      local = toLocal(remote);
    } else {
      local = (arg ?? vscode.window.activeTextEditor?.document.uri)?.fsPath ?? '';
      remote = toRemote(local);
    }
    if (!local || !remote) return vscode.window.showWarningMessage(t('File is outside the mapped local folder.'));
    // The diff shows the editor content, so unsaved changes are visible there; no save prompt needed.
    await openDiff(vscode.Uri.file(local), remoteFsUri(current.name, remote),
      `${path.basename(local)} (local) ↔ ${current.name} (remote)`);
  });

  const itemPaths = (n: FileNode) => ({
    local: safeLocalPath(toLocal(compareRemoteRoot), compareRel(n)),
    remote: path.posix.join(compareRemoteRoot, compareRel(n)),
  });
  // relPath is relative to the compared folder
  const compareRel = (n: FileNode) => n.item.relPath;

  // ---- Server <-> Server comparison (e.g. Test vs. Live) ----
  const localFor = (server: ServerConfig, root: string, rel: string) => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return undefined;
    const base = path.join(ws, server.localPath, ...path.posix.relative(server.remotePath, root).split('/'));
    return safeLocalPath(base, rel);
  };

  reg('remoteHost.compareServers', async (node?: RemoteNode) => {
    if (servers.length < 2) return vscode.window.showWarningMessage(t('Configure at least two servers to compare them.'));
    const pick = async (placeHolder: string, exclude?: string) => {
      const name = await vscode.window.showQuickPick(
        servers.filter((s) => s.name !== exclude).map((s) => s.name), { placeHolder });
      return servers.find((s) => s.name === name);
    };
    const a = node && current ? current : await pick(t('Server A (e.g. Test)'));
    if (!a) return;
    const b = await pick(t('Compare {0} with ... (Server B, e.g. Live)', a.name), a.name);
    if (!b) return;
    // Folder relative to each server's remote root (whole tree unless started from a folder).
    const rel = node?.entry.isDirectory ? path.posix.relative(a.remotePath, node.entry.path) : '';
    const aRoot = path.posix.join(a.remotePath, rel);
    const bRoot = path.posix.join(b.remotePath, rel);
    const [ca, cb] = [await getClientFor(a), await getClientFor(b)];
    if (!ca || !cb) return;
    await loadGitignore(a); await loadGitignore(b);
    let cancelled = false;
    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Comparing {0} with {1}', a.name, b.name), cancellable: true },
      async (progress, token) => {
        try {
          const result = await compareTrees(remoteSide(ca), remoteSide(cb), aRoot, bRoot, {
            includeUnchanged: true,
            exclude: [...new Set([...effectiveExcludes(a), ...effectiveExcludes(b)])],
            excludeBase: rel,
            ignoreLineEndings: a.ignoreLineEndings || b.ignoreLineEndings,
            mtimeToleranceMs: Math.max(a.protocol === 'sftp' ? 2000 : 120000, b.protocol === 'sftp' ? 2000 : 120000),
            isCancelled: () => token.isCancellationRequested,
            onProgress: (p) => progress.report({ message: p }),
          });
          cancelled = token.isCancellationRequested;
          return result;
        } catch (e) {
          vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
          return undefined;
        }
      },
    );
    if (!items) return;
    compareIncomplete = cancelled;
    if (cancelled) vscode.window.showWarningMessage(t('Comparison cancelled: the result is incomplete.'));
    serverCompare = { a, b, aRoot, bRoot };
    log(`Comparison ${a.name} ↔ ${b.name}: ${summaryText(items, { a: a.name, b: b.name }) || 'no differences'}${cancelled ? ' (cancelled)' : ''}`);
    compareTree.setItems(items, { a: a.name, b: b.name });
    updateCompareView(items, { a: a.name, b: b.name });
    compareView.title = `${a.name} ↔ ${b.name} (${items.filter((i) => isDifference(i.status)).length})`;
    if (!items.some((i) => isDifference(i.status))) vscode.window.showInformationMessage(t('No differences between {0} and {1}.', a.name, b.name));
    else await vscode.commands.executeCommand('remoteHost.compare.focus');
  });

  const downloadFrom = async (n: FileNode, side: 'a' | 'b') => {
    if (!serverCompare) return;
    const server = serverCompare[side];
    const root = side === 'a' ? serverCompare.aRoot : serverCompare.bRoot;
    const exists = side === 'a' ? n.item.status !== 'remoteOnly' : n.item.status !== 'localOnly';
    if (!exists) return vscode.window.showWarningMessage(t('File does not exist on {0}.', server.name));
    const c = await getClientFor(server);
    const local = localFor(server, root, n.item.relPath);
    if (!c || !local) return;
    const info = side === 'a' ? n.item.local : n.item.remote;
    const res = await runDownload(t('Downloading from {0}', server.name), async () => ({ files: 1, bytes: info?.size ?? 0 }), async () => {
      await downloadFileTo(c, server.name, path.posix.join(root, n.item.relPath), local, info?.mtime, info?.size);
    });
    if (!res.cancelled) vscode.window.showInformationMessage(t('Saved to {0}', local));
  };
  reg('remoteHost.downloadFromA', (n: FileNode) => downloadFrom(n, 'a'));
  reg('remoteHost.downloadFromB', (n: FileNode) => downloadFrom(n, 'b'));

  const warnConflict = (n: FileNode) =>
    vscode.window.showWarningMessage(
      t('Type conflict at "{0}": a file on one side, a folder on the other. Please resolve manually.', n.item.relPath));


  // ---- Diff with editable server side: copy single blocks in both directions ----
  // Right side = remotefs: (editable, saving uploads). Pairs: right document -> left document.
  const diffPairs = new Map<string, vscode.Uri>();
  const lensChanged = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(lensChanged, vscode.workspace.onDidChangeTextDocument((e) => {
    if (diffPairs.has(e.document.uri.toString()) || [...diffPairs.values()].some((u) => u.toString() === e.document.uri.toString())) lensChanged.fire();
  }));

  /** Opens "left ↔ right" with the right side editable (local file left, server file right). */
  const openDiff = async (left: vscode.Uri, right: vscode.Uri, title: string) => {
    diffPairs.set(right.toString(), left);
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
  };

  const docText = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();

  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: REMOTE_FS_SCHEME }, {
    onDidChangeCodeLenses: lensChanged.event,
    async provideCodeLenses(doc) {
      const left = diffPairs.get(doc.uri.toString());
      if (!left) return [];
      let leftText: string;
      try { leftText = await docText(left); } catch { return []; }
      const hunks = computeHunks(splitLines(leftText), splitLines(doc.getText()));
      const lenses: vscode.CodeLens[] = [];
      for (const h of hunks) {
        const line = Math.min(h.bStart, Math.max(doc.lineCount - 1, 0));
        const range = new vscode.Range(line, 0, line, 0);
        lenses.push(
          new vscode.CodeLens(range, { title: `← ${t('Copy block to left side')}`, command: 'remoteHost.copyBlock', arguments: [doc.uri, h, 'left'] }),
          new vscode.CodeLens(range, { title: `${t('Copy block to right side')} →`, command: 'remoteHost.copyBlock', arguments: [doc.uri, h, 'right'] }),
        );
      }
      return lenses;
    },
  }));

  /** Replaces the whole text of a document, keeping its line ending style and trailing newline. */
  const setLines = async (doc: vscode.TextDocument, lines: string[]) => {
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const text = doc.getText();
    const trailing = /[\r\n]$/.test(text) || text === '';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), lines.join(eol) + (lines.length && trailing ? eol : ''));
    await vscode.workspace.applyEdit(edit);
  };

  reg('remoteHost.copyBlock', async (rightUri: vscode.Uri, h: { aStart: number; aEnd: number; bStart: number; bEnd: number }, dir: 'left' | 'right') => {
    const leftUri = diffPairs.get(rightUri.toString());
    if (!leftUri) return;
    const leftDoc = await vscode.workspace.openTextDocument(leftUri);
    const rightDoc = await vscode.workspace.openTextDocument(rightUri);
    const a = splitLines(leftDoc.getText());
    const b = splitLines(rightDoc.getText());
    // The hunk was computed for the texts at that time; recompute if something changed since.
    const fresh = computeHunks(a, b).find((x) => x.aStart === h.aStart && x.aEnd === h.aEnd && x.bStart === h.bStart && x.bEnd === h.bEnd);
    if (!fresh) return vscode.window.showWarningMessage(t('The block changed in the meantime. Please try again.'));
    if (dir === 'left') await setLines(leftDoc, applyHunk(a, b, fresh));
    else await setLines(rightDoc, applyHunk(b, a, { aStart: fresh.bStart, aEnd: fresh.bEnd, bStart: fresh.aStart, bEnd: fresh.aEnd }));
    lensChanged.fire();
  });

  // ---- Pending uploads view ----
  pendingTree = new PendingTreeProvider(() => pendingState, () => servers, workspaceRoot);
  pendingView = vscode.window.createTreeView('remoteHost.pending', {
    treeDataProvider: pendingTree, showCollapseAll: true, canSelectMany: true,
  });
  ctx.subscriptions.push(pendingView);

  // Every change on disk counts (own editor, other programs, AI tools); events are batched.
  const changedFiles = new Set<string>();
  let changeTimer: NodeJS.Timeout | undefined;
  const queueChange = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return;
    changedFiles.add(uri.fsPath);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      const batch = [...changedFiles]; changedFiles.clear();
      for (const f of batch) await trackChange(f).catch((e) => log(`Pending tracking failed for ${f}: ${(e as Error).message}`));
    }, 300);
  };
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  fileWatcher.onDidCreate(queueChange);
  fileWatcher.onDidChange(queueChange);
  fileWatcher.onDidDelete((uri) => {
    const rel = pendingKey(uri.fsPath);
    if (!rel) return;
    pendingState.removeEverywhere(rel);
    pendingChanged();
  });
  ctx.subscriptions.push(fileWatcher, vscode.workspace.onDidSaveTextDocument((d) => queueChange(d.uri)),
    { dispose: () => { clearTimeout(changeTimer); clearTimeout(pendingSaveTimer); void ctx.workspaceState.update('pendingUploads', pendingState.toJSON()); } });
  pendingChanged();

  /** Uploads local files of one server (pending list entries or the explorer selection); marks them done there only. */
  const uploadPending = async (server: ServerConfig, rels: string[]) => {
    const root = workspaceRoot();
    if (!root || !rels.length) return;
    const files = rels.map((rel) => path.join(root, ...rel.split('/')));
    if (!(await ensureSaved(files))) return;
    const c = await getClientFor(server);
    if (!c) return vscode.window.showWarningMessage(t('No connection to "{0}".', server.name));
    let done = 0;
    const res = await runUpload(t('Uploading {0} to {1}', rels.length === 1 ? path.posix.basename(rels[0]) : t('{0} items', rels.length), server.name),
      files.map((local) => ({ local, remote: toRemote(local, server) })), server, async () => {
      for (const [i, local] of files.entries()) {
        const remote = toRemote(local, server);
        if (!remote) continue;
        if (!(await fsp.stat(local).then(() => true, () => false))) { pendingState.removeEverywhere(rels[i]); continue; } // deleted meanwhile
        await c.mkdir(path.posix.dirname(remote));
        await uploadPath(c, local, remote, server);
        done++;
      }
    });
    pendingChanged();
    if (done || res.cancelled) vscode.window.showInformationMessage(
      uploadSummary(done, server.name, res.bytes, res.ms, res.cancelled));
  };

  const selectedFileNodes = (node?: PendingNode, nodes?: PendingNode[]) =>
    (nodes?.length ? nodes : node ? [node] : []).filter((n): n is PendingFileNode => n instanceof PendingFileNode);

  reg('remoteHost.pending.uploadFile', async (node?: PendingNode, nodes?: PendingNode[]) => {
    const files = selectedFileNodes(node, nodes);
    for (const server of new Set(files.map((f) => f.server))) {
      await uploadPending(server, files.filter((f) => f.server === server).map((f) => f.rel));
    }
  });

  reg('remoteHost.pending.uploadAll', async (node?: PendingServerNode) => {
    if (!node) return;
    const rels = pendingState.list(node.server.name);
    if (!rels.length) return vscode.window.showInformationMessage(t('Nothing to upload to {0}.', node.server.name));
    const upload = t('Upload');
    if ((await vscode.window.showWarningMessage(
      t('Upload {0} file(s) to {1}?', rels.length, node.server.name), { modal: true }, upload)) !== upload) return;
    await uploadPending(node.server, rels);
  });

  reg('remoteHost.pending.dismiss', (node?: PendingNode, nodes?: PendingNode[]) => {
    for (const f of selectedFileNodes(node, nodes)) pendingState.dismiss(f.server.name, f.rel);
    pendingChanged();
  });

  reg('remoteHost.pending.open', async (node?: PendingFileNode) => {
    if (!node) return;
    const remote = toRemote(node.local.fsPath, node.server);
    if (!remote) return;
    const c = await getClientFor(node.server);
    const exists = c ? await c.list(path.posix.dirname(remote)).then(
      (es) => es.some((e) => e.name === path.posix.basename(remote)), () => false) : false;
    if (exists) await openDiff(node.local, remoteFsUri(node.server.name, remote), `${path.basename(node.local.fsPath)} (local) ↔ ${node.server.name} (remote)`);
    else await vscode.window.showTextDocument(node.local, { preview: true }); // new file: not on the server yet
  });

  /** Replaces the lists by a real comparison with the server(s): finds older differences and outside changes. */
  reg('remoteHost.pending.reconcile', async (node?: { server: ServerConfig }) => {
    const targets = node ? [node.server] : servers;
    const root = workspaceRoot();
    if (!root || !targets.length) return;
    if (!(await ensureSaved())) return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('Comparing with the server'), cancellable: true },
      async (progress, token) => {
        for (const server of targets) {
          const c = await getClientFor(server);
          if (!c) continue;
          progress.report({ message: server.name });
          await loadGitignore(server);
          try {
            const items = await compareTrees(localSide, remoteSide(c), path.join(root, server.localPath), server.remotePath, {
              exclude: effectiveExcludes(server),
              ignoreLineEndings: server.ignoreLineEndings,
              mtimeToleranceMs: server.protocol === 'sftp' ? 2000 : 120000,
              isCancelled: () => token.isCancellationRequested,
              onProgress: (p) => progress.report({ message: `${server.name}: ${p}` }),
            });
            if (token.isCancellationRequested) return;
            const base = server.localPath.split(path.sep).join('/');
            pendingState.reconcile(server.name, items
              .filter((i) => i.status === 'modified' || i.status === 'localOnly')
              .map((i) => path.posix.normalize(path.posix.join(base, i.relPath))));
            log(`Pending uploads for ${server.name}: ${pendingState.count(server.name)}`);
          } catch (e) {
            vscode.window.showErrorMessage(`Remote Host: ${server.name}: ${(e as Error).message}`);
          }
        }
        pendingChanged();
      },
    );
  });

  /** Keyboard shortcut in the explorer: shortcuts do not receive the selection, so it is read via "Copy Path". */
  reg('remoteHost.uploadSelection', async () => {
    const previous = await vscode.env.clipboard.readText();
    let paths: string[] = [];
    try {
      await vscode.commands.executeCommand('copyFilePath');
      paths = (await vscode.env.clipboard.readText()).split(/\r?\n/).filter(Boolean);
    } finally {
      await vscode.env.clipboard.writeText(previous);
    }
    const uris: vscode.Uri[] = [];
    for (const p of paths) if (await fsp.stat(p).then(() => true, () => false)) uris.push(vscode.Uri.file(p));
    if (!uris.length) return vscode.commands.executeCommand('remoteHost.upload'); // active editor
    return vscode.commands.executeCommand('remoteHost.upload', uris[0], uris);
  });

  reg('remoteHost.diffItem', async (n: FileNode) => {
    if (n.item.status === 'unreadable') {
      return vscode.window.showWarningMessage(t('Folder "{0}" could not be read and was not compared.', n.item.relPath));
    }
    if (serverCompare) {
      const { a, b, aRoot, bRoot } = serverCompare;
      const pa = path.posix.join(aRoot, n.item.relPath);
      const pb = path.posix.join(bRoot, n.item.relPath);
      const name = path.posix.basename(pa);
      if (n.item.status === 'conflict') return warnConflict(n);
      if (n.item.status === 'modified' || n.item.status === 'unchanged') {
        await openDiff(remoteFsUri(a.name, pa), remoteFsUri(b.name, pb), `${name} (${a.name}) ↔ (${b.name})`);
      } else {
        await vscode.window.showTextDocument(
          n.item.status === 'localOnly' ? remoteUri(pa, a) : remoteUri(pb, b), { preview: true });
      }
      return;
    }
    const { local, remote } = itemPaths(n);
    const name = path.basename(local);
    if (n.item.status === 'conflict') return warnConflict(n);
    if (n.item.status === 'modified' || n.item.status === 'unchanged') {
      await openDiff(vscode.Uri.file(local), remoteFsUri(current!.name, remote), `${name} (local) ↔ ${current?.name} (remote)`);
    } else if (n.item.status === 'localOnly') {
      await vscode.window.showTextDocument(vscode.Uri.file(local), { preview: true });
    } else {
      await vscode.window.showTextDocument(remoteUri(remote), { preview: true });
    }
  });

  /** Asks before a single transfer replaces a file that is newer on the target. */
  const confirmOverwriteNewer = async (relPath: string, onServer: boolean) => {
    const overwrite = t('Overwrite');
    return (await vscode.window.showWarningMessage(
      onServer
        ? t('"{0}" is newer on the server. Overwrite it with the older version anyway?', relPath)
        : t('"{0}" is newer locally. Overwrite it with the older version anyway?', relPath),
      { modal: true }, overwrite)) === overwrite;
  };

  reg('remoteHost.uploadItem', async (n: FileNode) => {
    const c = await getClient();
    if (!c) return;
    const { local, remote } = itemPaths(n);
    if (n.item.status === 'remoteOnly') return vscode.window.showWarningMessage(t('File only exists remotely.'));
    if (isTargetNewer(n.item, 'local') && !(await confirmOverwriteNewer(n.item.relPath, true))) return;
    await runUpload(t('Uploading {0}', path.basename(local)), [{ local, remote }], current, async () => {
      if (n.item.status === 'modified') await saveBackup(current, formatStamp(new Date()), n.item.relPath, () => c.readFile(remote));
      await c.mkdir(path.posix.dirname(remote));
      await uploadPath(c, local, remote);
    });
    compareTree.removeItem(n.item.relPath);
    refreshCompareView();
  });

  reg('remoteHost.downloadItem', async (n: FileNode) => {
    const c = await getClient();
    if (!c) return;
    const { local, remote } = itemPaths(n);
    if (n.item.status === 'localOnly') return vscode.window.showWarningMessage(t('File only exists locally.'));
    if (isTargetNewer(n.item, 'remote') && !(await confirmOverwriteNewer(n.item.relPath, false))) return;
    await runDownload(t('Downloading {0}', path.basename(local)), async () => ({ files: 1, bytes: n.item.remote?.size ?? 0 }), async () => {
      if (n.item.status === 'modified') await backupLocalFile(current, formatStamp(new Date()), n.item.relPath, local);
      await downloadFileTo(c, current?.name, remote, local, n.item.remote?.mtime, n.item.remote?.size);
    });
    compareTree.removeItem(n.item.relPath);
    refreshCompareView();
  });

  // ---- Bulk transfer (folder, status group, selection or everything visible) ----
  /** Confirms, runs with progress/cancel, collects errors and removes transferred entries. */
  interface BatchOptions {
    /** Label of the confirm button (default "Start"). */
    confirmLabel?: string;
    /** The action deletes files (changes the wording of the result message). */
    deleted?: boolean;
    /** Action text per item in the preview. */
    actionFor?: (item: DiffItem) => string;
    /** Extra warning line in the confirmation. */
    note?: string;
    /** Side the data comes from; used to show "x MB / y MB" for the current file. */
    source?: TransferSource;
  }

  const transferBatch = async (
    sel: { transfer: DiffItem[]; skipped: DiffItem[]; overwrite: number },
    title: string,
    op: (item: DiffItem) => Promise<void>,
    removeDone: boolean,
    /** Files whose target is NEWER than the source; they are listed first and called out. */
    newer: DiffItem[] = [],
    opts: BatchOptions = {},
  ) => {
    const confirmLabel = opts.confirmLabel ?? t('Start');
    const previewLabel = t('Preview');
    if (!sel.transfer.length) {
      return vscode.window.showInformationMessage(
        sel.skipped.length ? t('Nothing to do ({0} skipped).', sel.skipped.length) : t('Nothing to do.'));
    }
    const names = [
      ...newer.slice(0, 10).map((i) => `⚠ ${i.relPath} ${t('(target is newer)')}`),
      ...sel.transfer.filter((i) => !newer.includes(i)).slice(0, Math.max(0, 10 - newer.length)).map((i) => `• ${i.relPath}`),
    ];
    if (sel.transfer.length > names.length) names.push(t('… and {0} more', sel.transfer.length - names.length));
    const message = [
      t('{0}: {1} file(s).', title, sel.transfer.length),
      sel.overwrite ? t('{0} will be overwritten.', sel.overwrite) : '',
      sel.skipped.length ? t('{0} skipped.', sel.skipped.length) : '',
      newer.length ? t('WARNING: {0} file(s) are NEWER on the target and would be replaced by older ones.', newer.length) : '',
      compareIncomplete ? t('WARNING: The comparison was incomplete.') : '',
      opts.note ?? '',
    ].filter(Boolean).join(' ');
    const answer = await vscode.window.showWarningMessage(
      message, { modal: true, detail: names.join('\n') }, confirmLabel, previewLabel);
    if (answer === previewLabel) {
      // Dry run: list everything that would happen, change nothing.
      const act = opts.actionFor ?? ((i: DiffItem) => (i.status === 'modified' ? t('overwrite') : t('create')));
      const lines = [
        `# ${t('Preview: {0}', title)}`, '',
        t('{0} file(s), {1} skipped. Nothing was changed.', sel.transfer.length, sel.skipped.length), '',
        `| ${t('Action')} | ${t('File')} | ${t('Note')} |`, '|---|---|---|',
        ...sel.transfer.map((i) => `| ${act(i)} | ${i.relPath} | ${newer.includes(i) ? t('⚠ target is newer') : ''} |`),
      ];
      if (sel.skipped.length) {
        lines.push('', `## ${t('Skipped')}`, '', ...sel.skipped.slice(0, 200).map((i) => `- ${i.relPath} (${i.status})`));
      }
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
      return;
    }
    if (answer !== confirmLabel) return;
    const done: string[] = [];
    const failed: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const sizeOf = (item: DiffItem) =>
          (opts.source === 'local' ? item.local?.size : opts.source === 'remote' ? item.remote?.size : undefined) ?? 0;
        const tracker = new TransferTracker(sel.transfer.length, sel.transfer.reduce((sum, item) => sum + sizeOf(item), 0));
        let lastShown = 0; let lastPercent = 0;
        const report = (force?: boolean) => {
          const now = Date.now();
          if (!force && now - lastShown < 250) return; // do not flood the progress UI
          lastShown = now;
          const snap = tracker.snapshot();
          progress.report({ message: progressText(snap), increment: Math.max(0, snap.percent - lastPercent) });
          lastPercent = Math.max(lastPercent, snap.percent);
        };
        for (const item of sel.transfer) {
          if (token.isCancellationRequested) break;
          tracker.startFile(item.relPath, sizeOf(item));
          report(true);
          onBytes = (bytes) => { tracker.addBytes(bytes); report(); };
          try { await op(item); done.push(item.relPath); } catch (e) {
            failed.push(`${item.relPath}: ${(e as Error).message}`);
            log(`ERROR ${title}: ${item.relPath}: ${(e as Error).message}`);
          } finally {
            onBytes = undefined;
            tracker.finishFile();
            report(true);
          }
        }
      },
    );
    if (removeDone) {
      compareTree.removeItems(done);
      refreshCompareView();
    }
    const left = sel.transfer.length - done.length - failed.length;
    log(`${title}: ${done.length} done, ${failed.length} failed, ${left} cancelled`);
    const msg = [
      opts.deleted ? t('{0} deleted', done.length) : t('{0} transferred', done.length),
      failed.length ? t('{0} failed', failed.length) : '',
      left ? t('{0} cancelled', left) : '',
    ].filter(Boolean).join(', ') + '.';
    if (failed.length) vscode.window.showErrorMessage(`${msg} ${failed.slice(0, 3).join(' | ')}`);
    else vscode.window.showInformationMessage(msg);
  };

  /** Items below the clicked/selected nodes; without a node: everything currently visible. */
  const itemsFor = (arg?: CompareNode, sel?: CompareNode[]): DiffItem[] => {
    const nodes = sel?.length ? sel : arg ? [arg] : [];
    return nodes.length ? collectDiffItems(nodes) : compareTree.visibleItems;
  };

  reg('remoteHost.uploadMany', async (arg?: CompareNode, sel?: CompareNode[]) => {
    if (serverCompare) return vscode.window.showWarningMessage(t('Uploading is only possible when comparing local ↔ server.'));
    const c = await getClient();
    if (!c) return;
    const upSel = selectBySource(itemsFor(arg, sel), 'local');
    const stamp = formatStamp(new Date());
    await transferBatch(upSel, t('Uploading to {0}', current?.name ?? ''), async (item) => {
      const local = safeLocalPath(toLocal(compareRemoteRoot), item.relPath);
      const remote = path.posix.join(compareRemoteRoot, item.relPath);
      if (item.status === 'modified') await saveBackup(current, stamp, item.relPath, () => c.readFile(remote));
      await c.mkdir(path.posix.dirname(remote));
      await uploadPath(c, local, remote);
    }, true, upSel.transfer.filter((i) => isTargetNewer(i, 'local')), { source: 'local' });
  });

  reg('remoteHost.downloadMany', async (arg?: CompareNode, sel?: CompareNode[]) => {
    const items = itemsFor(arg, sel);
    if (serverCompare) {
      const { a, b, aRoot, bRoot } = serverCompare;
      const pick = await vscode.window.showQuickPick([a.name, b.name], { placeHolder: t('Download from which server to local?') });
      if (!pick) return;
      const source: TransferSource = pick === a.name ? 'local' : 'remote';
      const server = source === 'local' ? a : b;
      const root = source === 'local' ? aRoot : bRoot;
      const c = await getClientFor(server);
      if (!c) return;
      const stamp = formatStamp(new Date());
      await transferBatch(selectBySource(items, source), t('Downloading from {0}', server.name), async (item) => {
        const local = localFor(server, root, item.relPath);
        if (!local) throw new Error(t('No local target folder (is a workspace open?)'));
        if (item.status === 'modified') await backupLocalFile(server, stamp, item.relPath, local);
        await downloadFileTo(c, server.name, path.posix.join(root, item.relPath), local,
          (source === 'local' ? item.local : item.remote)?.mtime);
      }, false, [], { source });
      return;
    }
    const c = await getClient();
    if (!c) return;
    const downSel = selectBySource(items, 'remote');
    const stamp = formatStamp(new Date());
    await transferBatch(downSel, t('Downloading from {0}', current?.name ?? ''), async (item) => {
      const local = safeLocalPath(toLocal(compareRemoteRoot), item.relPath);
      if (item.status === 'modified') await backupLocalFile(current, stamp, item.relPath, local);
      await downloadFileTo(c, current?.name, path.posix.join(compareRemoteRoot, item.relPath), local, item.remote?.mtime);
    }, true, downSel.transfer.filter((i) => isTargetNewer(i, 'remote')), { source: 'remote' });
  });

  // ---- Delete extras (only on one side) ----
  /** Deleting needs an explicit target: never "everything visible" by accident. */
  const nodesGiven = (arg?: CompareNode, sel?: CompareNode[]) => !!(arg || sel?.length);

  reg('remoteHost.deleteRemoteOnly', async (arg?: CompareNode, sel?: CompareNode[]) => {
    if (serverCompare) return vscode.window.showWarningMessage(t('Deleting is only possible when comparing local ↔ server.'));
    if (!nodesGiven(arg, sel)) return vscode.window.showWarningMessage(t('Please select a folder, group or files in the tree.'));
    const c = await getClient();
    if (!c) return;
    const { remove, kept } = selectForDelete(itemsFor(arg, sel), 'remote');
    const stamp = formatStamp(new Date());
    await transferBatch({ transfer: remove, skipped: kept, overwrite: 0 }, t('Deleting on {0}', current?.name ?? ''), async (item) => {
      const remote = path.posix.join(compareRemoteRoot, item.relPath);
      await saveBackup(current, stamp, item.relPath, () => c.readFile(remote));
      await c.remove(remote, false);
      log(`✗ ${current?.name}: ${remote} deleted`);
    }, true, [], {
      confirmLabel: t('Delete'), deleted: true, actionFor: () => t('delete on the server'),
      note: current?.backupBeforeOverwrite
        ? t('The files are backed up locally first (.vscode/remote-host-backup).')
        : t('NO backup (the option "Back up files …" is off). Deleting cannot be undone!'),
    });
  });

  reg('remoteHost.deleteLocalOnly', async (arg?: CompareNode, sel?: CompareNode[]) => {
    if (serverCompare) return vscode.window.showWarningMessage(t('Deleting is only possible when comparing local ↔ server.'));
    if (!nodesGiven(arg, sel)) return vscode.window.showWarningMessage(t('Please select a folder, group or files in the tree.'));
    const { remove, kept } = selectForDelete(itemsFor(arg, sel), 'local');
    await transferBatch({ transfer: remove, skipped: kept, overwrite: 0 }, t('Deleting locally'), async (item) => {
      const local = safeLocalPath(toLocal(compareRemoteRoot), item.relPath);
      await vscode.workspace.fs.delete(vscode.Uri.file(local), { useTrash: true });
      log(`✗ local: ${local} moved to trash`);
    }, true, [], {
      confirmLabel: t('Move to trash'), deleted: true, actionFor: () => t('delete locally (trash)'),
      note: t('The files are moved to the trash.'),
    });
  });

  reg('remoteHost.compareLayout', async () => {
    const modes: { label: string; id: CompareLayout; description?: string }[] = [
      { label: `$(list-tree) ${t('Folder tree')}`, id: 'tree' },
      { label: `$(group-by-ref-type) ${t('Grouped by status')}`, id: 'status' },
      { label: `$(list-flat) ${t('Flat list')}`, id: 'list' },
    ];
    modes.forEach((m) => { if (m.id === compareTree.layout) m.description = t('(current)'); });
    const pick = await vscode.window.showQuickPick(modes, { placeHolder: t('How to display the differences') });
    if (pick) {
      compareTree.setLayout(pick.id);
      void ctx.workspaceState.update('compareLayout', pick.id);
    }
  });

  reg('remoteHost.compareFilter', async () => {
    const names = statusNames(serverCompare && { a: serverCompare.a.name, b: serverCompare.b.name });
    const all = STATUS_ORDER;
    const picks = await vscode.window.showQuickPick(
      all.map((st) => ({
        label: names[st],
        description: String(compareTree.items.filter((i) => i.status === st).length),
        picked: !compareTree.hidden.has(st),
        st,
      })),
      { canPickMany: true, placeHolder: t('Which statuses should be shown?') },
    );
    if (!picks) return;
    const shown = new Set(picks.map((p) => p.st));
    const hidden = all.filter((st) => !shown.has(st));
    compareTree.setHidden(new Set(hidden));
    void ctx.workspaceState.update('compareHiddenStatuses', hidden);
    refreshCompareView();
  });

  reg('remoteHost.clearCompare', () => {
    compareIncomplete = false;
    compareTree.setItems([]);
    updateCompareView([]);
    compareView.title = t('Differences');
  });

  // ---- Settings form, Edit Remote File, Select Opened File, SSH ----
  reg('remoteHost.manageServers', () => openServerForm(ctx, reload));

  const remoteFs = new RemoteFileSystem(async (name) => {
    const server = servers.find((s) => s.name === name);
    return server ? getClientFor(server) : undefined;
  });
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(REMOTE_FS_SCHEME, remoteFs, { isCaseSensitive: true }),
  );

  reg('remoteHost.editRemote', async (node: RemoteNode) => {
    if (!current || !node || node.entry.isDirectory) return;
    await vscode.window.showTextDocument(remoteFsUri(current.name, node.entry.path));
  });

  reg('remoteHost.revealOpened', async (uri?: vscode.Uri) => {
    const file = (uri ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
    const remote = file ? toRemote(file) : undefined;
    const c = await getClient();
    if (!remote || !c) return vscode.window.showWarningMessage(t('The open file is not inside the mapped local folder.'));
    const entries = await c.list(path.posix.dirname(remote)).catch(() => []);
    const entry = entries.find((e) => e.name === path.posix.basename(remote));
    if (!entry) return vscode.window.showInformationMessage(t('This file does not exist on the server yet.'));
    await vscode.commands.executeCommand('remoteHost.tree.focus');
    await view.reveal(new RemoteNode(entry), { select: true, focus: true, expand: true });
  });

  reg('remoteHost.openSsh', (node?: RemoteNode) => {
    if (!current || current.protocol !== 'sftp') return;
    const dir = node ? (node.entry.isDirectory ? node.entry.path : path.posix.dirname(node.entry.path)) : current.remotePath;
    // No shell string: shellPath + shellArgs avoids quoting problems on Windows (PowerShell/cmd).
    // Only the remote command is quoted, and that one is run by the (POSIX) remote shell.
    const q = (x: string) => x.replace(/'/g, `'\\''`);
    const args = ['-t'];
    if (current.privateKeyPath) args.push('-i', expandHome(current.privateKeyPath));
    args.push('-p', String(current.port ?? 22), `${current.username}@${current.host}`, `cd '${q(dir)}' && exec $SHELL -l`);
    const term = vscode.window.createTerminal({ name: `SSH ${current.name}`, shellPath: 'ssh', shellArgs: args });
    term.show();
  });

  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      // Every server with "Upload on save" that maps this file gets it (not only the active one).
      for (const server of servers.filter((sv) => sv.uploadOnSave)) {
        const remote = toRemote(doc.uri.fsPath, server);
        if (!remote || isExcluded(remote, server)) continue;
        const c = await getClientFor(server);
        if (!c) continue;
        await run(t('Upload on save → {0}', server.name), async () => {
          await c.mkdir(path.posix.dirname(remote)); // new files may live in a new folder
          const stat = await vscode.workspace.fs.stat(doc.uri);
          await c.uploadFile(doc.uri.fsPath, remote, { mtimeMs: stat.mtime });
          log(`↑ ${server.name}: ${remote} (on save)`);
          notifyRemoteChanged(server, remote);
          await markSynced(server, doc.uri.fsPath);
        });
      }
    }),
    { dispose: () => void dropClient() },
  );

  const uri = configUri();
  if (uri) {
    const folder = vscode.workspace.workspaceFolders![0];
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.vscode/remote-hosts.json'));
    w.onDidChange(reload); w.onDidCreate(reload); w.onDidDelete(reload);
    ctx.subscriptions.push(w);
  }
  void reload();
}

export function deactivate() {}
