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
    const dir = path.posix.dirname(rel);
    this.description = dir === '.' ? undefined : dir;
    this.tooltip = `${rel}\n→ ${server.name}`;
    this.command = { command: 'remoteHost.pending.open', title: t('Compare with Server'), arguments: [this] };
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

export type PendingNode = PendingServerNode | PendingFileNode | PendingHintNode;

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
      return root ? files.map((rel) => new PendingFileNode(node.server, rel, vscode.Uri.file(path.join(root, ...rel.split('/'))))) : [];
    }
    return [];
  }
}
