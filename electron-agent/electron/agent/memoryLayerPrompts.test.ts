import { describe, expect, it } from 'vitest';
import {
  formatPersonaUserPrompt,
  formatSceneUserPrompt,
  memoryPersonaPrompt,
  memoryScenePrompt,
} from './memoryLayerPrompts';

describe('memoryScenePrompt', () => {
  it('work 模式保留方法论角色与模板，改用 JSON 协议', () => {
    const prompt = memoryScenePrompt('work', 15);
    expect(prompt).toContain('Team Work Method Memory Consolidation Architect');
    expect(prompt).toContain('核心 SOP');
    expect(prompt).toContain('heat: 1');
    expect(prompt).toContain('严格小于 15');
    expect(prompt).toContain('"action": "write"');
    expect(prompt).toContain('"action": "delete"');
    expect(prompt).not.toContain('使用 **write** 工具');
    expect(prompt).not.toContain('使用 **read** 工具');
    expect(prompt).not.toContain('使用 **edit** 工具');
  });

  it('chat 模式保留数字第二大脑与用户核心特征模板', () => {
    const prompt = memoryScenePrompt('chat', 12);
    expect(prompt).toContain('Memory Consolidation Architect');
    expect(prompt).toContain('用户核心特征');
    expect(prompt).toContain('严格小于 12');
    expect(prompt).toContain('"scenes"');
    expect(prompt).not.toContain('使用 **write** 工具');
  });
});

describe('formatSceneUserPrompt', () => {
  it('内联已有场景正文和 L1 列表', () => {
    const user = formatSceneUserPrompt({
      memoriesJson: '[{"content":"先对齐抽取协议","type":"work_method"}]',
      sceneSummaries: '- 团队记忆-SOP与禁忌.md: 抽取协议',
      currentTimestamp: '2026-09-18T12:00:00.000Z',
      existingScenes: [{ filename: '团队记忆-SOP与禁忌.md', content: '## 核心 SOP\n先对齐' }],
    });
    expect(user).toContain('### 1️⃣ New Memories List');
    expect(user).toContain('先对齐抽取协议');
    expect(user).toContain('### 2️⃣ Existing Scene Blocks Summary');
    expect(user).toContain('团队记忆-SOP与禁忌.md');
    expect(user).toContain('## 核心 SOP');
    expect(user).toContain('2026-09-18T12:00:00.000Z');
    expect(user).not.toContain('仅以下文件可 read');
  });
});

describe('memoryPersonaPrompt / formatPersonaUserPrompt', () => {
  it('work 模式输出 Team Operating Doctrine 的 JSON content 协议', () => {
    const prompt = memoryPersonaPrompt('work');
    expect(prompt).toContain('Team Operating Doctrine Architect');
    expect(prompt).toContain('Reusable SOPs');
    expect(prompt).toContain('"content"');
    expect(prompt).not.toContain('必须使用文件工具');
    expect(prompt).not.toContain('使用 **write** 或 **edit**');
  });

  it('chat 模式保留四层扫描与 User Narrative Profile', () => {
    const prompt = memoryPersonaPrompt('chat');
    expect(prompt).toContain('Persona Architect');
    expect(prompt).toContain('User Narrative Profile');
    expect(prompt).toContain('Chapter 4');
    expect(prompt).toContain('"content"');
    expect(prompt).not.toContain('必须使用 write 或 edit 工具');
  });

  it('用户侧带上变化场景和已有 persona', () => {
    const user = formatPersonaUserPrompt({
      mode: 'incremental',
      currentTime: '2026-09-18T12:00:00.000Z',
      totalProcessed: 8,
      sceneCount: 2,
      changedSceneCount: 1,
      changedScenesContent: '#### 团队记忆-SOP与禁忌.md\n## 核心 SOP',
      existingPersona: '# Team Operating Doctrine\n\n- 先对齐',
      triggerInfo: 'SOP 已跨场景稳定',
    });
    expect(user).toContain('迭代更新');
    expect(user).toContain('SOP 已跨场景稳定');
    expect(user).toContain('总记忆数');
    expect(user).toContain('先对齐');
    expect(user).toContain('团队记忆-SOP与禁忌.md');
  });
});
