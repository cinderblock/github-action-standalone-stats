import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverageBadge, slug } from '../src/badge.js';
import { readCobertura, conditionBits } from '../src/coverage/cobertura.js';
import {
  assignComponents,
  globToRegExp,
  languageOf,
  parseComponents,
} from '../src/coverage/components.js';
import { readLcov } from '../src/coverage/lcov.js';
import {
  decodeCoverage,
  encodeCoverage,
  mergeCoverage,
  orBranches,
  totals,
  type Coverage,
} from '../src/coverage/model.js';
import { addedLines, patchCoverage } from '../src/coverage/patch.js';
import { detectCoverage, resolveRaw } from '../src/coverage/read.js';
import { workspaceRelative } from '../src/paths.js';
import { identity } from '../src/collect/gather.js';
import { SCHEMA, type Upload } from '../src/model.js';
import { buildCoverage, parseCarryforward } from '../src/publish/coverage.js';
import { buildRecord, compare } from '../src/publish/merge.js';
import { applyRun, readBaseline, readDetail } from '../src/publish/store.js';
import { renderSummary } from '../src/publish/summary.js';
import { validateUpload } from '../src/upload.js';

/**
 * Fixtures are real reports from the serialport bindings-cpp fork's CI
 * (run 42308406736, node 24): nyc lcov for the TypeScript, and Cobertura for
 * the C++ from gcovr (Linux, macOS) and OpenCppCoverage (Windows).
 */
const fx = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'coverage', name), 'utf8');

const WORKSPACES = {
  ubuntu: '/home/runner/work/bindings-cpp/bindings-cpp',
  macos: '/Users/runner/work/bindings-cpp/bindings-cpp',
  windows: 'D:\\a\\bindings-cpp\\bindings-cpp',
} as const;
type Os = keyof typeof WORKSPACES;
const OSES = Object.keys(WORKSPACES) as Os[];
const never = () => false;

function cobertura(os: Os): Coverage {
  return resolveRaw(
    readCobertura(fx(`${os}.cobertura.xml`)),
    WORKSPACES[os],
    never,
  ).coverage;
}
function lcov(os: Os): Coverage {
  return resolveRaw(readLcov(fx(`${os}.lcov.info`)), WORKSPACES[os], never)
    .coverage;
}

/**
 * The report's own totals, from the root element's attributes, minus lines
 * a class lists more than once: gcovr repeats a line per function on it
 * (poller.cpp:33 and :43, serialport.cpp:364 in the Linux report) and counts
 * each copy. A line is a line, so we count it once.
 */
function reportTotals(xml: string) {
  const root = /<coverage\b[^>]*>/.exec(xml)![0];
  const a = (n: string) => Number(new RegExp(`${n}="(\\d+)"`).exec(root)?.[1]);
  let dupTotal = 0;
  let dupHit = 0;
  for (const [, body] of xml.matchAll(/<class [^>]*>([\s\S]*?)<\/class>/g)) {
    const byLine = new Map<string, { n: number; hit: number }>();
    const lines = body!.replace(/<methods>[\s\S]*?<\/methods>/g, '');
    for (const [, n, h] of lines.matchAll(
      /<line number="(\d+)" hits="(\d+)"/g,
    )) {
      const e = byLine.get(n!) ?? { n: 0, hit: 0 };
      e.n++;
      if (Number(h) > 0) e.hit++;
      byLine.set(n!, e);
    }
    for (const e of byLine.values()) {
      dupTotal += e.n - 1;
      dupHit += Math.max(0, e.hit - 1);
    }
  }
  return {
    lines: {
      hit: a('lines-covered') - dupHit,
      total: a('lines-valid') - dupTotal,
    },
    branches: { hit: a('branches-covered'), total: a('branches-valid') },
  };
}

