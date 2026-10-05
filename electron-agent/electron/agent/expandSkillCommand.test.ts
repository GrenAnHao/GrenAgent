import { describe, expect, it } from 'vitest';
import { expandSpacedSkillCommand } from './expandSkillCommand';

const skill = {
  name: 'IDA Pro逆向分析',
  filePath: 'C:/skills/ida/SKILL.md',
  baseDir: 'C:/skills/ida',
};

const source = '---\nname: IDA Pro逆向分析\ndescription: ida\n---\n\n# body\n';

function readFile(path: string): string {
  if (path !== skill.filePath) throw new Error(`missing ${path}`);
  return source;
}

const block = `<skill name="IDA Pro逆向分析" location="C:/skills/ida/SKILL.md">
References are relative to C:/skills/ida.

# body
</skill>`;

describe('expandSpacedSkillCommand', () => {
  it('expands a quoted skill name that contains spaces, keeping args outside the block', () => {
    expect(expandSpacedSkillCommand('/skill:"IDA Pro逆向分析" 我', [skill], readFile)).toBe(
      `${block}\n\n我`,
    );
  });

  it('expands an unquoted spaced name by the longest loaded skill name', () => {
    expect(expandSpacedSkillCommand('/skill:IDA Pro逆向分析 我', [skill], readFile)).toBe(
      `${block}\n\n我`,
    );
  });

  it('prefers the longer spaced name over a shorter prefix', () => {
    const short = { name: 'IDA', filePath: 'nope', baseDir: 'nope' };
    expect(expandSpacedSkillCommand('/skill:IDA Pro逆向分析 我', [short, skill], readFile)).toBe(
      `${block}\n\n我`,
    );
  });

  it('does not swallow the args of a space-free skill', () => {
    const short = { name: 'IDA', filePath: skill.filePath, baseDir: skill.baseDir };
    expect(expandSpacedSkillCommand('/skill:IDA 做点什么', [short, skill], readFile)).toBe(
      '/skill:IDA 做点什么',
    );
  });

  it('leaves a space-free skill command for pi to expand', () => {
    expect(expandSpacedSkillCommand('/skill:caveman do it', [skill], readFile)).toBe(
      '/skill:caveman do it',
    );
  });

  it('rewrites a quoted space-free name back to the form pi already understands', () => {
    expect(expandSpacedSkillCommand('/skill:"caveman" do it', [skill], readFile)).toBe(
      '/skill:caveman do it',
    );
  });

  it('returns the original text when the quoted skill is not loaded', () => {
    expect(expandSpacedSkillCommand('/skill:"missing name" x', [skill], readFile)).toBe(
      '/skill:"missing name" x',
    );
  });

  it('returns the original text when the skill file cannot be read', () => {
    expect(
      expandSpacedSkillCommand('/skill:"IDA Pro逆向分析"', [skill], () => {
        throw new Error('enoent');
      }),
    ).toBe('/skill:"IDA Pro逆向分析"');
  });
});
