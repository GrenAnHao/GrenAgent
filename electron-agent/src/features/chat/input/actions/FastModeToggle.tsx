import { Icon } from '@lobehub/ui';
import { Tooltip } from 'antd';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Zap } from 'lucide-react';
import { useModelMessages } from '../../../../lib/modelMessages';

const styles = createStaticStyles(({ css }) => ({
  button: css`
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 24px;
    padding: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusSM};
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
    &:hover:not(:disabled) { background: ${cssVar.colorFillSecondary}; }
    &:focus-visible { outline: 2px solid ${cssVar.colorPrimary}; outline-offset: 2px; }
    &:disabled { cursor: wait; opacity: 0.5; }
  `,
  active: css`
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
    border-color: ${cssVar.colorPrimaryBorder};
    & svg { fill: currentColor; }
  `,
  error: css`font-size: 11px; color: ${cssVar.colorErrorText}; margin-top: 6px;`,
}));

/**
 * 会话 Fast 开关：值来自当前输入栏 owner 的 `preferences.fastMode`，写入走
 * `writeComposerPreference('fastMode')`。不再读/写按供应商+模型共享的全局 store。
 * `false` 是有效值（关闭），不会因为假值被过滤掉。
 */
export function FastModeToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}) {
  const messages = useModelMessages();
  const text = enabled ? messages.fastOn : messages.fastOff;
  return (
    <Tooltip title={text}>
      <button type="button" data-testid="model-fast-toggle" aria-label={text} aria-pressed={enabled}
        disabled={disabled === true} className={cx(styles.button, enabled && styles.active)}
        onClick={() => onToggle(!enabled)}>
        <Icon icon={Zap} size={14} />
      </button>
    </Tooltip>
  );
}

/** 保存/读取失败的可见提示；只在本控件的写入失败时出现（加载失败由整个控件统一报）。 */
export function FastModeError({ onRetry }: { onRetry?: () => void }) {
  const messages = useModelMessages();
  return <div role="alert" className={styles.error} data-testid="model-fast-error">
    {messages.fastSaveError}
    {onRetry ? <button type="button" onClick={onRetry}>{messages.retry}</button> : null}
  </div>;
}
