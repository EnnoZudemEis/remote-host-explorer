import * as vscode from 'vscode';
import { DiffItem, DiffStatus } from '../compare/compare';

export type CompareNode = StatusGroupNode | FolderNode | FileNode;
export type CompareLayout = 'tree' | 'status' | 'list';

import { DIFF_SCHEME, STATUS_COLORS } from './diffDecorations';

const BADGES: Record<DiffStatus, string> = { modified: 'M', localOnly: 'L', remoteOnly: 'R', conflict: 'C', unchanged: '=' };

/** Display order of statuses (groups, filter). */
export const STATUS_ORDER: DiffStatus[] = ['modified', 'localOnly', 'remoteOnly', 'conflict', 'unchanged'];

/** Display names per status; server names replace "Lokal"/"Remote" in server comparisons. */
export function statusNames(labels?: ServerLabels): Record<DiffStatus, string> {
  return {
    modified: 'Geändert',
    localOnly: `Nur ${labels?.a ?? 'Lokal'}`,
    remoteOnly: `Nur ${labels?.b ?? 'Remote'}`,
    conflict: 'Typ-Konflikt',
    unchanged: 'Unverändert',
  };
}

export function fmtSize(n?: number): string {
  if (n === undefined) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const fmtTime = (t?: number) => (t === undefined ? '–' : new Date(t).toLocaleString());

/** Set for server-to-server comparison: names of server A and server B. */
export interface ServerLabels {
  a: string;
  b: string;
}

/** Human readable status label, including which side is newer. */
export function statusLabel(item: DiffItem, labels?: ServerLabels): string {
  const l = labels?.a ?? 'Lokal';
  const r = labels?.b ?? 'Remote';
  switch (item.status) {
    case 'localOnly': return `Nur ${l}`;
    case 'remoteOnly': return `Nur ${r}`;
    case 'unchanged': return 'Unverändert';
    case 'conflict': {
      const kind = (e?: { isDirectory: boolean }) => (e?.isDirectory ? 'Ordner' : 'Datei');
      return `Typ-Konflikt (${l}: ${kind(item.local)}, ${r}: ${kind(item.remote)})`;
    }
    default: {
      const lm = item.local?.mtime, rm = item.remote?.mtime;
      if (lm !== undefined && rm !== undefined && lm !== rm) return `${lm > rm ? l : r} neuer`;
      return 'Geändert';
    }
  }
}

function tooltipFor(item: DiffItem, labels?: ServerLabels): vscode.MarkdownString {
  const l = labels?.a ?? 'Lokal';
  const r = labels?.b ?? 'Remote';
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${item.relPath}**\n\n*${statusLabel(item, labels)}*\n\n`);
  md.appendMarkdown('| | Größe | Geändert |\n|---|---|---|\n');
  md.appendMarkdown(`| ${l} | ${item.local?.isDirectory ? 'Ordner' : fmtSize(item.local?.size)} | ${fmtTime(item.local?.mtime)} |\n`);
  md.appendMarkdown(`| ${r} | ${item.remote?.isDirectory ? 'Ordner' : fmtSize(item.remote?.size)} | ${fmtTime(item.remote?.mtime)} |\n`);
  return md;
}

export type Counts = Record<DiffStatus, number>;

export function countStatuses(items: DiffItem[]): Counts {
  const c: Counts = { modified: 0, localOnly: 0, remoteOnly: 0, conflict: 0, unchanged: 0 };
  for (const i of items) c[i.status]++;
  return c;
}

/** e.g. "3 geändert · 2 nur lokal · 1 nur remote" */
export function summaryText(items: DiffItem[], labels?: ServerLabels): string {
  const c = countStatuses(items);
  const l = labels?.a ?? 'lokal';
  const r = labels?.b ?? 'remote';
  return [
    c.modified && `${c.modified} geändert`,
    c.localOnly && `${c.localOnly} nur ${l}`,
    c.remoteOnly && `${c.remoteOnly} nur ${r}`,
    c.conflict && `${c.conflict} Typ-Konflikt${c.conflict > 1 ? 'e' : ''}`,
  ].filter(Boolean).join(' · ');
}

export class FolderNode extends vscode.TreeItem {
  children: CompareNode[] = [];
  constructor(public readonly relPath: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = vscode.ThemeIcon.Folder;
    this.contextValue = 'compareFolder';
  }
  /** Number of differing files below this folder (identical files are not counted). */
  count(): number {
    return this.children.reduce(
      (n, c) => n + (c instanceof FolderNode ? c.count() : c instanceof FileNode && c.item.status === 'unchanged' ? 0 : 1), 0);
  }
}

const GROUP_ICONS: Record<DiffStatus, string> = {
  modified: 'diff-modified', localOnly: 'diff-added', remoteOnly: 'diff-removed', conflict: 'warning', unchanged: 'pass',
};

/** Top-level group node when the layout is "grouped by status". */
export class StatusGroupNode extends vscode.TreeItem {
  children: CompareNode[] = [];
  constructor(public readonly status: DiffStatus, title: string, public readonly total: number) {
    super(title, vscode.TreeItemCollapsibleState.Expanded);
    this.description = String(total);
    this.iconPath = new vscode.ThemeIcon(GROUP_ICONS[status], new vscode.ThemeColor(STATUS_COLORS[status]));
    this.contextValue = 'compareGroup';
  }
}

export class FileNode extends vscode.TreeItem {
  constructor(public readonly item: DiffItem, labels?: ServerLabels, showDir = false) {
    super(item.relPath.split('/').pop()!, vscode.TreeItemCollapsibleState.None);
    const label = statusLabel(item, labels);
    const q = new URLSearchParams({ status: item.status, badge: BADGES[item.status], tip: label });
    // resourceUri: file-type icon from the icon theme + colored name/badge via DiffDecorationProvider
    this.resourceUri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${item.relPath}`, query: q.toString() });
    const dir = item.relPath.includes('/') ? item.relPath.slice(0, item.relPath.lastIndexOf('/')) : '';
    this.description = showDir && dir ? `${label} · ${dir}` : label;
    this.contextValue = `${labels ? 'compareRR' : 'compare'}-${item.status}`;
    this.tooltip = tooltipFor(item, labels);
    this.command = { command: 'remoteHost.diffItem', title: 'Show Diff', arguments: [this] };
  }
}

