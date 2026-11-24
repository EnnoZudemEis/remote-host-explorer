import { DiffItem } from './compare';

/** Pure selection logic for bulk upload/download (no VS Code dependency). */

/** The side a transfer copies FROM: local (upload) or remote (download). */
export type TransferSource = 'local' | 'remote';

export interface TransferSelection {
  /** Items that exist on the source side and can be copied. */
  transfer: DiffItem[];
  /** Everything else (conflicts, identical files, files only on the other side). */
  skipped: DiffItem[];
  /** How many of the transferred files already exist on the target and will be overwritten. */
  overwrite: number;
}

export function selectBySource(items: DiffItem[], source: TransferSource): TransferSelection {
  const only = source === 'local' ? 'localOnly' : 'remoteOnly';
  const transfer: DiffItem[] = [];
  const skipped: DiffItem[] = [];
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.relPath)) continue; // folder and its children both selected
    seen.add(i.relPath);
    (i.status === 'modified' || i.status === only ? transfer : skipped).push(i);
  }
  return { transfer, skipped, overwrite: transfer.filter((i) => i.status === 'modified').length };
}

/**
 * True if the file on the target side is newer than on the source side, i.e. the transfer would
 * overwrite a more recent version. Only meaningful for 'modified' items with both timestamps.
 */
export function isTargetNewer(item: DiffItem, source: TransferSource, toleranceMs = 2000): boolean {
  if (item.status !== 'modified' || !item.local || !item.remote) return false;
  const src = source === 'local' ? item.local.mtime : item.remote.mtime;
  const dst = source === 'local' ? item.remote.mtime : item.local.mtime;
  return dst - src > toleranceMs;
}
