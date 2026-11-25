/** Progress bookkeeping of a multi-file transfer. Pure logic, no VS Code dependency (unit-testable). */

export function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** "45 s", "3 min 20 s", "1 h 05 min". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export interface TransferSnapshot {
  /** 1-based number of the file being transferred (capped at totalFiles). */
  fileNumber: number;
  totalFiles: number;
  /** Name of the current file, '' before the first one starts. */
  name: string;
  fileBytes: number;
  fileSize: number;
  doneBytes: number;
  totalBytes: number;
  /** 0..100, by bytes (by files if the total size is unknown or 0). */
  percent: number;
  /** Bytes per second over the last few seconds, undefined while there is too little data. */
  speed?: number;
  /** Estimated seconds left, undefined while it cannot be estimated. */
  etaSeconds?: number;
  elapsedMs: number;
}

const SPEED_WINDOW_MS = 3000;
const MIN_SPEED_SPAN_MS = 500;
const MIN_ETA_ELAPSED_MS = 1000;

export class TransferTracker {
  private doneFiles = 0;
  private doneBytes = 0;
  private name = '';
  private fileSize = 0;
  private fileBytes = 0;
  private readonly started: number;
  private samples: { t: number; bytes: number }[] = [];

  constructor(
    private readonly totalFiles: number,
    private readonly totalBytes: number,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
    this.samples.push({ t: this.started, bytes: 0 });
  }

  startFile(name: string, size: number): void {
    this.name = name;
    this.fileSize = Math.max(0, size);
    this.fileBytes = 0;
  }

  /** Bytes of the current file transferred so far (cumulative, as the FTP/SFTP clients report them). */
  addBytes(bytesOfCurrentFile: number): void {
    this.fileBytes = Math.max(0, bytesOfCurrentFile);
    this.sample();
  }

  finishFile(): void {
    this.doneBytes += Math.max(this.fileSize, this.fileBytes);
    this.doneFiles++;
    this.fileBytes = 0;
    this.fileSize = 0;
    this.sample();
  }

  get files(): number { return this.doneFiles; }
  get bytes(): number { return this.doneBytes + this.fileBytes; }

  private sample(): void {
    const t = this.now();
    this.samples.push({ t, bytes: this.bytes });
    // keep one sample older than the window so the span stays meaningful
    while (this.samples.length > 2 && t - this.samples[1].t > SPEED_WINDOW_MS) this.samples.shift();
  }

  snapshot(): TransferSnapshot {
    const t = this.now();
    const bytes = this.bytes;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const span = last.t - first.t;
    const speed = span >= MIN_SPEED_SPAN_MS && last.bytes > first.bytes ? ((last.bytes - first.bytes) * 1000) / span : undefined;
    const elapsedMs = t - this.started;
    const left = Math.max(0, this.totalBytes - bytes);
    const etaSeconds = speed && this.totalBytes > 0 && elapsedMs >= MIN_ETA_ELAPSED_MS ? left / speed : undefined;
    const raw = this.totalBytes > 0 ? (bytes / this.totalBytes) * 100 : this.totalFiles > 0 ? (this.doneFiles / this.totalFiles) * 100 : 0;
    return {
      fileNumber: Math.min(this.doneFiles + 1, Math.max(this.totalFiles, 1)),
      totalFiles: this.totalFiles,
      name: this.name,
      fileBytes: this.fileBytes,
      fileSize: this.fileSize,
      doneBytes: bytes,
      totalBytes: this.totalBytes,
      percent: Math.min(100, Math.max(0, raw)),
      speed,
      etaSeconds,
      elapsedMs,
    };
  }
}
