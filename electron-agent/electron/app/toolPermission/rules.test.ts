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

/** 一次 write 调用：带目标路径、不带命令。 */
function writeCall(path: string): ToolCallFacts {
  return facts({ tool: 'write', command: undefined, path });
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

  it('applies a workspace rule whose scope key carries a trailing separator', () => {
    expect(matchUserRules([rule({ scope: 'workspace', scopeKey: 'D:/repo/' })], facts(), NOW)?.id).toBe('r1');
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

  it('a trailing ** matches everything below the directory', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/src/**' })];
    expect(matchUserRules(r, writeCall('D:/repo/src/a/b.ts'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/repo/docs/a.md'), NOW)).toBeUndefined();
  });

  it('a single * stays within one path segment', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/*.ts' })];
    expect(matchUserRules(r, writeCall('D:/repo/a.ts'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/repo/a/b.ts'), NOW)).toBeUndefined();
  });

  it('path_glob escapes regex metacharacters instead of interpreting them', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/a.ts' })];
    expect(matchUserRules(r, writeCall('D:/repo/a.ts'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/repo/axts'), NOW)).toBeUndefined();
  });

  it('** matches zero directory segments', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/**/.env' })];
    expect(matchUserRules(r, writeCall('D:/repo/.env'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/repo/a/.env'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/repo/a/b/.env'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/other/.env'), NOW)).toBeUndefined();
  });

  it('path_glob folds .. so traversal cannot dodge a rule', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/secret/**' })];
    expect(matchUserRules(r, writeCall('D:/repo/src/../secret/k.txt'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, writeCall('D:/repo/public/k.txt'), NOW)).toBeUndefined();
  });

  // 下面两条锁的是「不会指数级回溯」，不是精确耗时：阈值给得很宽，
  // 未折叠时实测分别约 1900ms 与 1300ms，折叠后都在 1ms 量级。
  it('consecutive stars in one segment behave as a single star without backtracking', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/*****z' })];
    expect(matchUserRules(r, writeCall('D:/repo/aaaz'), NOW)?.id).toBe('r1');
    const started = performance.now();
    expect(matchUserRules(r, writeCall(`D:/repo/${'a'.repeat(120)}`), NOW)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('consecutive ** segments behave as a single ** without backtracking', () => {
    const matcher = `D:/repo/${'**/'.repeat(9)}z`;
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher })];
    expect(matchUserRules(r, writeCall('D:/repo/a/b/z'), NOW)?.id).toBe('r1');
    const started = performance.now();
    expect(matchUserRules(r, writeCall(`D:/repo/${'a/'.repeat(24)}b.ts`), NOW)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
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

  // 规则来自 SQLite，判别字段可能是类型标注之外的脏数据（版本回退、手改库）。
  // 这类规则必须整条落空，而不是掉进某个具体分支被误判——下面两条都刻意构造成
  // 「若靠排除法兜底就会误命中」的形状。
  it('ignores a rule whose matcher kind is not recognized', () => {
    const r = [rule({ tool: 'mcp__npm__install', matcherKind: 'regex' as never, matcher: 'npm' })];
    expect(matchUserRules(r, facts({ tool: 'mcp__npm__install' }), NOW)).toBeUndefined();
  });

  it('ignores a rule whose scope is not recognized', () => {
    const r = [rule({ scope: 'thread' as never, scopeKey: 'D:/repo' })];
    expect(matchUserRules(r, facts(), NOW)).toBeUndefined();
  });

  it('ignores a rule whose effect is not recognized', () => {
    const r = [rule({ effect: 'confirm' as never })];
    expect(matchUserRules(r, facts(), NOW)).toBeUndefined();
  });
});
