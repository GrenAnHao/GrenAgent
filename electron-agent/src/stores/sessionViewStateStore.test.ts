import { beforeEach, describe, expect, it } from 'vitest';
import {
  isPersistableViewOwnerKey,
  resetSessionViewStateForTests,
  sessionViewStateKeyFor,
  sessionViewStateStorageKey,
  useSessionViewStateStore,
} from './sessionViewStateStore';

const A = 'C:\\ws\\.pi\\a.jsonl';
const B = 'c:/ws/.pi/b.jsonl';
const D1 = 'draft:one';
const D2 = 'draft:two';

const store = () => useSessionViewStateStore.getState();

beforeEach(() => {
  localStorage.clear();
  resetSessionViewStateForTests();
});

describe('sessionViewStateStore', () => {
  it('A 展开、B 各自独立：同一 viewId 不串，回到 A 恢复', () => {
    store().setExpanded(A, 'tool:c1', true);
    store().setExpanded(A, 'context:c2', true);

    expect(store().isExpanded(B, 'tool:c1')).toBeUndefined();
    store().setExpanded(B, 'tool:c1', false);

    expect(store().isExpanded(A, 'tool:c1')).toBe(true);
    expect(store().isExpanded(A, 'context:c2')).toBe(true);
    expect(store().isExpanded(B, 'tool:c1')).toBe(false);
  });

  it('页面重载后从 localStorage 恢复（不依赖运行时缓存）', () => {
    store().setExpanded(A, 'codemode:c9', true);
    store().setExpanded(D1, 'tool:d1', true);

    // 模拟整页重载：内存清空，只留 localStorage。
    resetSessionViewStateForTests({ keepStorage: true });
    expect(store().isExpanded(A, 'codemode:c9')).toBeUndefined();

    store().hydrateFromStorage();
    expect(store().isExpanded(A, 'codemode:c9')).toBe(true);
    expect(store().isExpanded(D1, 'tool:d1')).toBe(true);
  });

  it('adopt 把草稿展开项过户到新会话，并清掉草稿键', () => {
    store().setExpanded(D1, 'tool:x', true);
    store().setExpanded(D2, 'tool:x', true);
    store().setExpanded(D1, 'context:y', true);

    store().adopt(D1, '/ws/new.jsonl');

    expect(store().isExpanded('/ws/new.jsonl', 'tool:x')).toBe(true);
    expect(store().isExpanded('/ws/new.jsonl', 'context:y')).toBe(true);
    expect(store().isExpanded(D1, 'tool:x')).toBeUndefined();
    // 另一份草稿原样保留。
    expect(store().isExpanded(D2, 'tool:x')).toBe(true);

    // 过户结果落盘，重载后仍在。
    resetSessionViewStateForTests({ keepStorage: true });
    store().hydrateFromStorage();
    expect(store().isExpanded('/ws/new.jsonl', 'tool:x')).toBe(true);
  });

  it('adopt 时目标已有同 viewId：以来源草稿为准', () => {
    store().setExpanded(D1, 'tool:same', true);
    store().setExpanded('/ws/new.jsonl', 'tool:same', false);
    store().adopt(D1, '/ws/new.jsonl');
    expect(store().isExpanded('/ws/new.jsonl', 'tool:same')).toBe(true);
  });

  it('remove 只清目标身份，不影响其它会话', () => {
    store().setExpanded(A, 'tool:a', true);
    store().setExpanded(B, 'tool:a', true);
    store().remove(A);
    expect(store().isExpanded(A, 'tool:a')).toBeUndefined();
    expect(store().isExpanded(B, 'tool:a')).toBe(true);
    resetSessionViewStateForTests({ keepStorage: true });
    store().hydrateFromStorage();
    expect(store().isExpanded(A, 'tool:a')).toBeUndefined();
    expect(store().isExpanded(B, 'tool:a')).toBe(true);
  });

  it('无身份的 key（workspace/空串）既读不到也不写盘，避免跨会话共享', () => {
    expect(isPersistableViewOwnerKey('/ws')).toBe(false);
    expect(isPersistableViewOwnerKey('')).toBe(false);
    expect(isPersistableViewOwnerKey(A)).toBe(true);
    expect(isPersistableViewOwnerKey(D1)).toBe(true);

    store().setExpanded('/ws', 'tool:shared', true);
    expect(store().isExpanded('/ws', 'tool:shared')).toBeUndefined();
    expect(localStorage.getItem(sessionViewStateStorageKey())).toBeNull();

    expect(store().toggle('/ws', 'tool:shared')).toBe(true);
    expect(store().isExpanded('/ws', 'tool:shared')).toBeUndefined();
  });

  it('toggle 返回新值并按身份写入', () => {
    expect(store().toggle(A, 'thinking:1')).toBe(true);
    expect(store().toggle(A, 'thinking:1')).toBe(false);
    expect(store().isExpanded(A, 'thinking:1')).toBe(false);
  });

  it('remove 后迟到的 setExpanded / adopt 不得把会话复活', () => {
    store().setExpanded(A, 'tool:late', true);
    store().remove(A);

    // 异步清理期间迟到的展开回调：不能重建 A 的记录。
    store().setExpanded(A, 'tool:late', true);
    expect(store().isExpanded(A, 'tool:late')).toBeUndefined();
    expect(Object.keys(store().byOwner)).not.toContain('c:/ws/.pi/a.jsonl');

    // 迟到的草稿过户到已删除会话：整条丢弃，不能凭空造出目标会话的记录。
    store().setExpanded(D1, 'tool:late', true);
    store().adopt(D1, A);
    expect(store().isExpanded(A, 'tool:late')).toBeUndefined();

    // 重新 hydrate 也不能从旧存档复活它。
    resetSessionViewStateForTests({ keepStorage: true });
    store().hydrateFromStorage();
    expect(store().isExpanded(A, 'tool:late')).toBeUndefined();
    // 别的会话不受墓碑影响。
    store().setExpanded(B, 'tool:late', true);
    expect(store().isExpanded(B, 'tool:late')).toBe(true);
  });

  it('两个窗口共享 localStorage：本窗口改 A 只写 A 的键，不会抹掉另一窗口刚写的 B', () => {
    store().setExpanded(A, 'tool:a', true);
    // 另一个窗口（同一份 localStorage、独立内存）刚写了 B。
    localStorage.setItem(sessionViewStateKeyFor(B), JSON.stringify({ 'tool:b-new': true }));

    // 本窗口继续在 A 上操作：只应改 A 自己的键。
    store().setExpanded(A, 'tool:a2', true);

    expect(JSON.parse(localStorage.getItem(sessionViewStateKeyFor(A))!)).toEqual({
      'tool:a': true,
      'tool:a2': true,
    });
    // B 的存档原样还在（没有被本窗口的整表写回覆盖/丢掉）。
    expect(JSON.parse(localStorage.getItem(sessionViewStateKeyFor(B))!)).toEqual({ 'tool:b-new': true });

    // 本窗口重载后能同时看到两边：A 来自自己的旧写、B 来自另一个窗口。
    resetSessionViewStateForTests({ keepStorage: true });
    store().hydrateFromStorage();
    expect(store().isExpanded(A, 'tool:a2')).toBe(true);
    expect(store().isExpanded(B, 'tool:b-new')).toBe(true);
  });

  it('路径写法不同（大小写/反斜杠）视为同一会话', () => {
    store().setExpanded(A, 'tool:z', true);
    expect(store().isExpanded('c:/WS/.pi/A.jsonl', 'tool:z')).toBe(true);
  });
});
