import { describe, expect, it } from 'vitest';
import { codeIndexPresentation } from './codeIndexPresentation';

const ws = 'D:/a';
describe('codeIndexPresentation', () => {
  it.each([
    [{ workspace: ws, connected: true, indexed: true, state: 'indexed' }, '已索引', undefined, true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'stale' }, '索引过期', 'warning', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'partial' }, '索引不完整', 'warning', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'failed', message: 'boom' }, '索引失败', 'error', true, 'sync'],
    [{ workspace: ws, connected: true, indexed: true, state: 'indexing' }, '索引中', 'info', false, 'none'],
    [{ workspace: ws, connected: false, indexed: false, state: 'unavailable' }, '未索引', undefined, false, 'build'],
    [{ workspace: ws, connected: false, indexed: false, sdkAvailable: false, state: 'sdk_unavailable' }, 'SDK 不可用', 'error', false, 'none'],
  ] as const)('maps %o', (status, label, banner, canQuery, primary) => {
    const view = codeIndexPresentation({ status, checking: false });
    expect(view.label).toBe(label);
    expect(view.banner?.type).toBe(banner);
    expect(view.canQuery).toBe(canQuery);
    expect(view.primary).toBe(primary);
  });
  it('reports checking and read errors', () => {
    expect(codeIndexPresentation({ checking: true })).toMatchObject({ label: '检查中', canQuery: false, primary: 'none' });
    expect(codeIndexPresentation({ checking: false, error: '断开' })).toMatchObject({ label: '未获取', banner: { type: 'error' }, primary: 'none' });
  });
});
