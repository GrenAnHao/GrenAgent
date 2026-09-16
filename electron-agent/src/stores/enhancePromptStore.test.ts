import { beforeEach, describe, expect, it } from 'vitest';
import { useEnhancePromptStore } from './enhancePromptStore';

describe('enhancePromptStore', () => {
  beforeEach(() => {
    useEnhancePromptStore.setState({ byWorkspace: {} });
  });

  it('start bump seq 并清空 preview；过期 append 忽略', () => {
    const seq1 = useEnhancePromptStore.getState().start('/ws', { awaitingContext: true, source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq1, 'a');
    const seq2 = useEnhancePromptStore.getState().start('/ws', { source: '原文2' });
    useEnhancePromptStore.getState().append('/ws', seq1, '旧');
    useEnhancePromptStore.getState().append('/ws', seq2, '新');
    const slot = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(seq2).toBeGreaterThan(seq1);
    expect(slot.preview).toBe('新');
    expect(slot.awaitingContext).toBe(false);
    expect(slot.source).toBe('原文2');
    expect(slot.status).toBe('streaming');
  });

  it('finish 用清洗稿替换 preview；cancel 变 idle', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq, '流');
    useEnhancePromptStore.getState().finish('/ws', seq, '清洗');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({ status: 'done', preview: '清洗' });
    useEnhancePromptStore.getState().cancel('/ws');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status ?? 'idle').toBe('idle');
  });

  it('cancel 保留 idle 槽并 bump seq；旧 seq 的 append/finish 被忽略', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq, '流');
    useEnhancePromptStore.getState().cancel('/ws');
    const afterCancel = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(afterCancel).toBeDefined();
    expect(afterCancel.status).toBe('idle');
    expect(afterCancel.seq).toBeGreaterThan(seq);
    expect(afterCancel.preview).toBe('');
    useEnhancePromptStore.getState().append('/ws', seq, '迟到');
    useEnhancePromptStore.getState().finish('/ws', seq, '迟到清洗');
    const afterStale = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(afterStale.status).toBe('idle');
    expect(afterStale.preview).toBe('');
    expect(afterStale.seq).toBe(afterCancel.seq);
  });

  it('clear 后再 start：新 seq 大于 clear 前；clear 前的 seq 再 append 被忽略', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq, '流');
    useEnhancePromptStore.getState().clear('/ws');
    const afterClear = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(afterClear).toBeDefined();
    expect(afterClear.status).toBe('idle');
    expect(afterClear.seq).toBeGreaterThan(seq);
    const nextSeq = useEnhancePromptStore.getState().start('/ws', { source: '新原文' });
    expect(nextSeq).toBeGreaterThan(afterClear.seq);
    useEnhancePromptStore.getState().append('/ws', seq, '迟到');
    const slot = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(slot.seq).toBe(nextSeq);
    expect(slot.preview).toBe('');
    expect(slot.status).toBe('streaming');
  });

  it('finish 后再同 seq append 不改 preview', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq, '流');
    useEnhancePromptStore.getState().finish('/ws', seq, '清洗');
    useEnhancePromptStore.getState().append('/ws', seq, '脏');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({
      status: 'done',
      preview: '清洗',
    });
  });

  it('fail 写入 error/status；同 seq append 不改 preview', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq, '流');
    useEnhancePromptStore.getState().fail('/ws', seq, '失败');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({
      status: 'error',
      error: '失败',
      preview: '流',
    });
    useEnhancePromptStore.getState().append('/ws', seq, '脏');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({
      status: 'error',
      error: '失败',
      preview: '流',
    });
  });
});
