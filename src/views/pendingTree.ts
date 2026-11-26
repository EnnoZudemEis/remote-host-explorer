import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../l10n';
import { ServerConfig } from '../connection/types';
import { PendingState } from '../pending/pendingState';

export class PendingServerNode extends vscode.TreeItem {
  constructor(public readonly server: ServerConfig, count: number, reconciled: boolean) {
    super(server.name, count || !reconciled ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.id = `server:${server.name}`;
    this.contextValue = 'pendingServer';
    this.iconPath = new vscode.ThemeIcon('server');
    this.description = reconciled || count ? t('{0} to upload', count) : t('not compared yet');
    this.tooltip = `${server.protocol}://${server.host}${server.remotePath}`
      + (reconciled ? '' : `\n${t('Only changes made since tracking started are listed. Use "Compare with Server" to include older differences.')}`);
  }
}

export class PendingFileNode extends vscode.TreeItem {
  constructor(public readonly server: ServerConfig, public readonly rel: string, public readonly local: vscode.Uri) {
    super(path.posix.basename(rel), vscode.TreeItemCollapsibleState.None);
    this.id = `file:${server.name}:${rel}`;
    this.contextValue = 'pendingFile';
    this.resourceUri = local;
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = `${rel}\n→ ${server.name}`;
    this.command = { command: 'remoteHost.pending.open', title: t('Compare with Server'), arguments: [this] };
  }
}

export class PendingFolderNode extends vscode.TreeItem {
  children: (PendingFolderNode | PendingFileNode)[] = [];
  constructor(public readonly server: ServerConfig, public rel: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${server.name}:${rel}`;
    this.contextValue = 'pendingFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
  }

  count(): number {
    return this.children.reduce((n, c) => n + (c instanceof PendingFolderNode ? c.count() : 1), 0);
  }
}

export class PendingHintNode extends vscode.TreeItem {
  constructor(public readonly server: ServerConfig) {
    super(t('Not compared yet. Click to compare with the server.'), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'pendingHint';
    this.iconPath = new vscode.ThemeIcon('info');
    this.command = { command: 'remoteHost.pending.reconcile', title: t('Compare with Server'), arguments: [this] };
  }
}

export type PendingNode = PendingServerNode | PendingFolderNode | PendingFileNode | PendingHintNode;

/** Per server: the local files that still have to be uploaded there. */
export class PendingTreeProvider implements vscode.TreeDataProvider<PendingNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private state: () => PendingState,
    private servers: () => ServerConfig[],
    private workspaceRoot: () => string | undefined,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: PendingNode): vscode.TreeItem {
    return node;
  }

  getChildren(node?: PendingNode): PendingNode[] {
    const state = this.state();
    if (!node) {
      return this.servers().map((s) => new PendingServerNode(s, state.count(s.name), state.isReconciled(s.name)));
    }
    if (node instanceof PendingServerNode) {
      const root = this.workspaceRoot();
      const files = state.list(node.server.name);
      if (!files.length && !state.isReconciled(node.server.name)) return [new PendingHintNode(node.server)];
      return root ? buildTree(node.server, files, root) : [];
    }
    if (node instanceof PendingFolderNode) return node.children;
    return [];
  }
}

/** Groups the pending files of a server by folder; folders come first, single-child folder chains are merged. */
function buildTree(server: ServerConfig, files: string[], root: string): (PendingFolderNode | PendingFileNode)[] {
  const roots: (PendingFolderNode | PendingFileNode)[] = [];
  const folders = new Map<string, PendingFolderNode>();
  const folderFor = (rel: string): (PendingFolderNode | PendingFileNode)[] => {
    if (!rel) return roots;
    let f = folders.get(rel);
    if (!f) {
      const parts = rel.split('/');
      f = new PendingFolderNode(server, rel, parts[parts.length - 1]);
      folders.set(rel, f);
      folderFor(parts.slice(0, -1).join('/')).push(f);
    }
    return f.children;
  };
  for (const rel of files) {
    folderFor(path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel))
      .push(new PendingFileNode(server, rel, vscode.Uri.file(path.join(root, ...rel.split('/')))));
  }
  const finish = (nodes: (PendingFolderNode | PendingFileNode)[]) => {
    for (const n of nodes) {
      if (!(n instanceof PendingFolderNode)) continue;
      while (n.children.length === 1 && n.children[0] instanceof PendingFolderNode) {
        const child = n.children[0];
        n.label = `${n.label as string}/${child.label as string}`;
        n.rel = child.rel; // actions on the merged node apply to the deepest folder (it holds everything)
        n.id = child.id;
        n.children = child.children;
      }
      finish(n.children);
      n.description = String(n.count());
    }
    nodes.sort((a, b) => Number(b instanceof PendingFolderNode) - Number(a instanceof PendingFolderNode)
      || String(a.label).localeCompare(String(b.label)));
  };
  finish(roots);
  return roots;
}