describe('workspaceRelative', () => {
  it('handles every spelling the fixtures use', () => {
    expect(workspaceRelative('lib\\darwin.ts', WORKSPACES.windows)).toBe(
      'lib/darwin.ts',
    );
    expect(
      workspaceRelative(
        'a\\bindings-cpp\\bindings-cpp\\src\\x.cpp',
        WORKSPACES.windows,
        ['D:'],
      ),
    ).toBe('src/x.cpp');
    expect(
      workspaceRelative('src/x.cpp', WORKSPACES.ubuntu, [WORKSPACES.ubuntu]),
    ).toBe('src/x.cpp');
    expect(
      workspaceRelative('/usr/include/stdio.h', WORKSPACES.ubuntu),
    ).toBeUndefined();
    expect(
      workspaceRelative('D:\\other\\x.cpp', WORKSPACES.windows),
    ).toBeUndefined();
  });

  it('prefers a declared base where the file exists', () => {
    const bases = ['/w/repo/build', '/w/repo/src'];
    expect(
      workspaceRelative(
        'x.py',
        '/w/repo',
        bases,
        p => p === '/w/repo/src/x.py',
      ),
    ).toBe('src/x.py');
    expect(workspaceRelative('x.py', '/w/repo', bases, never)).toBe(
      'build/x.py',
    );
  });
});

describe('Cobertura reader', () => {
  it.each(OSES)(
    '%s: totals match the report and paths are repo-relative',
    os => {
      const xml = fx(`${os}.cobertura.xml`);
      const cov = cobertura(os);
      expect([...cov.keys()].every(p => p.startsWith('src/'))).toBe(true);
      const t = totals(cov);
      const r = reportTotals(xml);
      expect(t.lines).toEqual(r.lines);
      expect(t.branches).toEqual(r.branches);
    },
  );

  it('reads gcovr class lines only, not the copies under <methods>', () => {
    // Every line has hits from one place: the merged hits for a line equal
    // the class-level value in the XML.
    const cov = cobertura('ubuntu');
    expect(cov.get('src/poller.cpp')!.get(5)!.hits).toBe(34);
  });

  it('encodes condition-coverage front-filled', () => {
    expect(conditionBits('50% (1/2)')).toBe('10');
    expect(conditionBits('33% (2/6)')).toBe('110000');
    expect(conditionBits('100% (4/4)')).toBe('1111');
    expect(conditionBits(undefined)).toBeUndefined();
  });

  it('drops files outside the workspace and counts them', () => {
    const xml = `<coverage><sources><source>/w/repo</source></sources><packages><package><classes>
      <class filename="src/a.cpp"><lines><line number="1" hits="1"/></lines></class>
      <class filename="/usr/include/c++/vector"><lines><line number="9" hits="3"/></lines></class>
    </classes></package></packages></coverage>`;
    const r = resolveRaw(readCobertura(xml), '/w/repo', never);
    expect([...r.coverage.keys()]).toEqual(['src/a.cpp']);
    expect(r.external).toBe(1);
  });

  it('keeps relative names when nothing resolves (report made in a container)', () => {
    const xml = `<coverage><sources><source>/app</source></sources><packages><package><classes>
      <class filename="pkg/a.py"><lines><line number="1" hits="1"/></lines></class>
    </classes></package></packages></coverage>`;
    const r = resolveRaw(readCobertura(xml), '/home/runner/work/r/r', never);
    expect(r.keptRelative).toBe(true);
    expect([...r.coverage.keys()]).toEqual(['pkg/a.py']);
  });
});

