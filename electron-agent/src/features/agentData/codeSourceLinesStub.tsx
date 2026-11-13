import { forwardRef, useImperativeHandle } from 'react';
import { vi } from 'vitest';

/** jsdom 编排测试的 viewer 替身：画整份行、记录 scrollToLine；真实 CodeMirror 由 CodeSourceLines.test 与 ui-harness 覆盖。 */
export const scrollToLineSpy = vi.fn();

export const CodeSourceLines = forwardRef(function CodeSourceLinesStub({ lines, target }: { lines: string[]; target?: number }, ref) {
  useImperativeHandle(ref, () => ({ scrollToLine: scrollToLineSpy }));
  return <pre aria-label="源码内容">{lines.map((text, index) => (
    <div key={index} data-testid={`code-source-line-${index + 1}`} aria-current={target === index + 1 ? 'location' : undefined}>{text}</div>
  ))}</pre>;
});