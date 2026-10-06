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

  it('scene_name 是抽取默认值「未分类」时不进查询词：它不描述这条记忆，只会撞上名字里带「分类」的场景', () => {
    const classified = [
      { filename: '团队记忆-分类标准.md', summary: '按类型分类整理' },
      { filename: '团队记忆-数据库.md', summary: '迁移放启动阶段' },
    ];
    expect([...selectScenesToInline(classified, [{ content: '发布窗口定在周五下午', scene_name: '未分类' }], 15)]).toEqual([]);
    // 真正的场景名照常参与；内容命中也不受影响。
    expect([...selectScenesToInline(classified, [{ content: '发布窗口定在周五下午', scene_name: '分类标准' }], 15)]).toEqual(['团队记忆-分类标准.md']);
    expect([...selectScenesToInline(classified, [{ content: '迁移放启动阶段要先备份', scene_name: '未分类' }], 15)]).toEqual(['团队记忆-数据库.md']);
  });

  it('场景数到 maxScenes - 1 时全部内联，方便 MERGE', () => {
    expect(selectScenesToInline(scenes, [{ content: '无关' }], 6).size).toBe(5);
  });

  describe('多数场景共有的词不计分', () => {
    const prefixed = [
      { filename: '团队记忆-提交规范.md', summary: '提交信息用中文、提交前跑测试' },
      { filename: '团队记忆-数据库.md', summary: '迁移放启动阶段' },
      { filename: '团队记忆-前端.md', summary: '组件用 antd' },
      { filename: '团队记忆-发布.md', summary: '发布前打 tag' },
      { filename: '团队记忆-评审.md', summary: '评审要写放弃的方案' },
      { filename: '个人偏好.md', summary: '回复要简短' },
    ];

    it('6 个场景里 5 个带「团队记忆-」前缀：新记忆只含「记忆」这类共有词时一个都不内联', () => {
      expect([...selectScenesToInline(prefixed, [{ content: '记忆系统需要整理' }], 15)]).toEqual([]);
    });

    it('共有词不再给每个场景垫一分：只有真正相关的数据库场景入选', () => {
      expect([...selectScenesToInline(prefixed, [{ content: '记忆里要记得做数据库迁移' }], 15)]).toEqual(['团队记忆-数据库.md']);
    });

    it('场景少于 4 个时不做共有词过滤', () => {
      expect([...selectScenesToInline(prefixed.slice(0, 3), [{ content: '记忆系统需要整理' }], 15)].sort())
        .toEqual(['团队记忆-前端.md', '团队记忆-提交规范.md', '团队记忆-数据库.md']);
    });
  });

  describe('按条记忆分别计分', () => {
    const scene = (name: string, summary: string) => ({ filename: `${name}.md`, summary });

    it('批次再长，靠后的记忆也参与选场景（不再整批拼成一个 96 词的查询）', () => {
      const noise = Array.from({ length: 5 }, (_, i) => ({
        content: Array.from({ length: 30 }, (_, j) => `noise${i}x${j}`).join(' '),
      }));
      const picked = selectScenesToInline(
        [scene('db', '迁移放启动阶段'), scene('fe', '组件用 antd')],
        [...noise, { content: '迁移放启动阶段' }],
        15,
      );
      expect([...picked]).toEqual(['db.md']);
    });

    it('被更多条记忆命中的场景排在前面，哪怕另一个场景的总得分更高', () => {
      const picked = selectScenesToInline(
        [scene('redis-cache', 'redis cache eviction policy tuning'), scene('kafka-lag', 'kafka consumer lag')],
        [
          { content: 'redis cache eviction policy tuning' },
          { content: 'kafka rebalance' },
          { content: 'kafka lag' },
        ],
        15,
      );
      // redis-cache：1 条命中、总分 5；kafka-lag：2 条命中、总分 3。
      expect([...picked]).toEqual(['kafka-lag.md', 'redis-cache.md']);
    });

    it('命中条数相同时按总得分排，再相同按文件名', () => {
      const picked = selectScenesToInline(
        [scene('zz', 'alphaterm betaterm'), scene('bb', 'alphaterm'), scene('aa', 'alphaterm')],
        [{ content: 'alphaterm betaterm' }],
        15,
      );
      expect([...picked]).toEqual(['zz.md', 'aa.md', 'bb.md']);
    });

    it('命中的场景超过 MAX_INLINE_SCENES 时只取前 3 个，并列按文件名排序', () => {
      const picked = selectScenesToInline(
        [scene('scene-d', 'topicd'), scene('scene-b', 'topicb'), scene('scene-e', 'topice'), scene('scene-a', 'topica'), scene('scene-c', 'topicc')],
        [{ content: 'topica topicb topicc topicd topice' }],
        15,
      );
      expect([...picked]).toEqual(['scene-a.md', 'scene-b.md', 'scene-c.md']);
      expect(picked.size).toBe(MAX_INLINE_SCENES);
    });
  });
});
