import { describe, it, expect } from 'vitest';
import {
  argSummary,
  extractText,
  getDetails,
  getDiff,
  getEditTexts,
  langByPath,
  skillNameFromRead,
  toolMeta,
} from './toolUtils';
import { Terminal, Wrench } from 'lucide-react';

describe('toolUtils', () => {
  it('getEditTexts reads the current edits array schema', () => {
    expect(getEditTexts({ edits: [{ oldText: 'old', newText: 'new' }] })).toEqual({ oldText: 'old', newText: 'new' });
  });
  it('extractText from content blocks', () => {
    expect(
      extractText({ content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }),
    ).toBe('line1\nline2');
  });

  it('extractText from string content', () => {
    expect(extractText({ content: 'hello' })).toBe('hello');
    expect(extractText('raw')).toBe('raw');
  });

  it('getDiff reads details.diff', () => {
    expect(getDiff({ details: { diff: '@@ -1 +1 @@\n-old\n+new' } })).toContain('@@');
    expect(getDiff({ details: {} })).toBeUndefined();
  });

  it('toolMeta maps bash to Terminal', () => {
    expect(toolMeta('bash').icon).toBe(Terminal);
    expect(toolMeta('unknown_tool').icon).toBe(Wrench);
  });

  it('argSummary shows first key value truncated', () => {
    expect(argSummary({ command: 'ls -la' })).toBe('command: ls -la');
    expect(argSummary({})).toBe('');
  });

  it('langByPath maps extensions', () => {
    expect(langByPath('src/foo.ts')).toBe('typescript');
    expect(langByPath('readme')).toBe('plaintext');
  });
});

describe('toolMeta extension icons', () => {
  it('returns distinct icons for extension tools', () => {
    for (const name of ['generate_image', 'spawn_agent', 'fetch_url', 'speak']) {
      expect(toolMeta(name).icon).toBeTruthy();
    }
  });
});

describe('skillNameFromRead', () => {
  it('取 SKILL.md 所在目录名作为技能名（posix / windows 路径都支持）', () => {
    expect(skillNameFromRead('read', { path: '/home/u/.agents/skills/brave-search/SKILL.md' })).toBe(
      'brave-search',
    );
    expect(
      skillNameFromRead('read_file', { path: 'C:\\Users\\u\\.agents\\skills\\pdf-tools\\SKILL.md' }),
    ).toBe('pdf-tools');
  });

  it('文件名大小写不敏感', () => {
    expect(skillNameFromRead('read', { path: '/x/skills/foo/skill.md' })).toBe('foo');
  });

  it('非技能读取 / 非 read 工具 / 缺路径都返回 undefined', () => {
    expect(skillNameFromRead('read', { path: '/x/src/index.ts' })).toBeUndefined();
    expect(skillNameFromRead('read', { path: '/x/README.md' })).toBeUndefined();
    expect(skillNameFromRead('bash', { command: 'cat SKILL.md' })).toBeUndefined();
    expect(skillNameFromRead('read', {})).toBeUndefined();
  });
});

describe('getDetails', () => {
  it('returns the details object when present', () => {
    expect(getDetails({ content: [], details: { path: '/a.png' } })).toEqual({ path: '/a.png' });
  });
  it('returns undefined when missing or invalid', () => {
    expect(getDetails(null)).toBeUndefined();
    expect(getDetails('x')).toBeUndefined();
    expect(getDetails({ content: [] })).toBeUndefined();
  });
});
