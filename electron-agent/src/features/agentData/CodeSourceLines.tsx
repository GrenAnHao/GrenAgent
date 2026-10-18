import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { codeStyles as styles } from './codeStyles';

/** 超过这么多行才虚拟化；短文件整块渲染，在预览里选中、复制整段不受影响。 */
export const VIRTUALIZE_LINE_THRESHOLD = 1000;

export interface CodeSourceLinesHandle {
  /** 把第 line 行（从 1 起）滚到预览中间；行不在文件里就什么都不做。 */
  scrollToLine(line: number): void;
}

interface CodeSourceLinesProps { lines: string[]; /** 高亮并标 aria-current 的行（从 1 起） */ target?: number }

/**
 * 只读源码预览。滚动容器就是 `pre` 自己（max-height 在样式里），长文件用 virtua 的 Virtualizer 只挂可视窗口附近的行；
 * 行会按预览宽度折行、高度不一，由 Virtualizer 自己量。
 */
export const CodeSourceLines = forwardRef<CodeSourceLinesHandle, CodeSourceLinesProps>(function CodeSourceLines({ lines, target }, ref) {
  const scroller = useRef<HTMLPreElement>(null);
  const virtualizer = useRef<VirtualizerHandle>(null);
  const virtual = lines.length > VIRTUALIZE_LINE_THRESHOLD;

  useImperativeHandle(ref, () => ({
    scrollToLine(line) {
      if (line < 1 || line > lines.length) return;
      // 虚拟化后目标行可能根本没挂在 DOM 里，只能按下标滚。
      if (virtual) virtualizer.current?.scrollToIndex(line - 1, { align: 'center' });
      else scroller.current?.querySelector(`[data-source-line="${line}"]`)?.scrollIntoView?.({ block: 'center' });
    },
  }), [virtual, lines.length]);

  const renderLine = (text: string, index: number) => <div key={index} data-source-line={index + 1} data-testid={`code-source-line-${index + 1}`} aria-current={target === index + 1 ? 'location' : undefined}>
    <span data-line-number aria-hidden="true">{index + 1}</span><code>{text || ' '}</code>
  </div>;

  // 虚拟化时用 data + 函数子元素：只为窗口里的行创建元素，不是每次渲染都为整个文件造一遍。
  return <pre ref={scroller} className={styles.source} aria-label="源码内容">
    {virtual ? <Virtualizer ref={virtualizer} scrollRef={scroller} data={lines}>{renderLine}</Virtualizer> : lines.map(renderLine)}
  </pre>;
});
