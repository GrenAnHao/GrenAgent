import { describe, expect, it } from 'vitest';
import { buildConversations } from './useConversations';
import type { SessionInfo } from '../../lib/pi';

const mk = (cwd: string, path: string, name: string | null): SessionInfo => ({
  id: path,
  path,
  cwd,
  timestamp: '2026-01-02T00:00:00Z',
  name,
});

describe('buildConversations with optimistic sessions', () => {
  it('shows conversation item before disk scan catches up', () => {
    const all = [mk('/w/works/u-new', '/w/works/u-new/pending.jsonl', '你好')];
    const items = buildConversations(all, '/w/works', '/w/works/u-new', '');
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('你好');
  });
});
