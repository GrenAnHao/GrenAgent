import { createContext, useContext, type ReactNode } from 'react';
import { createStaticStyles } from 'antd-style';

/** 输入区窄于此宽度时，底栏和项目标签只留图标。 */
export const COMPOSER_COMPACT_BELOW = 520;

export function composerIsCompact(width: number): boolean {
  return width > 0 && width < COMPOSER_COMPACT_BELOW;
}

const ComposerCompactContext = createContext(false);

export function ComposerCompactProvider({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}) {
  return <ComposerCompactContext.Provider value={compact}>{children}</ComposerCompactContext.Provider>;
}

export function useComposerCompact(): boolean {
  return useContext(ComposerCompactContext);
}

/** 收起文字但留在无障碍树里，避免下拉失去当前值。 */
export const compactLabelStyles = createStaticStyles(({ css }) => ({
  clip: css`
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  `,
}));