describe('lcov reader', () => {
  it.each(OSES)('%s: totals match the LF/LH/BRF/BRH summary lines', os => {
    const text = fx(`${os}.lcov.info`);
    const sum = (k: string) =>
      [...text.matchAll(new RegExp(`^${k}:(\\d+)`, 'gm'))].reduce(
        (n, m) => n + Number(m[1]),
        0,
      );
    const t = totals(lcov(os));
    expect(t.lines).toEqual({ hit: sum('LH'), total: sum('LF') });
    expect(t.branches).toEqual({ hit: sum('BRH'), total: sum('BRF') });
    expect([...lcov(os).keys()].every(p => p.startsWith('lib/'))).toBe(true);
  });

  it('merges repeated records and keeps branch identities in order', () => {
    const r = readLcov(
      [
        'TN:a',
        'SF:src/x.ts',
        'DA:1,1',
        'DA:2,0',
        'BRDA:2,0,0,0',
        'BRDA:2,0,1,-',
        'end_of_record',
        'TN:b',
        'SF:src/x.ts',
        'DA:2,4',
        'BRDA:2,0,0,0',
        'BRDA:2,0,1,2',
        'end_of_record',
      ].join('\n'),
    );
    const f = r.files.get('src/x.ts')!;
    expect(f.get(1)).toEqual({ hits: 1 });
    expect(f.get(2)).toEqual({ hits: 4, br: '01' });
  });

  it('is detected by content, and JaCoCo gets a helpful error', () => {
    expect(detectCoverage('TN:\nSF:a.ts\nend_of_record\n', 'x').format).toBe(
      'lcov',
    );
    expect(detectCoverage(fx('ubuntu.cobertura.xml'), 'x').format).toBe(
      'cobertura',
    );
    expect(() =>
      detectCoverage(
        '<?xml version="1.0"?><report name="x"></report>',
        'j.xml',
      ),
    ).toThrow(/JaCoCo/);
    expect(() => detectCoverage('{"a":1}', 'x.json')).toThrow(
      /not lcov or Cobertura/,
    );
  });
});

describe('merging across a matrix', () => {
  it('unions coverable lines and sums hits (the OSes really disagree)', () => {
    const per = OSES.map(cobertura);
    const merged = per.reduce(
      (m, c) => mergeCoverage(m, c),
      new Map() as Coverage,
    );
    const shared = 'src/serialport.cpp';
    const lines = per.map(c => c.get(shared)!.size);
    expect(new Set(lines).size).toBeGreaterThan(1);
    expect(merged.get(shared)!.size).toBeGreaterThanOrEqual(Math.max(...lines));
    // Platform files only come from their own OS.
    expect(merged.has('src/serialport_win.cpp')).toBe(true);
    expect(merged.has('src/serialport_linux.cpp')).toBe(true);
    expect(merged.has('src/darwin_list.cpp')).toBe(true);
    const line = [...merged.get(shared)!.keys()][0]!;
    const sum = per.reduce(
      (n, c) => n + (c.get(shared)!.get(line)?.hits ?? 0),
      0,
    );
    expect(merged.get(shared)!.get(line)!.hits).toBe(sum);
  });

  it('ORs branches: identities union, counts take the max', () => {
    expect(orBranches('1000', '0100')).toBe('1100');
    expect(orBranches('10', '1110')).toBe('1110');
    expect(orBranches(undefined, '01')).toBe('01');
  });

  it('round-trips through the compact encoding', () => {
    const cov = cobertura('windows');
    const back = decodeCoverage(
      JSON.parse(JSON.stringify(encodeCoverage(cov))),
    );
    expect(totals(back)).toEqual(totals(cov));
    expect(back.get('src/serialport.cpp')).toEqual(
      cov.get('src/serialport.cpp'),
    );
  });

  it('drops hostile entries when decoding', () => {
    const back = decodeCoverage([
      { p: 'ok.ts', l: [1, 1, 1, 0], b: { '1': '10', '2': 'zz', '9': '1' } },
      { p: 7, l: [] },
      { p: 'neg.ts', l: [-1, 5] },
      'junk',
    ]);
    expect([...back.keys()]).toEqual(['ok.ts']);
    expect(back.get('ok.ts')!.get(1)).toEqual({ hits: 1, br: '10' });
    expect(back.get('ok.ts')!.get(2)).toEqual({ hits: 0 });
    expect(() =>
      decodeCoverage(new Array(100_001).fill({ p: 'a', l: [] })),
    ).toThrow();
  });
});

