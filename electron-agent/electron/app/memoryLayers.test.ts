import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../agentData/memoryStore';
import { applySceneDecisions, applyPersonaDecision, MAX_INLINE_SCENES, parseMemoryScene, parseMemoryPersona, sceneSource, selectScenesToInline } from './memoryLayers';

const scope = { userId: 'u', projectId: 'project-A', workspace: '/repo-a', scope: 'global' as const };

describe('parseMemoryScene', () => {
  it('把 write 与 [DELETED] 规范成决策', () => {
    const parsed = parseMemoryScene({
      scenes: [
        { filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '-----META-START-----\nsummary: sop\nheat: 1\n-----META-END-----\n\n## 核心 SOP\n先对齐抽取协议。' },
        { filename: '旧场景.md', content: '[DELETED]' },
      ],
      persona_update_request: 'SOP 已跨场景稳定',
    });
    expect(parsed.scenes).toEqual([
      { filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '-----META-START-----\nsummary: sop\nheat: 1\n-----META-END-----\n\n## 核心 SOP\n先对齐抽取协议。' },
      { filename: '旧场景.md', action: 'delete' },
    ]);
    expect(parsed.persona_update_request).toBe('SOP 已跨场景稳定');
  });

  it('拒绝非对象输出', () => {
    expect(() => parseMemoryScene([])).toThrow('memory scene output is invalid');
  });
});

describe('applySceneDecisions', () => {
  it('按 filename 写入或删除 global L2', () => {
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const first = applySceneDecisions(store, scope, [
      { filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\nv1' },
    ]);
    expect(first).toHaveLength(1);
    expect(first[0].level).toBe(2);
    expect(first[0].source).toBe(sceneSource('团队记忆-SOP与禁忌.md'));
    expect(first[0].scope).toBe('global');

    const updated = applySceneDecisions(store, scope, [
      { filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP\nv2' },
    ]);
    expect(updated[0].id).toBe(first[0].id);
    expect(store.list({ userId: 'u', filter: { scope: 'global' }, level: 2 }).items).toHaveLength(1);
    expect(store.list({ userId: 'u', filter: { scope: 'global' }, level: 2 }).items[0].content).toContain('v2');

    applySceneDecisions(store, scope, [{ filename: '团队记忆-SOP与禁忌.md', action: 'delete' }]);
    expect(store.list({ userId: 'u', filter: { scope: 'global' }, level: 2 }).items).toHaveLength(0);
    db.close();
  });
});

describe('parseMemoryPersona / applyPersonaDecision', () => {
  it('把 persona.md 写成唯一 global L3', () => {
    const parsed = parseMemoryPersona({ content: '# Team Operating Doctrine\n\n- 先对齐协议再落库' });
    expect(parsed.content).toContain('Team Operating Doctrine');
    const db = new DatabaseSync(':memory:');
    const store = new MemoryStore(db);
    const first = applyPersonaDecision(store, scope, parsed.content);
    const second = applyPersonaDecision(store, scope, '# Team Operating Doctrine\n\n- 压缩后的原则');
    expect(first.level).toBe(3);
    expect(second.id).toBe(first.id);
    expect(store.list({ userId: 'u', filter: { scope: 'global' }, level: 3 }).items).toHaveLength(1);
    db.close();
  });
});

describe('selectScenesToInline', () => {
  const scenes = [
    { filename: '团队记忆-提交规范.md', summary: '提交信息用中文、提交前跑测试' },
    { filename: '团队记忆-数据库.md', summary: '迁移放启动阶段' },
    { filename: '团队记忆-前端.md', summary: '组件用 antd' },
    { filename: '团队记忆-发布.md', summary: '发布前打 tag' },
    { filename: '团队记忆-评审.md', summary: '评审要写放弃的方案' },
  ];

  it('按和新记忆的关键词重叠挑最相关的场景，最多 MAX_INLINE_SCENES 个，零分的不选', () => {
    const picked = selectScenesToInline(scenes, [{ content: '提交信息统一用中文', scene_name: '提交规范' }], 15);
    expect([...picked]).toEqual(['团队记忆-提交规范.md']);
    expect(MAX_INLINE_SCENES).toBe(3);
  });

  it('场景数到 maxScenes - 1 时全部内联，方便 MERGE', () => {
    expect(selectScenesToInline(scenes, [{ content: '无关' }], 6).size).toBe(5);
  });
});
