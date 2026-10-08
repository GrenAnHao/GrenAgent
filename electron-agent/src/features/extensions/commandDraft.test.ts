import { describe, expect, it } from 'vitest';
import { validateCommandDraft } from './commandDraft';

const reserved = new Set(['compact', 'skill:browser']);
const existing = new Set(['review']);

describe('validateCommandDraft', () => {
  it('合法时返回 null', () => {
    expect(validateCommandDraft({ name: 'refactor', description: '', body: 'x' }, reserved, existing)).toBeNull();
  });

  it('依次报：空名、非法名、保留名、重名、空正文', () => {
    expect(validateCommandDraft({ name: ' ', description: '', body: 'x' }, reserved, existing)).toBe('命令名不能为空');
    expect(validateCommandDraft({ name: 'a/b', description: '', body: 'x' }, reserved, existing)).toBe('命令名只能用字母、数字、中文、- 和 _，最长 64 个字符');
    expect(validateCommandDraft({ name: 'compact', description: '', body: 'x' }, reserved, existing)).toBe('/compact 和已有的内置、扩展或技能命令重名');
    expect(validateCommandDraft({ name: 'review', description: '', body: 'x' }, reserved, existing)).toBe('命令 /review 已存在');
    expect(validateCommandDraft({ name: 'a', description: '', body: ' ' }, reserved, existing)).toBe('提示词不能为空');
  });

  it('编辑自己时不算重名', () => {
    expect(validateCommandDraft({ originalName: 'review', name: 'review', description: '', body: 'x' }, reserved, existing)).toBeNull();
  });
});
