import { describe, expect, it } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import todoExtension from './index.js';

type Input = { todos: Array<{ id?: number; text: string; status: string }> };
type Result = { details: { todos: Array<{ id: number; text: string; status: string }>; nextId: number; error?: string } };
function harness() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let execute: (id: string, input: Input, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<Result>;
  todoExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); },
    registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; },
  } as unknown as ExtensionAPI);
  const entries: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => entries } };
  return { entries, ctx, event: (name: string, event: unknown) => handlers.get(name)?.(event, ctx),
    write: (input: Input, signal?: AbortSignal) => execute('todo', input, signal, undefined, ctx) };
}

describe('todo lifecycle entry points', () => {
  it('context 清理已完成清单时，同步扩展内存', async () => {
    const h = harness();
    const written = await h.write({ todos: [{ id: 1, text: '完成', status: 'completed' }] });
    const messages = [{ role: 'toolResult', toolName: 'todo', details: written.details }, { role: 'user', content: '下一轮' }];
    h.entries.push(...messages.map((message) => ({ type: 'message', message })));
    await h.event('context', { messages });
    const invalid = await h.write({ todos: [{ text: '', status: 'pending' }] });
    expect(invalid.details.todos).toEqual([]);
  });

  it('执行前已取消的操作不提交状态', async () => {
    const h = harness();
    await h.write({ todos: [{ id: 1, text: '保留', status: 'pending' }] });
    const controller = new AbortController();
    controller.abort();
    await expect(h.write({ todos: [] }, controller.signal)).rejects.toThrow(/abort|cancel/i);
    const invalid = await h.write({ todos: [{ text: '', status: 'pending' }] });
    expect(invalid.details.todos[0]?.text).toBe('保留');
  });

  it('快速并发整表写仍是原子的最后写者胜，不复用已分配 ID', async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 20 }, (_, n) => h.write({ todos: [{ text: `步骤 ${n}`, status: 'pending' }] })));
    expect(results.map((r) => r.details.todos[0]?.id)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    const invalid = await h.write({ todos: [{ text: '', status: 'pending' }] });
    expect(invalid.details.todos[0]?.text).toBe('步骤 19');
  });
});
