import * as vscode from 'vscode';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { loadServers, saveServers, configUri, passwordKey } from './config/config';
import { createClient } from './connection/factory';
import { expandHome } from './connection/sftpClient';
import { RemoteClient, RemoteEntry, ServerConfig } from './connection/types';
import { RemoteNode, RemoteTreeProvider } from './views/remoteTree';
import { CompareLayout, CompareNode, CompareTreeProvider, collectDiffItems, FileNode, ServerLabels, STATUS_ORDER, statusNames, summaryText } from './views/compareTree';
import { DiffDecorationProvider } from './views/diffDecorations';
import { compareTrees, DiffItem, DiffStatus, isDifference, Side } from './compare/compare';
import { log, initLog, showLog } from './log';
import { expandServer } from './config/envExpand';
import { parseGitignore } from './compare/gitignore';
import { isTargetNewer, selectBySource, selectForDelete, TransferSource } from './compare/transfer';
import { backupPath, formatStamp, mapToRemote, safeLocalPath } from './connection/paths';
import { checkHostKey, HostKeyVerifier } from './connection/hostKey';
import { makeExcluder } from './compare/glob';
import { RemoteFileSystem, REMOTE_FS_SCHEME, remoteFsUri } from './fs/remoteFs';
import { openServerForm } from './views/serverForm';

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
    log(`Host-Key von ${id}: ${decision === 'new' ? 'unbekannt' : 'GEÄNDERT'} (${fingerprint})`);
    const isNew = decision === 'new';
    const answer = await vscode.window.showWarningMessage(
      isNew ? `Unbekannter Server ${id}` : `ACHTUNG: Der Host-Key von ${id} hat sich geändert!`,
      {
        modal: true,
        detail: isNew
          ? `Fingerprint: ${fingerprint}\n\nNur vertrauen, wenn der Fingerprint zu deinem Server passt.`
          : `Bisher bekannt: ${known[id]}\nJetzt: ${fingerprint}\n\nDas kann ein Angriff (Man-in-the-Middle) sein oder eine Neuinstallation des Servers. Im Zweifel abbrechen.`,
      },
      isNew ? 'Vertrauen' : 'Neuen Key akzeptieren',
    );
    if (!answer) { log(`Host-Key von ${id} abgelehnt.`); return false; }
    log(`Host-Key von ${id} akzeptiert.`);
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
          prompt: `Password for ${server.username}@${server.host} (${server.name})`,
          password: true,
          ignoreFocusOut: true,
        });
        if (pw === undefined) return undefined;
      }
      log(`Verbinde mit ${server.name} (${server.protocol}://${server.host}) …`);
      try {
        client = await createClient(server, pw, verifyHostKey);
      } catch (e) {
        log(`Verbindung zu ${server.name} fehlgeschlagen: ${(e as Error).message}`);
        // A stored password that no longer works: ask again once instead of failing forever.
        if (stored === undefined || server.useAgent || !AUTH_ERROR.test((e as Error).message)) throw e;
        const again = await vscode.window.showInputBox({
          prompt: `Anmeldung an ${server.name} fehlgeschlagen. Passwort neu eingeben`,
          password: true,
          ignoreFocusOut: true,
        });
        if (again === undefined) throw e;
        pw = again;
        client = await createClient(server, pw, verifyHostKey);
      }
      log(`Verbunden mit ${server.name}.`);
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
      statusBar.tooltip = `${current.protocol}://${current.username}@${current.host}${current.remotePath}\nClick to switch server`
        + (current.uploadOnSave ? '\nUpload on save is ON' : '');
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
      if (missing.length) log(`Server ${server.name}: Umgebungsvariable(n) nicht gesetzt: ${[...new Set(missing)].join(', ')}`);
      return server;
    });
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
        log(`FEHLER (${title}): ${(e as Error).message}`);
        vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
      }
    });

  /** Patterns from each server's .gitignore (only for servers with useGitignore). */
  const gitignorePatterns = new Map<string, string[]>();
  const loadGitignore = async (server: ServerConfig) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!server.useGitignore || !root) { gitignorePatterns.delete(server.name); return; }
    try {
      const file = vscode.Uri.file(path.join(root, server.localPath, '.gitignore'));
      const { patterns, unsupported } = parseGitignore(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
      gitignorePatterns.set(server.name, patterns);
      log(`.gitignore für ${server.name}: ${patterns.length} Muster${unsupported ? `, ${unsupported} Negation(en) nicht unterstützt` : ''}`);
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

  /** Stores a copy of data under .vscode/remote-host-backup (only if the server has the option on). */
  const saveBackup = async (server: ServerConfig | undefined, stamp: string, relPath: string, data: Uint8Array) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!server?.backupBeforeOverwrite || !root) return;
    const target = backupPath(root, server.name, stamp, relPath);
    await writeLocal(target, data);
    log(`Backup: ${target}`);
  };
  /** Backs up an existing local file before it is overwritten by a download. */
  const backupLocalFile = async (server: ServerConfig | undefined, stamp: string, relPath: string, local: string) => {
    if (!server?.backupBeforeOverwrite) return;
    let data: Uint8Array;
    try { data = await vscode.workspace.fs.readFile(vscode.Uri.file(local)); } catch { return; } // nothing to back up
    await saveBackup(server, stamp, relPath, data);
  };

  async function uploadPath(c: RemoteClient, local: string, remote: string, server = current): Promise<void> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(local));
    if (stat.type & vscode.FileType.Directory) {
      await c.mkdir(remote);
      for (const [name] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(local))) {
        if (isExcluded(path.posix.join(remote, name), server)) continue;
        await uploadPath(c, path.join(local, name), path.posix.join(remote, name), server);
      }
    } else {
      await c.writeFile(remote, Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(local))), stat.mtime);
      log(`↑ ${server?.name}: ${remote}`);
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
      await writeLocal(local, await c.readFile(e.path), e.mtime);
      log(`↓ ${current?.name}: ${e.path}`);
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
    vscode.window.showInformationMessage('Gespeicherte SFTP-Host-Keys wurden gelöscht. Beim nächsten Verbinden wird neu gefragt.');
  });

  reg('remoteHost.openConfig', async () => {
    const uri = configUri();
    if (!uri) return vscode.window.showWarningMessage('Open a workspace folder first.');
    if (!(await loadServers()).length) await saveServers([]);
    vscode.window.showTextDocument(uri);
  });

  reg('remoteHost.addServer', async () => {
    const ask = (prompt: string, value?: string, password = false) =>
      vscode.window.showInputBox({ prompt, value, password, ignoreFocusOut: true });
    const name = await ask('Server name (e.g. Test, Live)'); if (!name) return;
    const protocol = (await vscode.window.showQuickPick(['sftp', 'ftp', 'ftps'], { placeHolder: 'Protocol' })) as ServerConfig['protocol'];
    if (!protocol) return;
    const host = await ask('Host'); if (!host) return;
    const username = await ask('Username'); if (username === undefined) return;
    const password = await ask('Password (stored in the system keychain)', '', true); if (password === undefined) return;
    const remotePath = await ask('Remote root path', '/'); if (!remotePath) return;
    const localPath = await ask('Local folder relative to workspace', '.'); if (!localPath) return;
    const cfg: ServerConfig = { name, protocol, host, username, remotePath, localPath, exclude: ['.git', 'node_modules'] };
    await ctx.secrets.store(passwordKey(cfg), password);
    await saveServers([...(await loadServers()), cfg]);
    current = cfg;
    await reload();
  });

  reg('remoteHost.selectServer', async () => {
    const pick = await vscode.window.showQuickPick(servers.map((s) => s.name), { placeHolder: 'Select server' });
    if (!pick) return;
    current = servers.find((s) => s.name === pick);
    await refreshUi();
    tree.refresh();
  });

  reg('remoteHost.refresh', () => tree.refresh());

  /** Which servers to upload to. With several servers configured the user chooses (active server first). */
  const pickUploadServers = async (): Promise<ServerConfig[]> => {
    if (servers.length <= 1) return current ? [current] : [];
    const items = [...servers]
      .sort((x, y) => Number(y.name === current?.name) - Number(x.name === current?.name))
      .map((sv) => ({
        label: sv.name,
        description: sv.name === current?.name ? 'aktiv' : undefined,
        detail: `${sv.protocol}://${sv.host}${sv.remotePath}`,
        picked: sv.name === current?.name,
        sv,
      }));
    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Auf welchen Server hochladen? (mehrere möglich)',
      ignoreFocusOut: true,
    });
    return picks?.map((p) => p.sv) ?? [];
  };

  reg('remoteHost.upload', async (arg?: RemoteNode | vscode.Uri, selected?: vscode.Uri[]) => {
    if (arg instanceof RemoteNode) {
      // Remote tree: the node belongs to the active server.
      const c = await getClient(); if (!c || !current) return;
      const remote = arg.entry.path; const local = toLocal(remote);
      await run(`Uploading ${path.basename(local)}`, () => uploadPath(c, local, remote));
      tree.refresh();
      return;
    }
    // Explorer / editor: several files may be selected, and the target server is chosen here.
    const uris = selected?.length ? selected : [arg ?? vscode.window.activeTextEditor?.document.uri].filter(
      (u): u is vscode.Uri => !!u);
    if (!uris.length) return;
    const targets = await pickUploadServers();
    if (!targets.length) return;
    for (const server of targets) {
      const c = await getClientFor(server);
      if (!c) continue;
      const jobs = uris.map((u) => ({ local: u.fsPath, remote: toRemote(u.fsPath, server) }));
      const outside = jobs.filter((j) => !j.remote).length;
      if (outside) vscode.window.showWarningMessage(
        `${outside} Datei(en) liegen außerhalb des lokalen Ordners von "${server.name}" und wurden übersprungen.`);
      const what = jobs.length === 1 ? path.basename(jobs[0].local) : `${jobs.length} Elemente`;
      await run(`Uploading ${what} to ${server.name}`, async () => {
        for (const j of jobs) {
          if (!j.remote) continue;
          if (!(await vscode.workspace.fs.stat(vscode.Uri.file(j.local)).then((st) => st.type & vscode.FileType.Directory, () => 0))) {
            await c.mkdir(path.posix.dirname(j.remote));
          }
          await uploadPath(c, j.local, j.remote, server);
        }
      });
    }
    tree.refresh();
  });

  reg('remoteHost.download', async (node: RemoteNode) => {
    const c = await getClient(); if (!c || !node) return;
    await run(`Downloading ${node.entry.name}`, () => downloadEntry(c, node.entry));
  });

  reg('remoteHost.newFile', async (node: RemoteNode) => {
    const name = await vscode.window.showInputBox({ prompt: 'New file name' });
    const c = await getClient(); if (!name || !c) return;
    await run('Creating file', () => c.writeFile(path.posix.join(node.entry.path, name), Buffer.alloc(0)));
    tree.refresh();
  });

  reg('remoteHost.newFolder', async (node: RemoteNode) => {
    const name = await vscode.window.showInputBox({ prompt: 'New folder name' });
    const c = await getClient(); if (!name || !c) return;
    await run('Creating folder', () => c.mkdir(path.posix.join(node.entry.path, name)));
    tree.refresh();
  });

  reg('remoteHost.rename', async (node: RemoteNode) => {
    const name = await vscode.window.showInputBox({ prompt: 'New name', value: node.entry.name });
    const c = await getClient(); if (!name || !c || name === node.entry.name) return;
    await run('Renaming', () => c.rename(node.entry.path, path.posix.join(path.posix.dirname(node.entry.path), name)));
    tree.refresh();
  });

  reg('remoteHost.delete', async (node: RemoteNode) => {
    const ok = await vscode.window.showWarningMessage(
      `Delete ${node.entry.path} on ${current?.name}?`, { modal: true }, 'Delete');
    const c = await getClient(); if (ok !== 'Delete' || !c) return;
    await run('Deleting', () => c.remove(node.entry.path, node.entry.isDirectory));
    tree.refresh();
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
      ? { value: diffs.length, tooltip: `${diffs.length} Unterschiede` } : undefined;
    const visible = compareTree.visibleItems;
    const shownDiffs = visible.filter((i) => isDifference(i.status)).length;
    const shownSame = visible.length - shownDiffs;
    let msg = diffs.length ? summaryText(items, labels) : undefined;
    if (msg && shownDiffs !== diffs.length) msg += ` — Filter aktiv: ${shownDiffs} von ${diffs.length} sichtbar`;
    if (msg && shownSame) msg += ` · inkl. ${shownSame} unverändert`;
    if (compareIncomplete) msg = `${msg ?? ''} — UNVOLLSTÄNDIG (Vergleich abgebrochen)`.trimStart();
    compareView.message = msg;
    diffDecorations.refresh();
  };
  let compareRemoteRoot = '';

  // Active server-to-server comparison (undefined = local <-> current server).
  let serverCompare: { a: ServerConfig; b: ServerConfig; aRoot: string; bRoot: string } | undefined;

  // Serves remote file content for diffs: remotehost:/<remote path>?<server name>
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('remotehost', {
      async provideTextDocumentContent(uri) {
        const server = servers.find((s) => s.name === uri.query) ?? current;
        const c = server ? await getClientFor(server) : undefined;
        if (!c) throw new Error(`Keine Verbindung zu "${server?.name ?? uri.query}".`);
        try {
          return (await c.readFile(uri.path)).toString('utf8');
        } catch (e) {
          // Surface the real error instead of showing the file as empty.
          throw new Error(`Remote-Datei konnte nicht gelesen werden: ${(e as Error).message}`);
        }
      },
    }),
  );
  const remoteUri = (p: string, server: ServerConfig | undefined = current) =>
    vscode.Uri.from({ scheme: 'remotehost', path: p, query: server?.name ?? '' });

  const localSide: Side = {
    async list(dir) {
      const out = [];
      for (const [name, type] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))) {
        const st = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, name)));
        out.push({ name, isDirectory: !!(type & vscode.FileType.Directory), size: st.size, mtime: st.mtime });
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
    if (!localRoot()) return vscode.window.showWarningMessage('Open a workspace folder first.');
    let remote: string;
    let local: string;
    if (arg instanceof vscode.Uri) {
      const mapped = toRemote(arg.fsPath);
      if (!mapped) return vscode.window.showWarningMessage('Folder is outside the mapped local folder.');
      remote = mapped;
      local = arg.fsPath;
    } else {
      remote = arg?.entry.isDirectory ? arg.entry.path : current.remotePath;
      local = toLocal(remote);
    }
    await loadGitignore(current); // pick up .gitignore edits since the last compare
    let cancelled = false;
    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Comparing with ${current.name}`, cancellable: true },
      async (progress, token) => {
        try {
          const result = await compareTrees(localSide, remoteSide(c), local, remote, {
            includeUnchanged: true,
            exclude: effectiveExcludes(current),
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
    if (cancelled) vscode.window.showWarningMessage('Vergleich abgebrochen: Das Ergebnis ist unvollständig.');
    log(`Vergleich Lokal ↔ ${current.name}: ${summaryText(items) || 'keine Unterschiede'}${cancelled ? ' (abgebrochen)' : ''}`);
    compareRemoteRoot = remote;
    serverCompare = undefined;
    compareTree.setItems(items);
    updateCompareView(items);
    compareView.title = `Differences: ${current.name} (${items.filter((i) => isDifference(i.status)).length})`;
    if (!items.some((i) => isDifference(i.status))) vscode.window.showInformationMessage(`No differences with ${current.name}.`);
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
    if (!local || !remote) return vscode.window.showWarningMessage('File is outside the mapped local folder.');
    await vscode.commands.executeCommand(
      'vscode.diff', vscode.Uri.file(local), remoteUri(remote),
      `${path.basename(local)} (local) ↔ ${current.name} (remote)`,
    );
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
    if (servers.length < 2) return vscode.window.showWarningMessage('Configure at least two servers to compare them.');
    const pick = async (placeHolder: string, exclude?: string) => {
      const name = await vscode.window.showQuickPick(
        servers.filter((s) => s.name !== exclude).map((s) => s.name), { placeHolder });
      return servers.find((s) => s.name === name);
    };
    const a = node && current ? current : await pick('Server A (e.g. Test)');
    if (!a) return;
    const b = await pick(`Compare ${a.name} with ... (Server B, e.g. Live)`, a.name);
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
      { location: vscode.ProgressLocation.Notification, title: `Comparing ${a.name} with ${b.name}`, cancellable: true },
      async (progress, token) => {
        try {
          const result = await compareTrees(remoteSide(ca), remoteSide(cb), aRoot, bRoot, {
            includeUnchanged: true,
            exclude: [...new Set([...effectiveExcludes(a), ...effectiveExcludes(b)])],
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
    if (cancelled) vscode.window.showWarningMessage('Vergleich abgebrochen: Das Ergebnis ist unvollständig.');
    serverCompare = { a, b, aRoot, bRoot };
    log(`Vergleich ${a.name} ↔ ${b.name}: ${summaryText(items, { a: a.name, b: b.name }) || 'keine Unterschiede'}${cancelled ? ' (abgebrochen)' : ''}`);
    compareTree.setItems(items, { a: a.name, b: b.name });
    updateCompareView(items, { a: a.name, b: b.name });
    compareView.title = `${a.name} ↔ ${b.name} (${items.filter((i) => isDifference(i.status)).length})`;
    if (!items.some((i) => isDifference(i.status))) vscode.window.showInformationMessage(`No differences between ${a.name} and ${b.name}.`);
    else await vscode.commands.executeCommand('remoteHost.compare.focus');
  });

  const downloadFrom = async (n: FileNode, side: 'a' | 'b') => {
    if (!serverCompare) return;
    const server = serverCompare[side];
    const root = side === 'a' ? serverCompare.aRoot : serverCompare.bRoot;
    const exists = side === 'a' ? n.item.status !== 'remoteOnly' : n.item.status !== 'localOnly';
    if (!exists) return vscode.window.showWarningMessage(`File does not exist on ${server.name}.`);
    const c = await getClientFor(server);
    const local = localFor(server, root, n.item.relPath);
    if (!c || !local) return;
    await run(`Downloading from ${server.name}`, async () => {
      await writeLocal(local, await c.readFile(path.posix.join(root, n.item.relPath)),
        (side === 'a' ? n.item.local : n.item.remote)?.mtime);
      log(`↓ ${server.name}: ${path.posix.join(root, n.item.relPath)}`);
    });
    vscode.window.showInformationMessage(`Saved to ${local}`);
  };
  reg('remoteHost.downloadFromA', (n: FileNode) => downloadFrom(n, 'a'));
  reg('remoteHost.downloadFromB', (n: FileNode) => downloadFrom(n, 'b'));

  const warnConflict = (n: FileNode) =>
    vscode.window.showWarningMessage(
      `Typ-Konflikt bei "${n.item.relPath}": auf einer Seite eine Datei, auf der anderen ein Ordner. Bitte manuell auflösen.`);

  reg('remoteHost.diffItem', async (n: FileNode) => {
    if (n.item.status === 'unreadable') {
      return vscode.window.showWarningMessage(`Ordner "${n.item.relPath}" konnte nicht gelesen werden und wurde nicht verglichen.`);
    }
    if (serverCompare) {
      const { a, b, aRoot, bRoot } = serverCompare;
      const pa = path.posix.join(aRoot, n.item.relPath);
      const pb = path.posix.join(bRoot, n.item.relPath);
      const name = path.posix.basename(pa);
      if (n.item.status === 'conflict') return warnConflict(n);
      if (n.item.status === 'modified' || n.item.status === 'unchanged') {
        await vscode.commands.executeCommand(
          'vscode.diff', remoteUri(pa, a), remoteUri(pb, b), `${name} (${a.name}) ↔ (${b.name})`);
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
      await vscode.commands.executeCommand(
        'vscode.diff', vscode.Uri.file(local), remoteUri(remote), `${name} (local) ↔ ${current?.name} (remote)`);
    } else if (n.item.status === 'localOnly') {
      await vscode.window.showTextDocument(vscode.Uri.file(local), { preview: true });
    } else {
      await vscode.window.showTextDocument(remoteUri(remote), { preview: true });
    }
  });

  /** Asks before a single transfer replaces a file that is newer on the target. */
  const confirmOverwriteNewer = async (relPath: string, where: string) =>
    (await vscode.window.showWarningMessage(
      `"${relPath}" ist ${where} neuer. Trotzdem mit der älteren Version überschreiben?`,
      { modal: true }, 'Überschreiben')) === 'Überschreiben';

  reg('remoteHost.uploadItem', async (n: FileNode) => {
    const c = await getClient();
    if (!c) return;
    const { local, remote } = itemPaths(n);
    if (n.item.status === 'remoteOnly') return vscode.window.showWarningMessage('File only exists remotely.');
    if (isTargetNewer(n.item, 'local') && !(await confirmOverwriteNewer(n.item.relPath, 'auf dem Server'))) return;
    await run(`Uploading ${path.basename(local)}`, async () => {
      if (n.item.status === 'modified') await saveBackup(current, formatStamp(new Date()), n.item.relPath, await c.readFile(remote));
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
    if (n.item.status === 'localOnly') return vscode.window.showWarningMessage('File only exists locally.');
    if (isTargetNewer(n.item, 'remote') && !(await confirmOverwriteNewer(n.item.relPath, 'lokal'))) return;
    await run(`Downloading ${path.basename(local)}`, async () => {
      if (n.item.status === 'modified') await backupLocalFile(current, formatStamp(new Date()), n.item.relPath, local);
      await writeLocal(local, await c.readFile(remote), n.item.remote?.mtime);
      log(`↓ ${current?.name}: ${remote}`);
    });
    compareTree.removeItem(n.item.relPath);
    refreshCompareView();
  });

  // ---- Bulk transfer (folder, status group, selection or everything visible) ----
  /** Confirms, runs with progress/cancel, collects errors and removes transferred entries. */
  interface BatchOptions {
    /** Label of the confirm button (default "Start"). */
    confirmLabel?: string;
    /** Past participle for messages (default "übertragen"). */
    doneWord?: string;
    /** Action text per item in the preview. */
    actionFor?: (item: DiffItem) => string;
    /** Extra warning line in the confirmation. */
    note?: string;
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
    const confirmLabel = opts.confirmLabel ?? 'Start';
    const doneWord = opts.doneWord ?? 'übertragen';
    if (!sel.transfer.length) {
      return vscode.window.showInformationMessage(
        `Nichts zu ${doneWord === 'übertragen' ? 'übertragen' : 'tun'}${sel.skipped.length ? ` (${sel.skipped.length} übersprungen)` : ''}.`);
    }
    const names = [
      ...newer.slice(0, 10).map((i) => `⚠ ${i.relPath} (Ziel ist neuer)`),
      ...sel.transfer.filter((i) => !newer.includes(i)).slice(0, Math.max(0, 10 - newer.length)).map((i) => `• ${i.relPath}`),
    ];
    if (sel.transfer.length > names.length) names.push(`… und ${sel.transfer.length - names.length} weitere`);
    const answer = await vscode.window.showWarningMessage(
      `${title}: ${sel.transfer.length} Datei(en)`
        + `${sel.overwrite ? `, davon ${sel.overwrite} werden überschrieben` : ''}`
        + `${sel.skipped.length ? `, ${sel.skipped.length} übersprungen` : ''}.`
        + `${newer.length ? ` ACHTUNG: ${newer.length} Datei(en) sind am Ziel NEUER und würden durch ältere ersetzt.` : ''}`
        + `${compareIncomplete ? ' ACHTUNG: Der Vergleich war unvollständig.' : ''}`
        + `${opts.note ? ` ${opts.note}` : ''}`,
      { modal: true, detail: names.join('\n') }, confirmLabel, 'Vorschau');
    if (answer === 'Vorschau') {
      // Dry run: list everything that would happen, change nothing.
      const act = opts.actionFor ?? ((i: DiffItem) => (i.status === 'modified' ? 'überschreiben' : 'neu anlegen'));
      const lines = [
        `# Vorschau: ${title}`, '', `${sel.transfer.length} Datei(en), ${sel.skipped.length} übersprungen. Es wurde nichts geändert.`, '',
        '| Aktion | Datei | Hinweis |', '|---|---|---|',
        ...sel.transfer.map((i) => `| ${act(i)} | ${i.relPath} | ${newer.includes(i) ? '⚠ Ziel ist neuer' : ''} |`),
      ];
      if (sel.skipped.length) {
        lines.push('', '## Übersprungen', '', ...sel.skipped.slice(0, 200).map((i) => `- ${i.relPath} (${i.status})`));
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
        for (const item of sel.transfer) {
          if (token.isCancellationRequested) break;
          progress.report({ message: item.relPath, increment: 100 / sel.transfer.length });
          try { await op(item); done.push(item.relPath); } catch (e) {
            failed.push(`${item.relPath}: ${(e as Error).message}`);
            log(`FEHLER ${title}: ${item.relPath}: ${(e as Error).message}`);
          }
        }
      },
    );
    if (removeDone) {
      compareTree.removeItems(done);
      refreshCompareView();
    }
    const left = sel.transfer.length - done.length - failed.length;
    log(`${title}: ${done.length} ${doneWord}, ${failed.length} Fehler, ${left} abgebrochen`);
    const msg = `${done.length} ${doneWord}${failed.length ? `, ${failed.length} Fehler` : ''}${left ? `, ${left} abgebrochen` : ''}.`;
    if (failed.length) vscode.window.showErrorMessage(`${msg} ${failed.slice(0, 3).join(' | ')}`);
    else vscode.window.showInformationMessage(msg);
  };

  /** Items below the clicked/selected nodes; without a node: everything currently visible. */
  const itemsFor = (arg?: CompareNode, sel?: CompareNode[]): DiffItem[] => {
    const nodes = sel?.length ? sel : arg ? [arg] : [];
    return nodes.length ? collectDiffItems(nodes) : compareTree.visibleItems;
  };

  reg('remoteHost.uploadMany', async (arg?: CompareNode, sel?: CompareNode[]) => {
    if (serverCompare) return vscode.window.showWarningMessage('Hochladen ist nur beim Vergleich Lokal ↔ Server möglich.');
    const c = await getClient();
    if (!c) return;
    const upSel = selectBySource(itemsFor(arg, sel), 'local');
    const stamp = formatStamp(new Date());
    await transferBatch(upSel, `Hochladen auf ${current?.name}`, async (item) => {
      const local = safeLocalPath(toLocal(compareRemoteRoot), item.relPath);
      const remote = path.posix.join(compareRemoteRoot, item.relPath);
      if (item.status === 'modified') await saveBackup(current, stamp, item.relPath, await c.readFile(remote));
      await c.mkdir(path.posix.dirname(remote));
      await uploadPath(c, local, remote);
    }, true, upSel.transfer.filter((i) => isTargetNewer(i, 'local')));
  });

  reg('remoteHost.downloadMany', async (arg?: CompareNode, sel?: CompareNode[]) => {
    const items = itemsFor(arg, sel);
    if (serverCompare) {
      const { a, b, aRoot, bRoot } = serverCompare;
      const pick = await vscode.window.showQuickPick([a.name, b.name], { placeHolder: 'Von welchem Server nach lokal herunterladen?' });
      if (!pick) return;
      const source: TransferSource = pick === a.name ? 'local' : 'remote';
      const server = source === 'local' ? a : b;
      const root = source === 'local' ? aRoot : bRoot;
      const c = await getClientFor(server);
      if (!c) return;
      const stamp = formatStamp(new Date());
      await transferBatch(selectBySource(items, source), `Herunterladen von ${server.name}`, async (item) => {
        const local = localFor(server, root, item.relPath);
        if (!local) throw new Error('Kein lokaler Zielordner (Workspace geöffnet?)');
        if (item.status === 'modified') await backupLocalFile(server, stamp, item.relPath, local);
        await writeLocal(local, await c.readFile(path.posix.join(root, item.relPath)),
          (source === 'local' ? item.local : item.remote)?.mtime);
        log(`↓ ${server.name}: ${path.posix.join(root, item.relPath)}`);
      }, false);
      return;
    }
    const c = await getClient();
    if (!c) return;
    const downSel = selectBySource(items, 'remote');
    const stamp = formatStamp(new Date());
    await transferBatch(downSel, `Herunterladen von ${current?.name}`, async (item) => {
      const local = safeLocalPath(toLocal(compareRemoteRoot), item.relPath);
      if (item.status === 'modified') await backupLocalFile(current, stamp, item.relPath, local);
      await writeLocal(local, await c.readFile(path.posix.join(compareRemoteRoot, item.relPath)), item.remote?.mtime);
      log(`↓ ${current?.name}: ${path.posix.join(compareRemoteRoot, item.relPath)}`);
    }, true, downSel.transfer.filter((i) => isTargetNewer(i, 'remote')));
  });

  // ---- Delete extras (only on one side) ----
  /** Deleting needs an explicit target: never "everything visible" by accident. */
  const nodesGiven = (arg?: CompareNode, sel?: CompareNode[]) => !!(arg || sel?.length);

  reg('remoteHost.deleteRemoteOnly', async (arg?: CompareNode, sel?: CompareNode[]) => {
    if (serverCompare) return vscode.window.showWarningMessage('Löschen ist nur beim Vergleich Lokal ↔ Server möglich.');
    if (!nodesGiven(arg, sel)) return vscode.window.showWarningMessage('Bitte Ordner, Gruppe oder Dateien im Baum auswählen.');
    const c = await getClient();
    if (!c) return;
    const { remove, kept } = selectForDelete(itemsFor(arg, sel), 'remote');
    const stamp = formatStamp(new Date());
    await transferBatch({ transfer: remove, skipped: kept, overwrite: 0 }, `Auf ${current?.name} löschen`, async (item) => {
      const remote = path.posix.join(compareRemoteRoot, item.relPath);
      await saveBackup(current, stamp, item.relPath, await c.readFile(remote));
      await c.remove(remote, false);
      log(`✗ ${current?.name}: ${remote} gelöscht`);
    }, true, [], {
      confirmLabel: 'Löschen', doneWord: 'gelöscht', actionFor: () => 'auf dem Server löschen',
      note: current?.backupBeforeOverwrite
        ? 'Die Dateien werden vorher lokal gesichert (.vscode/remote-host-backup).'
        : 'KEIN Backup (Option "Back up files …" ist aus). Das Löschen kann nicht rückgängig gemacht werden!',
    });
  });

  reg('remoteHost.deleteLocalOnly', async (arg?: CompareNode, sel?: CompareNode[]) => {
    if (serverCompare) return vscode.window.showWarningMessage('Löschen ist nur beim Vergleich Lokal ↔ Server möglich.');
    if (!nodesGiven(arg, sel)) return vscode.window.showWarningMessage('Bitte Ordner, Gruppe oder Dateien im Baum auswählen.');
    const { remove, kept } = selectForDelete(itemsFor(arg, sel), 'local');
    await transferBatch({ transfer: remove, skipped: kept, overwrite: 0 }, 'Lokal löschen', async (item) => {
      const local = safeLocalPath(toLocal(compareRemoteRoot), item.relPath);
      await vscode.workspace.fs.delete(vscode.Uri.file(local), { useTrash: true });
      log(`✗ lokal: ${local} in den Papierkorb verschoben`);
    }, true, [], {
      confirmLabel: 'In den Papierkorb', doneWord: 'gelöscht', actionFor: () => 'lokal löschen (Papierkorb)',
      note: 'Die Dateien werden in den Papierkorb verschoben.',
    });
  });

  reg('remoteHost.compareLayout', async () => {
    const modes: { label: string; id: CompareLayout; description?: string }[] = [
      { label: '$(list-tree) Ordner-Baum', id: 'tree' },
      { label: '$(group-by-ref-type) Nach Status gruppiert', id: 'status' },
      { label: '$(list-flat) Flache Liste', id: 'list' },
    ];
    modes.forEach((m) => { if (m.id === compareTree.layout) m.description = '(aktuell)'; });
    const pick = await vscode.window.showQuickPick(modes, { placeHolder: 'Anzeige der Unterschiede' });
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
      { canPickMany: true, placeHolder: 'Welche Status sollen angezeigt werden?' },
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
    compareView.title = 'Differences';
  });

  // ---- Settings form, Edit Remote File, Select Opened File, SSH ----
  reg('remoteHost.manageServers', () => openServerForm(ctx, reload));

  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      REMOTE_FS_SCHEME,
      new RemoteFileSystem(async (name) => {
        const server = servers.find((s) => s.name === name);
        return server ? getClientFor(server) : undefined;
      }),
      { isCaseSensitive: true },
    ),
  );

  reg('remoteHost.editRemote', async (node: RemoteNode) => {
    if (!current || !node || node.entry.isDirectory) return;
    await vscode.window.showTextDocument(remoteFsUri(current.name, node.entry.path));
  });

  reg('remoteHost.revealOpened', async (uri?: vscode.Uri) => {
    const file = (uri ?? vscode.window.activeTextEditor?.document.uri)?.fsPath;
    const remote = file ? toRemote(file) : undefined;
    const c = await getClient();
    if (!remote || !c) return vscode.window.showWarningMessage('The open file is not inside the mapped local folder.');
    const entries = await c.list(path.posix.dirname(remote)).catch(() => []);
    const entry = entries.find((e) => e.name === path.posix.basename(remote));
    if (!entry) return vscode.window.showInformationMessage('This file does not exist on the server yet.');
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
        await run(`Upload on save → ${server.name}`, async () => {
          await c.mkdir(path.posix.dirname(remote)); // new files may live in a new folder
          const stat = await vscode.workspace.fs.stat(doc.uri);
          await c.writeFile(remote, Buffer.from(await vscode.workspace.fs.readFile(doc.uri)), stat.mtime);
          log(`↑ ${server.name}: ${remote} (beim Speichern)`);
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
