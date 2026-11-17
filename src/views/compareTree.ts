import * as vscode from 'vscode';
import { DiffItem, DiffStatus } from '../compare/compare';

export type CompareNode = FolderNode | FileNode;

const ICONS: Record<DiffStatus, { icon: string; color: string; label: string }> = {
  modified: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground', label: 'changed' },
  localOnly: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground', label: 'only local' },
  remoteOnly: { icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground', label: 'only remote' },
};

export class FolderNode extends vscode.TreeItem {
  children: CompareNode[] = [];
  constructor(public readonly relPath: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'compareFolder';
  }
}

/** Set for server-to-server comparison: names of server A and server B. */
export interface ServerLabels {
  a: string;
  b: string;
}

export class FileNode extends vscode.TreeItem {
  constructor(public readonly item: DiffItem, labels?: ServerLabels) {
    super(item.relPath.split('/').pop()!, vscode.TreeItemCollapsibleState.None);
    const i = ICONS[item.status];
    this.description = labels
      ? { modified: 'changed', localOnly: `only ${labels.a}`, remoteOnly: `only ${labels.b}` }[item.status]
      : i.label;
    this.iconPath = new vscode.ThemeIcon(i.icon, new vscode.ThemeColor(i.color));
    this.contextValue = `${labels ? 'compareRR' : 'compare'}-${item.status}`;
    this.tooltip = item.relPath;
    this.command = { command: 'remoteHost.diffItem', title: 'Show Diff', arguments: [this] };
  }
}

export class CompareTreeProvider implements vscode.TreeDataProvider<CompareNode> {
  private emitter = new vscode.EventEmitter<CompareNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: CompareNode[] = [];
  items: DiffItem[] = [];
  private labels?: ServerLabels;

  setItems(items: DiffItem[], labels?: ServerLabels): void {
    this.items = items;
    this.labels = labels;
    this.roots = buildTree(items, labels);
    this.emitter.fire(undefined);
  }

  removeItem(relPath: string): void {
    this.setItems(this.items.filter((i) => i.relPath !== relPath), this.labels);
  }

  getTreeItem(n: CompareNode): vscode.TreeItem {
    return n;
  }

  getChildren(n?: CompareNode): CompareNode[] {
    if (!n) return this.roots;
    return n instanceof FolderNode ? n.children : [];
  }
}

function buildTree(items: DiffItem[], labels?: ServerLabels): CompareNode[] {
  const roots: CompareNode[] = [];
  const folders = new Map<string, FolderNode>();
  const folderFor = (rel: string): CompareNode[] => {
    if (!rel) return roots;
    let f = folders.get(rel);
    if (!f) {
      const parts = rel.split('/');
      f = new FolderNode(rel, parts[parts.length - 1]);
      folders.set(rel, f);
      folderFor(parts.slice(0, -1).join('/')).push(f);
    }
    return f.children;
  };
  for (const item of items) {
    const parts = item.relPath.split('/');
    folderFor(parts.slice(0, -1).join('/')).push(new FileNode(item, labels));
  }
  return roots;
}
