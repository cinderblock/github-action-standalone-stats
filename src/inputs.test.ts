import { describe, it, expect } from 'bun:test';
import { readInputs } from './inputs.js';

function makeGet(overrides: Record<string, string>) {
  return (name: string) => overrides[name] ?? '';
}

const baseEnv = {
  GITHUB_REPOSITORY: 'cinderblock/example',
  GITHUB_TOKEN: 'ghs_abc',
};

describe('readInputs', () => {
  it('applies defaults and resolves same-repo mode from GITHUB_REPOSITORY', () => {
    const inputs = readInputs(makeGet({}), baseEnv);

    expect(inputs.data.repoSlug).toBe('cinderblock/example');
    expect(inputs.data.branch).toBe('allure-data');
    expect(inputs.data.isSibling).toBe(false);
    expect(inputs.pages.repoSlug).toBe('cinderblock/example');
    expect(inputs.pages.branch).toBe('gh-pages');
    expect(inputs.pages.isSibling).toBe(false);
    expect(inputs.resultsDir).toBe('allure-results');
    expect(inputs.allureVersion).toBe('2.30.0');
    expect(inputs.autoCreateSiblings).toBe(true);
    expect(inputs.siblingVisibility).toBe('public');
  });

  it('flags sibling-repo mode when data-repo / pages-repo differ', () => {
    const inputs = readInputs(
      makeGet({
        'data-repo': 'cinderblock/example-stats',
        'pages-repo': 'cinderblock/example-stats-pages',
      }),
      baseEnv,
    );

    expect(inputs.data.isSibling).toBe(true);
    expect(inputs.pages.isSibling).toBe(true);
  });

  it('embeds the token into the clone URL', () => {
    const inputs = readInputs(makeGet({}), baseEnv);
    expect(inputs.data.url).toBe(
      'https://x-access-token:ghs_abc@github.com/cinderblock/example.git',
    );
  });

  it('trims slashes from data-path / pages-path', () => {
    const inputs = readInputs(
      makeGet({ 'data-path': '/sub/dir/', 'pages-path': '///reports///' }),
      baseEnv,
    );
    expect(inputs.data.path).toBe('sub/dir');
    expect(inputs.pages.path).toBe('reports');
  });

  it('falls back to GITHUB_TOKEN when token input is blank', () => {
    const inputs = readInputs(makeGet({}), {
      ...baseEnv,
      GITHUB_TOKEN: 'env-token',
    });
    expect(inputs.token).toBe('env-token');
  });

  it('throws when no token is available', () => {
    expect(() =>
      readInputs(makeGet({}), { GITHUB_REPOSITORY: 'cinderblock/example' }),
    ).toThrow(/No token provided/);
  });

  it('throws when GITHUB_REPOSITORY is missing', () => {
    expect(() => readInputs(makeGet({}), { GITHUB_TOKEN: 'x' })).toThrow(
      /GITHUB_REPOSITORY is not set/,
    );
  });

  it('parses booleans for auto-create-sibling-repos', () => {
    expect(
      readInputs(makeGet({ 'auto-create-sibling-repos': 'false' }), baseEnv)
        .autoCreateSiblings,
    ).toBe(false);
    expect(
      readInputs(makeGet({ 'auto-create-sibling-repos': '0' }), baseEnv)
        .autoCreateSiblings,
    ).toBe(false);
    expect(
      readInputs(makeGet({ 'auto-create-sibling-repos': 'true' }), baseEnv)
        .autoCreateSiblings,
    ).toBe(true);
  });

  it('rejects bad boolean values', () => {
    expect(() =>
      readInputs(makeGet({ 'auto-create-sibling-repos': 'maybe' }), baseEnv),
    ).toThrow(/Invalid boolean/);
  });

  it('rejects malformed repo slugs', () => {
    expect(() =>
      readInputs(makeGet({ 'data-repo': 'not a slug' }), baseEnv),
    ).toThrow(/Invalid repo slug/);
  });

  it('rejects invalid visibility', () => {
    expect(() =>
      readInputs(makeGet({ 'sibling-repo-visibility': 'secret' }), baseEnv),
    ).toThrow(/Invalid sibling-repo-visibility/);
  });
});
