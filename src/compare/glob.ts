/** Minimal glob matching for exclude patterns (no VS Code dependency). */

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Builds an exclude test. Patterns without "/" match the entry name at any
 * depth (".git", "*.log"); patterns containing "/" match the path relative
 * to the compared root ("cache/**", "/uploads", "app/tmp"). An entry may
 * hold several comma-separated patterns (".git, *.log").
 */
export function makeExcluder(patterns: string[] = []): (relPath: string, name: string) => boolean {
  const byName: RegExp[] = [];
  const byPath: RegExp[] = [];
  for (const p of patterns.flatMap((x) => x.split(','))) {
    const g = p.trim().replace(/\/+$/, '');
    if (!g) continue;
    if (g.includes('/')) byPath.push(globToRegExp(g.replace(/^\//, '')));
    else byName.push(globToRegExp(g));
  }
  return (relPath, name) =>
    byName.some((r) => r.test(name)) || byPath.some((r) => r.test(relPath.replace(/^\//, '')));
}
