import * as vscode from 'vscode';
import * as path from 'path';
import { loadServers, saveServers, configUri, passwordKey } from './config/config';
import { createClient } from './connection/factory';
import { expandHome } from './connection/sftpClient';
import { RemoteClient, RemoteEntry, ServerConfig } from './connection/types';
import { RemoteNode, RemoteTreeProvider } from './views/remoteTree';
import { CompareLayout, CompareNode, CompareTreeProvider, collectDiffItems, FileNode, ServerLabels, STATUS_ORDER, statusNames, summaryText } from './views/compareTree';
import { DiffDecorationProvider } from './views/diffDecorations';
import { compareTrees, DiffItem, DiffStatus, isDifference, Side } from './compare/compare';
import { selectBySource, TransferSource } from './compare/transfer';
import { mapToRemote } from './connection/paths';
import { makeExcluder } from './compare/glob';
import { RemoteFileSystem, REMOTE_FS_SCHEME, remoteFsUri } from './fs/remoteFs';
import { openServerForm } from './views/serverForm';

export function activate(ctx: vscode.ExtensionContext) {
  let servers: ServerConfig[] = [];
  let current: ServerConfig | undefined;
  const clients = new Map<string, RemoteClient>(); // one connection per server name

  const dropClient = async () => {
    for (const c of clients.values()) {
      try { await c.close(); } catch { /* ignore */ }
    }
    clients.clear();
  };

  const getClientFor = async (server: ServerConfig): Promise<RemoteClient | undefined> => {
    let client = clients.get(server.name);
    if (!client) {
      let pw = await ctx.secrets.get(passwordKey(server));
      if (pw === undefined) {
        // Config written by hand: ask once and remember in the keychain.
        pw = await vscode.window.showInputBox({
          prompt: `Password for ${server.username}@${server.host} (${server.name})`,
          password: true,
          ignoreFocusOut: true,
        });
        if (pw === undefined) return undefined;
      }
      client = await createClient(server, pw);
      clients.set(server.name, client);
      await ctx.secrets.store(passwordKey(server), pw); // only after a successful login
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
    servers = await loadServers();
    if (!current || !servers.find((s) => s.name === current!.name)) current = servers[0];
    else current = servers.find((s) => s.name === current!.name); // pick up edited settings
    await refreshUi();
    await dropClient();
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
  const toLocal = (remote: string) =>
    path.join(localRoot()!, path.posix.relative(current!.remotePath, remote).split('/').join(path.sep));

  const run = <T>(title: string, fn: () => Promise<T>) =>
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
      try { return await fn(); } catch (e) { vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`); }
    });

  async function uploadPath(c: RemoteClient, local: string, remote: string, server = current): Promise<void> {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(local));
    if (stat.type & vscode.FileType.Directory) {
      await c.mkdir(remote);
      for (const [name] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(local))) {
        if (isExcluded(path.posix.join(remote, name), server)) continue;
        await uploadPath(c, path.join(local, name), path.posix.join(remote, name), server);
      }
    } else {
      await c.writeFile(remote, Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(local))));
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
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(local), await c.readFile(e.path));
    }
  }

  /** Exclude patterns of a server (default: the active one), applied to a remote path. */
  function isExcluded(remotePath: string, server = current): boolean {
    if (!server) return false;
    const rel = path.posix.relative(server.remotePath, remotePath);
    return makeExcluder(server.exclude)(rel, path.posix.basename(remotePath));
  }

  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

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
        if (!c) return '';
        try {
          return (await c.readFile(uri.path)).toString('utf8');
        } catch {
          return ''; // file does not exist remotely
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
    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Comparing with ${current.name}`, cancellable: true },
      async (progress, token) => {
        try {
          return await compareTrees(localSide, remoteSide(c), local, remote, {
            includeUnchanged: true,
            exclude: current!.exclude,
            mtimeToleranceMs: current!.protocol === 'sftp' ? 2000 : 120000,
            isCancelled: () => token.isCancellationRequested,
            onProgress: (p) => progress.report({ message: p }),
          });
        } catch (e) {
          vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
          return undefined;
        }
      },
    );
    if (!items) return;
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
    local: path.join(toLocal(compareRemoteRoot), ...compareRel(n).split('/')),
    remote: path.posix.join(compareRemoteRoot, compareRel(n)),
  });
  // relPath is relative to the compared folder
  const compareRel = (n: FileNode) => n.item.relPath;

  // ---- Server <-> Server comparison (e.g. Test vs. Live) ----
  const localFor = (server: ServerConfig, root: string, rel: string) => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return undefined;
    const base = path.join(ws, server.localPath, ...path.posix.relative(server.remotePath, root).split('/'));
    return path.join(base, ...rel.split('/'));
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
    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Comparing ${a.name} with ${b.name}`, cancellable: true },
      async (progress, token) => {
        try {
          return await compareTrees(remoteSide(ca), remoteSide(cb), aRoot, bRoot, {
            includeUnchanged: true,
            exclude: [...new Set([...(a.exclude ?? []), ...(b.exclude ?? [])])],
            mtimeToleranceMs: Math.max(a.protocol === 'sftp' ? 2000 : 120000, b.protocol === 'sftp' ? 2000 : 120000),
            isCancelled: () => token.isCancellationRequested,
            onProgress: (p) => progress.report({ message: p }),
          });
        } catch (e) {
          vscode.window.showErrorMessage(`Remote Host: ${(e as Error).message}`);
          return undefined;
        }
      },
    );
    if (!items) return;
    serverCompare = { a, b, aRoot, bRoot };
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
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(local), await c.readFile(path.posix.join(root, n.item.relPath)));
    });
    vscode.window.showInformationMessage(`Saved to ${local}`);
  };
  reg('remoteHost.downloadFromA', (n: FileNode) => downloadFrom(n, 'a'));
  reg('remoteHost.downloadFromB', (n: FileNode) => downloadFrom(n, 'b'));

  const warnConflict = (n: FileNode) =>
    vscode.window.showWarningMessage(
      `Typ-Konflikt bei "${n.item.relPath}": auf einer Seite eine Datei, auf der anderen ein Ordner. Bitte manuell auflösen.`);

  reg('remoteHost.diffItem', async (n: FileNode) => {
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

  reg('remoteHost.uploadItem', async (n: FileNode) => {
    const c = await getClient();
    if (!c) return;
    const { local, remote } = itemPaths(n);
    if (n.item.status === 'remoteOnly') return vscode.window.showWarningMessage('File only exists remotely.');
    await run(`Uploading ${path.basename(local)}`, async () => {
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
    await run(`Downloading ${path.basename(local)}`, async () => {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(local), await c.readFile(remote));
    });
    compareTree.removeItem(n.item.relPath);
    refreshCompareView();
  });

  // ---- Bulk transfer (folder, status group, selection or everything visible) ----
  /** Confirms, runs with progress/cancel, collects errors and removes transferred entries. */
  const transferBatch = async (
    sel: { transfer: DiffItem[]; skipped: DiffItem[]; overwrite: number },
    title: string,
    op: (item: DiffItem) => Promise<void>,
    removeDone: boolean,
  ) => {
    if (!sel.transfer.length) {
      return vscode.window.showInformationMessage(
        `Nichts zu übertragen${sel.skipped.length ? ` (${sel.skipped.length} übersprungen)` : ''}.`);
    }
    const names = sel.transfer.slice(0, 10).map((i) => `• ${i.relPath}`);
    if (sel.transfer.length > 10) names.push(`… und ${sel.transfer.length - 10} weitere`);
    const ok = await vscode.window.showWarningMessage(
      `${title}: ${sel.transfer.length} Datei(en)`
        + `${sel.overwrite ? `, davon ${sel.overwrite} werden überschrieben` : ''}`
        + `${sel.skipped.length ? `, ${sel.skipped.length} übersprungen` : ''}.`,
      { modal: true, detail: names.join('\n') }, 'Start');
    if (ok !== 'Start') return;
    const done: string[] = [];
    const failed: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        for (const item of sel.transfer) {
          if (token.isCancellationRequested) break;
          progress.report({ message: item.relPath, increment: 100 / sel.transfer.length });
          try { await op(item); done.push(item.relPath); } catch (e) { failed.push(`${item.relPath}: ${(e as Error).message}`); }
        }
      },
    );
    if (removeDone) {
      compareTree.removeItems(done);
      refreshCompareView();
    }
    const left = sel.transfer.length - done.length - failed.length;
    const msg = `${done.length} übertragen${failed.length ? `, ${failed.length} Fehler` : ''}${left ? `, ${left} abgebrochen` : ''}.`;
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
    await transferBatch(selectBySource(itemsFor(arg, sel), 'local'), `Hochladen auf ${current?.name}`, async (item) => {
      const local = path.join(toLocal(compareRemoteRoot), ...item.relPath.split('/'));
      const remote = path.posix.join(compareRemoteRoot, item.relPath);
      await c.mkdir(path.posix.dirname(remote));
      await uploadPath(c, local, remote);
    }, true);
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
      await transferBatch(selectBySource(items, source), `Herunterladen von ${server.name}`, async (item) => {
        const local = localFor(server, root, item.relPath);
        if (!local) throw new Error('Kein lokaler Zielordner (Workspace geöffnet?)');
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(local), await c.readFile(path.posix.join(root, item.relPath)));
      }, false);
      return;
    }
    const c = await getClient();
    if (!c) return;
    await transferBatch(selectBySource(items, 'remote'), `Herunterladen von ${current?.name}`, async (item) => {
      const local = path.join(toLocal(compareRemoteRoot), ...item.relPath.split('/'));
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(local)));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(local), await c.readFile(path.posix.join(compareRemoteRoot, item.relPath)));
    }, true);
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
      if (!current?.uploadOnSave) return;
      const remote = toRemote(doc.uri.fsPath);
      if (!remote || isExcluded(remote)) return;
      const c = await getClient();
      if (c) {
        await run('Upload on save', async () => {
          await c.mkdir(path.posix.dirname(remote)); // new files may live in a new folder
          await c.writeFile(remote, Buffer.from(await vscode.workspace.fs.readFile(doc.uri)));
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
