/** Converts .gitignore text into exclude patterns understood by makeExcluder (no VS Code dependency). */

export interface GitignoreResult {
  patterns: string[];
  /** Negations ("!keep.txt") are not supported and skipped. */
  unsupported: number;
  /** The skipped negation lines, e.g. "!keep.txt" (for the log). */
  negations: string[];
}

export function parseGitignore(text: string): GitignoreResult {
  const patterns: string[] = [];
  let unsupported = 0;
  const negations: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) { unsupported++; negations.push(line); continue; }
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    patterns.push(line);
  }
  return { patterns, unsupported, negations };
}
