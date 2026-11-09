/**
 * Components: named groups of files, by path glob (Codecov's components).
 * A file may belong to several. With no configuration, files are grouped by
 * language, from their extension, so a TS + C++ repo splits with no setup.
 */

export interface Component {
  name: string;
  patterns: string[];
}

/** Glob → RegExp. `**` crosses directories, `*` and `?` don't, `{a,b}`
 *  alternates. A pattern without `/` matches the file's basename anywhere. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const anywhere = !g.includes('/');
  if (g.startsWith('/')) g = g.slice(1);
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // `dir/` means everything under it.
  if (g.endsWith('/')) re += '.*';
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`);
}

/** Parse the `components` input: one `Name: glob, glob` per line. */
export function parseComponents(raw: string): Component[] {
  const out: Component[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0)
      throw new Error(
        `components: expected "Name: glob, glob", got ${JSON.stringify(s)}`,
      );
    const name = s.slice(0, i).trim();
    const patterns = s
      .slice(i + 1)
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    if (!patterns.length)
      throw new Error(`components: ${JSON.stringify(name)} has no globs`);
    const existing = out.find(c => c.name === name);
    if (existing) existing.patterns.push(...patterns);
    else out.push({ name, patterns });
  }
  return out;
}

const LANGUAGES: [string, string[]][] = [
  ['TypeScript', ['ts', 'tsx', 'mts', 'cts']],
  ['JavaScript', ['js', 'jsx', 'mjs', 'cjs']],
  ['C/C++', ['c', 'h', 'cc', 'cpp', 'cxx', 'c++', 'hh', 'hpp', 'hxx', 'h++', 'ipp', 'inl']],
  ['Objective-C', ['m', 'mm']],
  ['Python', ['py', 'pyx']],
  ['Go', ['go']],
  ['Rust', ['rs']],
  ['Java', ['java']],
  ['Kotlin', ['kt', 'kts']],
  ['Scala', ['scala']],
  ['C#', ['cs']],
  ['F#', ['fs']],
  ['Swift', ['swift']],
  ['Ruby', ['rb']],
  ['PHP', ['php']],
  ['Dart', ['dart']],
  ['Elixir', ['ex', 'exs']],
  ['Vue', ['vue']],
  ['Svelte', ['svelte']],
];
const BY_EXT = new Map(
  LANGUAGES.flatMap(([lang, exts]) => exts.map(e => [e, lang] as const)),
);

export function languageOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'Other';
  return BY_EXT.get(base.slice(dot + 1).toLowerCase()) ?? 'Other';
}

/** Component names for each path. */
export function assignComponents(
  paths: Iterable<string>,
  components: Component[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!components.length) {
    for (const p of paths) out.set(p, [languageOf(p)]);
    return out;
  }
  const compiled = components.map(c => ({
    name: c.name,
    res: c.patterns.map(globToRegExp),
  }));
  for (const p of paths)
    out.set(
      p,
      compiled.filter(c => c.res.some(r => r.test(p))).map(c => c.name),
    );
  return out;
}
