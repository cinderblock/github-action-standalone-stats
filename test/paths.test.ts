import { describe, expect, it } from 'bun:test';
import { relativize, toPosix } from '../src/paths.js';

describe('toPosix', () => {
  it('converts separators and collapses dot segments', () => {
    expect(toPosix('lib\\darwin.ts')).toBe('lib/darwin.ts');
    expect(toPosix('a//b/./c/../d')).toBe('a/b/d');
    expect(toPosix('/home/x/')).toBe('/home/x');
  });
  it('lowercases drive letters and keeps them', () => {
    expect(toPosix('D:\\a\\repo\\src\\x.cpp')).toBe('d:/a/repo/src/x.cpp');
  });
  it('unwraps file:// URLs', () => {
    expect(toPosix('file:///home/runner/x.ts')).toBe('/home/runner/x.ts');
    expect(toPosix('file:///C:/work/my%20repo/x.ts')).toBe(
      'c:/work/my repo/x.ts',
    );
  });
});

describe('relativize', () => {
  it('strips a Linux workspace', () => {
    expect(
      relativize('/home/runner/work/r/r/src/a.ts', '/home/runner/work/r/r'),
    ).toBe('src/a.ts');
  });

  it('leaves already-relative Windows paths relative (nyc lcov on Windows)', () => {
    expect(
      relativize('lib\\darwin.ts', 'D:\\a\\bindings-cpp\\bindings-cpp'),
    ).toBe('lib/darwin.ts');
  });

  it('matches Windows workspaces case-insensitively', () => {
    expect(
      relativize('d:\\A\\Repo\\Repo\\src\\x.cpp', 'D:\\a\\repo\\repo'),
    ).toBe('src/x.cpp');
  });

  it('handles OpenCppCoverage: <source>D:</source> plus a drive-relative file', () => {
    const ws = 'D:\\a\\bindings-cpp\\bindings-cpp';
    expect(
      relativize('a\\bindings-cpp\\bindings-cpp\\src\\serialport.cpp', ws, [
        'D:',
      ]),
    ).toBe('src/serialport.cpp');
  });

  it('joins a relative file with a declared base (gcovr <source>)', () => {
    const ws = '/home/runner/work/bindings-cpp/bindings-cpp';
    expect(relativize('src/poller.cpp', ws, [ws])).toBe('src/poller.cpp');
    expect(relativize('poller.cpp', ws, [`${ws}/src`])).toBe('src/poller.cpp');
  });

  it('keeps files outside the workspace, minus the leading slash', () => {
    expect(relativize('/usr/include/stdio.h', '/home/runner/work/r/r')).toBe(
      'usr/include/stdio.h',
    );
  });
});
