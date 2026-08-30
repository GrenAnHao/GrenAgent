import { describe, expect, it } from 'vitest';
import {
  getToolPerm, getToolRules, parseAuditLines, parsePolicyDoc,
  serializePolicyDoc, setToolPerm, setToolRules, shortToolName,
} from './mcpPolicy';

describe('parsePolicyDoc', () => {
  it('returns {} for empty / invalid', () => {
    expect(parsePolicyDoc('')).toEqual({});
    expect(parsePolicyDoc('nope')).toEqual({});
  });
});

describe('getToolPerm', () => {
  it('defaults to auto when missing', () => {
    expect(getToolPerm({}, 'mcp__s__t')).toBe('auto');
  });
  it('reads existing permission', () => {
    expect(getToolPerm({ tools: { mcp__s__t: { permission: 'disabled' } } }, 'mcp__s__t')).toBe('disabled');
  });
});

describe('setToolPerm', () => {
  it('is immutable and preserves other fields', () => {
    const raw = { defaultPermission: 'auto', tools: { mcp__a__x: { permission: 'disabled' } } };
    const next = setToolPerm(raw, 'mcp__s__t', 'needs_approval');
    expect(getToolPerm(next, 'mcp__s__t')).toBe('needs_approval');
    expect(getToolPerm(next, 'mcp__a__x')).toBe('disabled');
    expect(next.defaultPermission).toBe('auto');
    expect(raw.tools).not.toHaveProperty('mcp__s__t');
  });
});

describe('setToolRules', () => {
  it('sets and clears rules', () => {
    const withRules = setToolRules({}, 'mcp__s__t', [{ match: { p: 'x' }, policy: 'always' }]);
    expect(getToolRules(withRules, 'mcp__s__t')).toEqual([{ match: { p: 'x' }, policy: 'always' }]);
    expect(getToolRules(setToolRules(withRules, 'mcp__s__t', []), 'mcp__s__t')).toEqual([]);
  });
});

describe('parseAuditLines', () => {
  it('parses jsonl and skips malformed', () => {
    const out = parseAuditLines('{"ts":"t1","server":"s","tool":"x","decision":"approved","argsDigest":"{}"}\nbad\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ server: 's', tool: 'x', decision: 'approved' });
  });
});

describe('shortToolName', () => {
  it('strips mcp__server__ prefix', () => {
    expect(shortToolName('mcp__github__create_issue')).toBe('create_issue');
    expect(shortToolName('plain')).toBe('plain');
  });
});

describe('serializePolicyDoc', () => {
  it('round-trips', () => {
    const raw = parsePolicyDoc(serializePolicyDoc({ tools: { mcp__s__t: { permission: 'auto' } } }));
    expect(getToolPerm(raw, 'mcp__s__t')).toBe('auto');
  });
});
