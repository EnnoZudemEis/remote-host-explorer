/** Which local files still have to be uploaded to which server. No VS Code dependency (unit-testable). */

export interface ServerPending {
  /** True once the list was matched against the real server content (or built from uploads since). */
  reconciled: boolean;
  /** Workspace relative paths (posix) that are not on this server yet or differ from it. */
  pending: Record<string, true>;
  /** Content hash of the version last transferred to / from this server, per path. */
  synced: Record<string, string>;
}

export type PendingData = Record<string, ServerPending>;

/** Upper bound for remembered hashes per server (oldest are dropped first). */
const MAX_SYNCED = 20000;

export class PendingState {
  private data: PendingData;

  constructor(data?: PendingData) {
    this.data = {};
    for (const [name, sp] of Object.entries(data ?? {})) {
      this.data[name] = { reconciled: !!sp.reconciled, pending: { ...sp.pending }, synced: { ...sp.synced } };
    }
  }

  toJSON(): PendingData {
    return this.data;
  }

  private server(name: string): ServerPending {
    return (this.data[name] ??= { reconciled: false, pending: {}, synced: {} });
  }

  /**
   * A local file changed. It becomes pending for the server unless its content equals the version last
   * synced with that server (e.g. a change that was undone, or a file that was just downloaded from it).
   */
  markChanged(server: string, rel: string, hash?: string): void {
    const sp = this.server(server);
    if (hash !== undefined && sp.synced[rel] === hash) delete sp.pending[rel];
    else sp.pending[rel] = true;
  }

  /** The file now equals the server version (after an upload or a download). Other servers are untouched. */
  markSynced(server: string, rel: string, hash?: string): void {
    const sp = this.server(server);
    delete sp.pending[rel];
    if (hash === undefined) { delete sp.synced[rel]; return; }
    delete sp.synced[rel]; // re-insert so the newest entry is last
    sp.synced[rel] = hash;
    const keys = Object.keys(sp.synced);
    for (let i = 0; i < keys.length - MAX_SYNCED; i++) delete sp.synced[keys[i]];
  }

  /** "Done" without transferring (the user dismisses an entry). */
  dismiss(server: string, rel: string): void {
    delete this.server(server).pending[rel];
  }

  /** Drops the entries of a server that match (e.g. paths that are excluded now). Returns how many were dropped. */
  removeWhere(server: string, predicate: (rel: string) => boolean): number {
    const pending = this.data[server]?.pending;
    if (!pending) return 0;
    let n = 0;
    for (const rel of Object.keys(pending)) if (predicate(rel)) { delete pending[rel]; n++; }
    return n;
  }

  /** The local file no longer exists: nothing left to upload, for every server. */
  removeEverywhere(rel: string): void {
    for (const sp of Object.values(this.data)) { delete sp.pending[rel]; delete sp.synced[rel]; }
  }

  /** Replaces the list of a server by the result of a comparison with the real server content. */
  reconcile(server: string, rels: string[]): void {
    const sp = this.server(server);
    sp.pending = {};
    for (const r of rels) sp.pending[r] = true;
    sp.reconciled = true;
  }

  /** Forgets servers that no longer exist. */
  prune(serverNames: string[]): void {
    const keep = new Set(serverNames);
    for (const name of Object.keys(this.data)) if (!keep.has(name)) delete this.data[name];
  }

  list(server: string): string[] {
    return Object.keys(this.data[server]?.pending ?? {}).sort((a, b) => a.localeCompare(b));
  }

  /** Entries inside a folder (workspace relative, posix), at any depth. */
  listUnder(server: string, folder: string): string[] {
    const prefix = folder.replace(/\/+$/, '') + '/';
    return this.list(server).filter((rel) => rel.startsWith(prefix));
  }

  count(server: string): number {
    return Object.keys(this.data[server]?.pending ?? {}).length;
  }

  total(): number {
    return Object.keys(this.data).reduce((n, s) => n + this.count(s), 0);
  }

  isReconciled(server: string): boolean {
    return !!this.data[server]?.reconciled;
  }
}
