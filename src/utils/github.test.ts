import { describe, it, expect } from 'bun:test';
import { parseRepo, pagesUrl } from './github.js';

describe('parseRepo', () => {
  it('parses owner/name', () => {
    expect(parseRepo('cinderblock/example')).toEqual({
      owner: 'cinderblock',
      name: 'example',
    });
  });

  it('rejects bad input', () => {
    expect(() => parseRepo('')).toThrow();
    expect(() => parseRepo('cinderblock')).toThrow();
    expect(() => parseRepo('cinderblock/example/extra')).toThrow();
    expect(() => parseRepo('has space/name')).toThrow();
  });
});

describe('pagesUrl', () => {
  const ref = { owner: 'cinderblock', name: 'example' };

  it('builds a root URL when path is empty', () => {
    expect(pagesUrl(ref, '')).toBe('https://cinderblock.github.io/example/');
  });

  it('appends a path with trailing slash', () => {
    expect(pagesUrl(ref, 'reports')).toBe(
      'https://cinderblock.github.io/example/reports/',
    );
  });

  it('normalizes surrounding slashes', () => {
    expect(pagesUrl(ref, '/reports/')).toBe(
      'https://cinderblock.github.io/example/reports/',
    );
  });
});
