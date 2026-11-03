import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSettlementNotice } from '@extensions/multi-agent/settlement-notice';
import { SubagentSettledPill } from './SubagentSettledPill';

afterEach(() => cleanup());

const settled = (input: Parameters<typeof formatSettlementNotice>[0]) => formatSettlementNotice(input);
const expand = () => fireEvent.click(screen.getByTestId('subagent-settled-pill-head'));

describe('SubagentSettledPill', () => {
  it('shows the real terminal state and identity in a collapsed row, without a disclosure body', () => {
    const notice = settled({ childId: 'sa-1', stopReason: 'completed', output: '三个用例都是时区问题，已修好。' });
    render(<SubagentSettledPill content={notice.content} details={{ childId: 'sa-1', stopReason: 'completed' }} />);
    const pill = screen.getByTestId('subagent-settled-pill');
    expect(screen.getByTestId('task-notice-title').textContent).toBe('子代理 sa-1 已完成');
    expect(pill.getAttribute('data-outcome')).toBe('completed');
    expect(pill.getAttribute('data-tone')).toBe('ok');
    expect(pill.getAttribute('data-state')).toBe('closed');
    expect(pill.textContent).not.toContain('已注入上下文');
    expect(pill.textContent).not.toContain('三个用例都是时区问题，已修好。');
    expect(screen.queryByTestId('subagent-settled-body')).toBeNull();
  });

  it('shows the closing message after expanding', async () => {
    const notice = settled({
      childId: 'sa-2',
      stopReason: 'completed',
      output: '## 结果\n\n- **a.test.ts** 修复\n- `b.test.ts` 通过',
    });
    render(<SubagentSettledPill content={notice.content} details={{ childId: 'sa-2', stopReason: 'completed' }} />);
    expand();
    expect(screen.getByTestId('subagent-settled-body').textContent).toContain('修复');
    expect(await screen.findByText('a.test.ts')).toBeTruthy();
    expect(screen.getByTestId('subagent-settled-note').textContent).toContain('还能接着做');
    // 再点收起，正文不再占位。
    expand();
    expect(screen.queryByTestId('subagent-settled-body')).toBeNull();
  });

  it('keeps the diagnostic separate from partial output on failure', () => {
    const notice = settled({
      childId: 'sa-3',
      stopReason: 'error',
      output: '写了一半',
      diagnostic: 'uncaught error: boom',
    });
    render(<SubagentSettledPill content={notice.content} details={{ childId: 'sa-3', stopReason: 'error' }} />);
    expect(screen.getByTestId('task-notice-title').textContent).toBe('子代理 sa-3 失败');
    expect(screen.getByTestId('subagent-settled-pill').getAttribute('data-outcome')).toBe('failed');
    expand();
    expect(screen.getByTestId('subagent-settled-body').textContent).toContain('写了一半');
    expect(screen.getByTestId('subagent-settled-diagnostic').textContent).toBe('未捕获错误：boom');
    // 失败时没有「还能接着做」这类投递提示。
    expect(screen.queryByTestId('subagent-settled-note')).toBeNull();
  });

  it('separates aborted from timeout and never calls either completed', () => {
    const aborted = settled({ childId: 'sa-4', stopReason: 'aborted', output: '' });
    const { unmount } = render(
      <SubagentSettledPill content={aborted.content} details={{ childId: 'sa-4', stopReason: 'aborted' }} />,
    );
    let title = screen.getByTestId('task-notice-title').textContent ?? '';
    expect(screen.getByTestId('subagent-settled-pill').getAttribute('data-outcome')).toBe('aborted');
    expect(title).toBe('子代理 sa-4 会话已中止');
    expect(title).not.toContain('已完成');
    unmount();

    const timedOut = settled({
      childId: 'sa-5',
      stopReason: 'aborted',
      output: '',
      diagnostic: 'idle timeout: no activity for 300s',
    });
    render(<SubagentSettledPill content={timedOut.content} details={{ childId: 'sa-5', stopReason: 'aborted' }} />);
    expect(screen.getByTestId('subagent-settled-pill').getAttribute('data-outcome')).toBe('timeout');
    title = screen.getByTestId('task-notice-title').textContent ?? '';
    expect(title).toBe('子代理 sa-5 已超时');
    expand();
    expect(screen.getByTestId('subagent-settled-diagnostic').textContent).toContain('空闲超时');
  });

  it('does not turn an unknown stop reason into completion', () => {
    render(<SubagentSettledPill content="Background subagent sa-6" details={{ childId: 'sa-6', stopReason: 'paused' }} />);
    const pill = screen.getByTestId('subagent-settled-pill');
    expect(pill.getAttribute('data-outcome')).toBe('unknown');
    expect(screen.getByTestId('task-notice-title').textContent).toContain('状态未知');
    expect(pill.textContent).not.toContain('已完成');
  });

  it('keeps legacy content working when details are missing', () => {
    render(
      <SubagentSettledPill
        content={
          'Background subagent sa-1 finished and will do no further work unless you send it more.\nIts closing message:\nok'
        }
      />,
    );
    expect(screen.getByTestId('task-notice-title').textContent).toBe('子代理 sa-1 已完成');
    expect(screen.getByTestId('subagent-settled-pill').textContent).not.toContain('已注入上下文');
    expand();
    expect(screen.getByTestId('subagent-settled-body').textContent).toContain('ok');
  });

  it('says explicitly that the settlement carried no body, in one line', () => {
    const notice = settled({ childId: 'sa-7', stopReason: 'completed', output: '   ' });
    render(<SubagentSettledPill content={notice.content} details={{ childId: 'sa-7', stopReason: 'completed' }} />);
    expect(screen.getByTestId('subagent-settled-pill').getAttribute('data-state')).toBe('closed');
    expand();
    expect(screen.getByTestId('subagent-settled-no-body').textContent).toBe('结算通知未附结果正文。');
  });

  it('shows an empty structured notice without crashing', () => {
    render(<SubagentSettledPill content="" details={{ childId: 'sa-8', stopReason: 'completed' }} />);
    expect(screen.getByTestId('task-notice-title').textContent).toBe('子代理 sa-8 已完成');
  });

  it('does not split a completed closing message that itself contains Diagnostic / closing markers', () => {
    const body = [
      '修复完成。',
      '',
      'Diagnostic: timeout in test fixture (quoted output, not the settlement reason)',
      'Its closing message:',
    ].join('\n');
    const notice = settled({ childId: 'sa-9', stopReason: 'completed', output: body });
    render(<SubagentSettledPill content={notice.content} details={{ childId: 'sa-9', stopReason: 'completed' }} />);
    expand();
    expect(screen.getByTestId('subagent-settled-body').textContent).toContain('quoted output');
    expect(screen.queryByTestId('subagent-settled-diagnostic')).toBeNull();
  });
});
