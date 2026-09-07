import { describe, expect, it } from 'vitest';
import { matchUserRules } from './rules';
import type { ToolCallFacts, ToolRule } from './types';

const NOW = 1_000_000;

function facts(over: Partial<ToolCallFacts> = {}): ToolCallFacts {
  return {
    tool: 'bash',
    workspace: 'D:/repo',
    origin: 'main',
    preset: 'auto',
    sessionId: 's1',
    command: 'npm run build',
    flags: {
      dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
      network: false, mcp: false, codeExec: false, write: false,
    },
    ...over,
  };
}

function rule(over: Partial<ToolRule> = {}): ToolRule {
  return {
    id: 'r1', scope: 'global', scopeKey: '', tool: 'bash',
    matcherKind: 'any', matcher: '', effect: 'allow', createdAt: 0,
    ...over,
  };
}

describe('matchUserRules', () => {
  it('returns undefined when nothing matches', () => {
    expect(matchUserRules([rule({ tool: 'write' })], facts(), NOW)).toBeUndefined();
  });

  it('deny outranks ask and allow regardless of scope width', () => {
    const matched = matchUserRules(
      [
        rule({ id: 'narrow-allow', scope: 'session', scopeKey: 's1', effect: 'allow' }),
        rule({ id: 'wide-deny', scope: 'global', effect: 'deny' }),
      ],
      facts(),
      NOW,
    );
    expect(matched?.id).toBe('wide-deny');
  });

  it('ask outranks allow', () => {
    const matched = matchUserRules(
      [rule({ id: 'a', effect: 'allow' }), rule({ id: 'b', effect: 'ask' })],
      facts(),
      NOW,
    );
    expect(matched?.id).toBe('b');
  });

  it('narrower scope wins among rules with the same effect', () => {
    const matched = matchUserRules(
      [
        rule({ id: 'global', scope: 'global', effect: 'allow' }),
        rule({ id: 'session', scope: 'session', scopeKey: 's1', effect: 'allow' }),
        rule({ id: 'workspace', scope: 'workspace', scopeKey: 'D:/repo', effect: 'allow' }),
      ],
      facts(),
      NOW,
    );
    expect(matched?.id).toBe('session');
  });

  it('ignores rules whose scope key belongs to another session or workspace', () => {
    expect(matchUserRules([rule({ scope: 'session', scopeKey: 'other' })], facts(), NOW)).toBeUndefined();
    expect(matchUserRules([rule({ scope: 'workspace', scopeKey: 'D:/other' })], facts(), NOW)).toBeUndefined();
  });

  it('ignores expired rules', () => {
    expect(matchUserRules([rule({ expiresAt: NOW - 1 })], facts(), NOW)).toBeUndefined();
    expect(matchUserRules([rule({ expiresAt: NOW + 1 })], facts(), NOW)?.id).toBe('r1');
  });

  it('matches tool names with a trailing wildcard', () => {
    const call = facts({ tool: 'mcp__github__create_issue' });
    expect(matchUserRules([rule({ tool: 'mcp__github__*' })], call, NOW)?.id).toBe('r1');
    expect(matchUserRules([rule({ tool: 'mcp__gitlab__*' })], call, NOW)).toBeUndefined();
  });

  it('command_prefix matches the leading substring of the command', () => {
    const r = [rule({ matcherKind: 'command_prefix', matcher: 'npm run' })];
    expect(matchUserRules(r, facts({ command: 'npm run build' }), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, facts({ command: 'npm install' }), NOW)).toBeUndefined();
  });

  it('command_prefix ignores leading whitespace in the command', () => {
    const r = [rule({ matcherKind: 'command_prefix', matcher: 'npm run' })];
    expect(matchUserRules(r, facts({ command: '  npm run build' }), NOW)?.id).toBe('r1');
  });

  it('path_glob matches with ** and * segments', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/src/**' })];
    const call = (path: string) => facts({ tool: 'write', command: undefined, path });
    expect(matchUserRules(r, call('D:/repo/src/a/b.ts'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, call('D:/repo/docs/a.md'), NOW)).toBeUndefined();
  });

  it('path_glob is case-insensitive and separator-insensitive', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/src/**' })];
    const call = facts({ tool: 'write', command: undefined, path: 'd:\\repo\\SRC\\a.ts' });
    expect(matchUserRules(r, call, NOW)?.id).toBe('r1');
  });

  it('mcp_server matches every tool of one server', () => {
    const r = [rule({ tool: '*', matcherKind: 'mcp_server', matcher: 'github' })];
    expect(matchUserRules(r, facts({ tool: 'mcp__github__x' }), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, facts({ tool: 'mcp__other__x' }), NOW)).toBeUndefined();
  });

  it('a matcher requiring a field that the call lacks does not match', () => {
    const r = [rule({ matcherKind: 'command_prefix', matcher: 'npm' })];
    expect(matchUserRules(r, facts({ command: undefined }), NOW)).toBeUndefined();
  });
});
