import { describe, expect, it } from 'vitest';
import {
  isPackageEnabled,
  isValidNpmName,
  isValidSemver,
  mapNpmSearchPayload,
  npmNameFromSource,
  packageIdentity,
  packageRowTestId,
  packageSourceString,
  pinNpmSource,
  replacePackageEntry,
  sanitizeSearchQuery,
  truncateError,
  withAutoload,
  type PackageSource,
} from './piPackageModel';

describe('sanitizeSearchQuery', () => {
  it('strips colons and quotes so npm qualifiers cannot be injected', () => {
    expect(sanitizeSearchQuery('foo:bar author:evil "x"')).toBe('foo bar author evil x');
  });

  it('keeps letters, digits, scope slashes and dots', () => {
    expect(sanitizeSearchQuery('  @scope/pi-tools.v2  ')).toBe('@scope/pi-tools.v2');
  });
});

describe('package identity', () => {
  it('ignores npm version refs, including scoped names', () => {
    expect(packageIdentity('npm:@foo/bar@1.2.3')).toBe('npm:@foo/bar');
    expect(packageIdentity('npm:left-pad@1.0.0')).toBe('npm:left-pad');
    expect(npmNameFromSource('npm:@foo/bar@1.2.3')).toBe('@foo/bar');
  });

  it('leaves git and path sources untouched', () => {
    expect(packageIdentity('git:github.com/a/b')).toBe('git:github.com/a/b');
    expect(packageIdentity('./local-ext')).toBe('./local-ext');
  });
});

describe('enabled derivation', () => {
  it('treats string entries as enabled and autoload false as disabled', () => {
    expect(isPackageEnabled('npm:foo')).toBe(true);
    expect(isPackageEnabled({ source: 'npm:foo', autoload: true })).toBe(true);
    expect(isPackageEnabled({ source: 'npm:foo', autoload: false })).toBe(false);
    expect(isPackageEnabled({ source: 'npm:foo' })).toBe(true);
  });

  it('does not infer enabled from object-ness (filtered is not autoload)', () => {
    const objectForm: PackageSource = { source: 'npm:foo', autoload: true, skills: ['a'] };
    expect(isPackageEnabled(objectForm)).toBe(true);
  });
});

describe('withAutoload', () => {
  it('writes string form when enabling an entry with no resource filters', () => {
    expect(withAutoload({ source: 'npm:foo', autoload: false }, true)).toBe('npm:foo');
    expect(withAutoload('npm:foo@1.0.0', true)).toBe('npm:foo@1.0.0');
  });

  it('keeps skills/extensions filters when toggling', () => {
    const entry: PackageSource = { source: 'npm:foo@1.0.0', autoload: true, skills: ['x'], extensions: ['y'] };
    expect(withAutoload(entry, false)).toEqual({
      source: 'npm:foo@1.0.0',
      autoload: false,
      skills: ['x'],
      extensions: ['y'],
    });
    expect(withAutoload({ source: 'npm:foo', autoload: false, skills: ['x'] }, true)).toEqual({
      source: 'npm:foo',
      autoload: true,
      skills: ['x'],
    });
  });
});

describe('replacePackageEntry', () => {
  it('matches by identity ignoring version', () => {
    const next = replacePackageEntry(
      ['npm:foo@1.0.0', 'npm:bar'],
      'npm:foo@9.9.9',
      { source: 'npm:foo@1.0.0', autoload: false },
    );
    expect(next).toEqual([{ source: 'npm:foo@1.0.0', autoload: false }, 'npm:bar']);
  });
});

describe('search mapping and validation', () => {
  it('maps registry objects and defaults missing publisher', () => {
    const mapped = mapNpmSearchPayload({
      total: 9908,
      objects: [
        { package: { name: '@acme/pi-tool', version: '1.2.3', description: 'hi', publisher: { username: 'ada' } } },
        { package: { name: 'bare', version: '0.1.0' } },
      ],
    });
    expect(mapped.total).toBe(9908);
    expect(mapped.objects[0]).toEqual({
      name: '@acme/pi-tool',
      version: '1.2.3',
      description: 'hi',
      publisher: 'ada',
      npmUrl: 'https://www.npmjs.com/package/@acme/pi-tool',
    });
    expect(mapped.objects[1].publisher).toBe('');
    expect(mapped.objects[1].description).toBe('');
  });

  it('accepts npm names and semver, rejects garbage', () => {
    expect(isValidNpmName('@foo/bar')).toBe(true);
    expect(isValidNpmName('UPPER')).toBe(false);
    expect(isValidSemver('1.2.3-beta.1')).toBe(true);
    expect(isValidSemver('latest')).toBe(false);
    expect(pinNpmSource('@foo/bar', '1.2.3')).toBe('npm:@foo/bar@1.2.3');
  });

  it('escapes row test ids and truncates errors to 300 chars', () => {
    expect(packageRowTestId('package', 'npm:@foo/bar@1.0.0')).toBe('package-row-npm-foo-bar-1.0.0');
    expect(packageRowTestId('builtin', 'todo')).toBe('package-row-builtin-todo');
    expect(truncateError('x'.repeat(400)).length).toBe(300);
  });
});
