import * as vscode from 'vscode';

/** URI scheme used for nodes in the differences tree. */
export const DIFF_SCHEME = 'remotehostdiff';

export const STATUS_COLORS = {
  modified: 'gitDecoration.modifiedResourceForeground',
  localOnly: 'gitDecoration.addedResourceForeground',
  remoteOnly: 'gitDecoration.untrackedResourceForeground',
  conflict: 'gitDecoration.conflictingResourceForeground',
  unchanged: 'gitDecoration.ignoredResourceForeground',
} as const;

/**
 * Colors the file name and shows a badge in the differences tree (like the
 * Git view). All information is encoded in the URI query: badge, status, tooltip.
 */
export class DiffDecorationProvider implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DIFF_SCHEME) return undefined;
    const q = new URLSearchParams(uri.query);
    const status = q.get('status') as keyof typeof STATUS_COLORS | null;
    const badge = q.get('badge');
    if (!status || !(status in STATUS_COLORS) || !badge) return undefined;
    return new vscode.FileDecoration(badge, q.get('tip') ?? undefined, new vscode.ThemeColor(STATUS_COLORS[status]));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }
}
