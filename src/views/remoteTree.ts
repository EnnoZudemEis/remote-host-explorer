import * as vscode from 'vscode';
import { log } from '../log';
import { t } from '../l10n';
import { RemoteClient, RemoteEntry, ServerConfig } from '../connection/types';

export class RemoteNode extends vscode.TreeItem {
  constructor(public readonly entry: RemoteEntry) {
    super(
      entry.name,
      entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = entry.path; // stable id so TreeView.reveal() works with freshly built nodes
    this.contextValue = entry.isDirectory ? 'dir' : 'file';
    this.resourceUri = vscode.Uri.from({ scheme: 'remotehost', path: entry.path });
    this.iconPath = entry.isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (!entry.isDirectory) {
      this.description = `${formatSize(entry.size)}  ${new Date(entry.mtime).toLocaleString()}`;
    }
    this.tooltip = `${entry.path}\n${entry.permissions ?? ''}`;
  }
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

let lastShownError = '';
let lastShownAt = 0;

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
  private emitter = new vscode.EventEmitter<RemoteNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private getClient: () => Promise<RemoteClient | undefined>,
    private getServer: () => ServerConfig | undefined,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: RemoteNode): vscode.TreeItem {
    return node;
  }

  getParent(node: RemoteNode): RemoteNode | undefined {
    const server = this.getServer();
    if (!server) return undefined;
    const parent = node.entry.path.replace(/\/[^/]+$/, '') || '/';
    const root = server.remotePath.replace(/\/$/, '') || '/';
    if (parent === root || parent.length <= root.length) return undefined;
    return new RemoteNode({ name: parent.split('/').pop()!, path: parent, isDirectory: true, size: 0, mtime: 0 });
  }

  async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
    const server = this.getServer();
    if (!server) return [];
    try {
      const client = await this.getClient();
      if (!client) return [];
      const entries = await client.list(node ? node.entry.path : server.remotePath);
      return entries
        .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
        .map((e) => new RemoteNode(e));
    } catch (err) {
      const msg = (err as Error).message;
      log(`Error loading ${node ? node.entry.path : server.remotePath}: ${msg}`);
      // Show the same error only once in a while instead of one notification per expanded folder.
      if (msg !== lastShownError || Date.now() - lastShownAt > 30000) {
        lastShownError = msg; lastShownAt = Date.now();
        vscode.window.showErrorMessage(t('Remote Host: {0} (details: see the "Remote Host" output)', msg));
      }
      return [];
    }
  }
}