describe('components', () => {
  it('defaults to one per language', () => {
    expect(languageOf('lib/x.ts')).toBe('TypeScript');
    expect(languageOf('src/x.cpp')).toBe('C/C++');
    expect(languageOf('src/x.h')).toBe('C/C++');
    expect(languageOf('Makefile')).toBe('Other');
    const a = assignComponents(['lib/a.ts', 'src/b.cpp'], []);
    expect(a.get('lib/a.ts')).toEqual(['TypeScript']);
  });

  it('parses config and matches globs', () => {
    const c = parseComponents(
      '# comment\nNative: src/**, *.h\nJS: lib/**/*.ts\nNative: binding.gyp',
    );
    expect(c).toEqual([
      { name: 'Native', patterns: ['src/**', '*.h', 'binding.gyp'] },
      { name: 'JS', patterns: ['lib/**/*.ts'] },
    ]);
    const a = assignComponents(
      ['src/a/b.cpp', 'lib/x.ts', 'lib/y.js', 'inc/z.h'],
      c,
    );
    expect(a.get('src/a/b.cpp')).toEqual(['Native']);
    expect(a.get('lib/x.ts')).toEqual(['JS']);
    expect(a.get('lib/y.js')).toEqual([]);
    expect(a.get('inc/z.h')).toEqual(['Native']);
    expect(() => parseComponents('no colon here')).toThrow();
  });

  it('glob syntax', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('**/*.{c,h}').test('x/y.h')).toBe(true);
    expect(globToRegExp('lib/').test('lib/a/b.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('x/ab.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('xa.ts')).toBe(false);
  });
});

describe('patch coverage', () => {
  it('reads added head-side lines from a unified diff', () => {
    const patch = [
      '@@ -1,4 +1,5 @@',
      ' a',
      '-b',
      '+B',
      '+C',
      ' d',
      '@@ -10,2 +11,3 @@ fn()',
      ' x',
      '+y',
      '\\ No newline at end of file',
    ].join('\n');
    expect([...addedLines(patch)]).toEqual([2, 3, 12]);
  });

  it('counts only coverable changed lines', () => {
    const cov: Coverage = new Map([
      [
        'a.ts',
        new Map([
          [2, { hits: 1 }],
          [3, { hits: 0 }],
        ]),
      ],
      ['b.ts', new Map([[1, { hits: 1 }]])],
    ]);
    const p = patchCoverage(
      cov,
      {
        files: new Map([
          ['a.ts', new Set([1, 2, 3])],
          ['README.md', new Set([1])],
        ]),
        partial: false,
      },
      'base',
    );
    expect({ hit: p.hit, total: p.total }).toEqual({ hit: 1, total: 2 });
    expect(p.files).toEqual([{ path: 'a.ts', hit: 1, total: 2 }]);
    expect(p.partial).toBe(false);
  });

  it('is incomplete only when a file without a patch has coverage', () => {
    const cov: Coverage = new Map([['b.ts', new Map([[1, { hits: 1 }]])]]);
    const diff = (omitted: string[]) => ({
      files: new Map<string, Set<number>>(),
      partial: false,
      omitted,
    });
    // A committed bundle too big for the compare API: not covered, fine.
    expect(patchCoverage(cov, diff(['dist/main.js']), 'b').partial).toBe(false);
    expect(patchCoverage(cov, diff(['b.ts']), 'b').partial).toBe(true);
  });
});

function covUpload(
  os: Os,
  flags: string[],
  extra: Partial<Upload> = {},
): Upload {
  const id = identity('test', { os }, '');
  const cov = mergeCoverage(cobertura(os), lcov(os));
  return {
    schema: SCHEMA,
    key: id.key,
    label: id.label,
    job: 'test',
    dims: id.dims,
    flags,
    attempt: 1,
    createdAt: '2026-11-08T00:00:00.000Z',
    sources: [],
    tests: [],
    coverage: {
      sources: [
        { format: 'cobertura', path: 'cpp.xml', files: cov.size, external: 0 },
      ],
      files: encodeCoverage(cov),
    },
    ...extra,
  };
}

