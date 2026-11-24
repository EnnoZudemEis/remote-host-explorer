/** Converts .gitignore text into exclude patterns understood by makeExcluder (no VS Code dependency). */

export interface GitignoreResult {
  patterns: string[];
  /** Negations ("!keep.txt") are not supported and skipped. */
  unsupported: number;
}

export function parseGitignore(text: string): GitignoreResult {
  const patterns: string[] = [];
  let unsupported = 0;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) { unsupported++; continue; }
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    patterns.push(line);
  }
  return { patterns, unsupported };
}
