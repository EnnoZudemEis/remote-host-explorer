/** Line based difference blocks of two texts, no VS Code dependency (unit-testable). */

/** A changed block: lines [aStart, aEnd) of text A correspond to lines [bStart, bEnd) of text B. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Splits into lines without the line terminators (CRLF and LF); a trailing newline adds no empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === '' && /[\r\n]$/.test(text)) lines.pop();
  return lines;
}

/** Above this many table cells a single block is reported instead of an exact diff. */
const MAX_CELLS = 4_000_000;

/**
 * Difference blocks between the line arrays a and b (longest common subsequence). Common first and
 * last lines are skipped. Very large inputs with many differences fall back to one block.
 */
export function computeHunks(a: string[], b: string[]): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    return [{ aStart: pre, aEnd: pre + n, bStart: pre, bEnd: pre + m }];
  }
  // lcs[i][j]: length of the common subsequence of a[pre+i..] and b[pre+j..]
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[pre + i] === b[pre + j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | undefined;
  const close = () => { if (open) { hunks.push(open); open = undefined; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      close();
      i++; j++;
    } else {
      open ??= { aStart: pre + i, aEnd: pre + i, bStart: pre + j, bEnd: pre + j };
      if (j < m && (i === n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { j++; open.bEnd = pre + j; }
      else { i++; open.aEnd = pre + i; }
    }
  }
  close();
  return hunks;
}

/** Text A with the lines of hunk h replaced by the corresponding lines of B (the block "moves" B to A). */
export function applyHunk(a: string[], b: string[], h: Hunk): string[] {
  return [...a.slice(0, h.aStart), ...b.slice(h.bStart, h.bEnd), ...a.slice(h.aEnd)];
}