const ctx = (id: number, sha: string, time: string) => ({
  run: {
    id,
    attempt: 1,
    number: id,
    workflow: 'CI',
    url: `https://github.com/o/r/actions/runs/${id}`,
  },
  commit: { sha, ref: 'refs/heads/main', branch: 'main', event: 'push' },
  now: new Date(time),
});

describe('buildCoverage', () => {
  const opts = {
    key: '1-1',
    sha: 'a'.repeat(40),
    components: [],
    carryforward: parseCarryforward('false'),
  };

  it('breaks down by flag and language, per upload too', () => {
    const uploads = OSES.map(os => covUpload(os, [os]));
    const b = buildCoverage(uploads, opts)!;
    expect(Object.keys(b.coverage.flags)).toEqual([
      'macos',
      'ubuntu',
      'windows',
    ]);
    expect(Object.keys(b.coverage.components)).toEqual(['C/C++', 'TypeScript']);
    const c = b.coverage.components;
    expect(c['C/C++']!.lines.total + c.TypeScript!.lines.total).toBe(
      b.coverage.totals.lines.total,
    );
    expect(b.perUpload.size).toBe(3);
    expect(b.detail.groups.map(g => g.flags)).toEqual([
      ['macos'],
      ['ubuntu'],
      ['windows'],
    ]);
    // Upload validation keeps coverage intact.
    expect(
      validateUpload(JSON.parse(JSON.stringify(uploads[0]))).coverage?.files,
    ).toEqual(uploads[0]!.coverage!.files);
  });

  it('carries forward a missing flag from the baseline', () => {
    const first = buildCoverage(
      OSES.map(os => covUpload(os, [os])),
      opts,
    )!;
    const now = [covUpload('ubuntu', ['ubuntu'])];
    const without = buildCoverage(now, {
      ...opts,
      baselineDetail: first.detail,
    })!;
    expect(without.coverage.carriedForward).toEqual([]);
    const carried = buildCoverage(now, {
      ...opts,
      carryforward: parseCarryforward('windows'),
      baselineDetail: first.detail,
    })!;
    expect(carried.coverage.carriedForward).toEqual(['windows']);
    expect(carried.coverage.flags.windows!.carried).toBe(true);
    expect(carried.coverage.flags.macos).toBeUndefined();
    expect(carried.coverage.totals.lines.total).toBeGreaterThan(
      without.coverage.totals.lines.total,
    );
  });

  it('parses carryforward', () => {
    expect(parseCarryforward('')('x')).toBe(false);
    expect(parseCarryforward('true')('x')).toBe(true);
    expect(parseCarryforward('a, b')('b')).toBe(true);
    expect(parseCarryforward('a, b')('c')).toBe(false);
  });
});