/** All differing files below the given nodes (folders and status groups are resolved recursively). */
export function collectDiffItems(nodes: CompareNode[]): DiffItem[] {
  const out: DiffItem[] = [];
  const walk = (n: CompareNode) => {
    if (n instanceof FileNode) out.push(n.item);
    else n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export class CompareTreeProvider implements vscode.TreeDataProvider<CompareNode> {
  private emitter = new vscode.EventEmitter<CompareNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: CompareNode[] = [];
  items: DiffItem[] = [];
  private labels?: ServerLabels;
  layout: CompareLayout = 'tree';
  /** Statuses currently hidden by the filter. */
  hidden = new Set<DiffStatus>();

  /** Items that pass the status filter. */
  get visibleItems(): DiffItem[] {
    return this.items.filter((i) => !this.hidden.has(i.status));
  }

  setItems(items: DiffItem[], labels?: ServerLabels): void {
    this.items = items;
    this.labels = labels;
    this.rebuild();
  }

  setLayout(layout: CompareLayout): void {
    this.layout = layout;
    this.rebuild();
  }

  setHidden(hidden: Set<DiffStatus>): void {
    this.hidden = hidden;
    this.rebuild();
  }

  removeItem(relPath: string): void {
    this.removeItems([relPath]);
  }

  /** Removes several entries with a single rebuild. */
  removeItems(relPaths: string[]): void {
    const gone = new Set(relPaths);
    this.setItems(this.items.filter((i) => !gone.has(i.relPath)), this.labels);
  }

  private rebuild(): void {
    const items = this.visibleItems;
    const l = this.labels;
    if (this.layout === 'list') {
      this.roots = items.map((i) => new FileNode(i, l, true));
    } else if (this.layout === 'status') {
      const names = statusNames(l);
      this.roots = STATUS_ORDER
        .map((st) => ({ st, group: items.filter((i) => i.status === st) }))
        .filter((g) => g.group.length)
        .map(({ st, group }) => {
          const node = new StatusGroupNode(st, names[st], group.length);
          node.children = buildTree(group, l);
          return node;
        });
    } else {
      this.roots = buildTree(items, l);
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(n: CompareNode): vscode.TreeItem {
    return n;
  }

  getChildren(n?: CompareNode): CompareNode[] {
    if (!n) return this.roots;
    return n instanceof FileNode ? [] : n.children;
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
  compactFolders(roots);
  for (const f of folders.values()) f.description = String(f.count());
  return roots;
}

/** Merges chains of single-child folders into one node ("a/b/c"), like VS Code's compact folders. */
function compactFolders(nodes: CompareNode[]): void {
  for (const n of nodes) {
    if (!(n instanceof FolderNode)) continue;
    while (n.children.length === 1 && n.children[0] instanceof FolderNode) {
      const child = n.children[0] as FolderNode;
      n.label = `${n.label as string}/${child.label as string}`;
      n.children = child.children;
    }
    compactFolders(n.children);
  }
}