describe('coverage storage and summary', () => {
  it('stores detail, index pairs and badges; prunes old detail; compares', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sst-cov-'));
    try {
      const opts = {
        repo: 'o/r',
        window: 30,
        detailWindow: 2,
        generator: { name: 'x', version: '0' },
      };
      const runs = [1, 2, 3].map(i => {
        const uploads = OSES.slice(0, i).map(os => covUpload(os, [os]));
        const cov = buildCoverage(uploads, {
          key: `${i}-1`,
          sha: String(i).repeat(40),
          components: [],
          carryforward: () => false,
        })!;
        return {
          cov,
          ...buildRecord(uploads, {
            ...ctx(i, String(i).repeat(40), `2026-11-0${i}T10:00:00.000Z`),
            coverage: cov,
          }),
        };
      });
      for (const r of runs)
        await applyRun(root, r.record, r.tests, {
          ...opts,
          detail: r.cov.detail,
        });

      expect((await readdir(join(root, 'data', 'detail'))).sort()).toEqual([
        '2-1.json',
        '3-1.json',
      ]);
      const index = JSON.parse(
        await readFile(join(root, 'data', 'index.json'), 'utf8'),
      );
      const last = index.runs[2].coverage;
      expect(last.l).toEqual([
        runs[2]!.record.coverage!.totals.lines.hit,
        runs[2]!.record.coverage!.totals.lines.total,
      ]);
      expect(Object.keys(last.f)).toEqual(['macos', 'ubuntu', 'windows']);
      for (const b of [
        'coverage.svg',
        'coverage-c-cpp.svg',
        'coverage-typescript.svg',
        'flag-windows.svg',
      ])
        expect(existsSync(join(root, 'badges', b))).toBe(true);

      const base = (await readBaseline(root, 'o/r', 'main', 99))!;
      expect(base.key).toBe('3-1');
      expect((await readDetail(root, base))?.groups.length).toBe(3);
      // Old run's detail is gone, so carryforward from it is simply skipped.
      const old = JSON.parse(
        await readFile(
          join(root, runs[0]!.record.coverage!.detail.replace('2-1', '1-1')),
          'utf8',
        ).catch(() => 'null'),
      );
      expect(old).toBeNull();

      const cmp = compare(runs[2]!.record, runs[2]!.tests, runs[1]!.record);
      const md = renderSummary(runs[2]!.record, cmp, {
        recorded: true,
        siteUrl: 'https://o.github.io/r/stats/',
        coverageBadgeUrl: 'https://o.github.io/r/stats/badges/coverage.svg',
      });
      expect(md).toContain('### Coverage');
      expect(md).toMatch(
        /\*\*Lines \d+\.\d\d% \(\d+\/\d+\)\*\* \([+−]\d+\.\d\d pts vs `2222222`\)/,
      );
      expect(md).toContain('| Component | Lines | Δ | Branches | Files |');
      expect(md).toContain('| windows |');
      expect(md).not.toContain('No test results');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('badges', () => {
    expect(coverageBadge('coverage', [999, 1000])).toContain('99.9%');
    expect(coverageBadge('coverage', [0, 0])).toContain('n/a');
    expect(slug('C/C++')).toBe('c-cpp');
    expect(slug('C#')).toBe('csharp');
  });
});

describe('gather with coverage', () => {
  it('reads globbed reports, resolves paths, and warns about unusable ones', async () => {
    const { gather } = await import('../src/collect/gather.js');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const ws = await mkdtemp(join(tmpdir(), 'sst-ws-'));
    try {
      await mkdir(join(ws, 'coverage'), { recursive: true });
      await writeFile(
        join(ws, 'coverage', 'lcov.info'),
        `TN:\nSF:${join(ws, 'src', 'a.ts')}\nDA:1,1\nDA:2,0\nend_of_record\nSF:/elsewhere/b.ts\nDA:1,1\nend_of_record\n`,
      );
      await writeFile(
        join(ws, 'coverage', 'other.xml'),
        `<coverage><sources><source>/nowhere</source></sources><packages><package><classes><class filename="/abs/x.c"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`,
      );
      const warnings: string[] = [];
      const u = await gather({
        identity: identity('test', {}, ''),
        testPatterns: [],
        coveragePatterns: [join(ws, 'coverage', '*')],
        flags: ['unit'],
        workspace: ws,
        attempt: 1,
        warn: w => warnings.push(w),
      });
      expect(u.coverage!.sources).toEqual([
        { format: 'lcov', path: 'coverage/lcov.info', files: 1, external: 1 },
        {
          format: 'cobertura',
          path: 'coverage/other.xml',
          files: 0,
          external: 1,
        },
      ]);
      expect(u.coverage!.files).toEqual([{ p: 'src/a.ts', l: [1, 1, 1, 0] }]);
      expect(warnings).toEqual([
        expect.stringContaining(
          'coverage/other.xml: every file is outside the workspace',
        ),
      ]);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
