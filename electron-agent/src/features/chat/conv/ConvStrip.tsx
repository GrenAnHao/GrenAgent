import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode } from 'react';
import { Disclosure } from './Disclosure';
import { StatusGlyph, type ConvStatus } from './StatusGlyph';

const styles = createStaticStyles(({ css }) => ({
  strip: css`
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-block: 2px;
    padding: 6px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color 0.12s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  l1: css`
    display: flex;
    align-items: center;
    gap: 8px;
  `,
  title: css`
    flex: none;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  role: css`
    flex: none;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  spacer: css`
    flex: 1;
    min-width: 0;
  `,
  right: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
  `,
  model: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    padding: 1px 6px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    white-space: nowrap;
  `,
  l2: css`
    padding-inline-start: 22px;
    overflow: hidden;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

interface ConvStripProps {
  status: ConvStatus;
  icon: LucideIcon;
  title: string;
  /** 角色 / 任务短标签（第一行主文案，非 code）。 */
  role?: ReactNode;
  /** 第二行（实时步骤 / 终态摘要）。 */
  line2?: ReactNode;
  /** 模型 chip（第一行最右）。 */
  model?: ReactNode;
  /** 运行可停止：传入后左侧状态图标 hover 变停止键。 */
  onStop?: (e: MouseEvent) => void;
  /** 其它右侧操作（置于 model 左侧）。 */
  actions?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L3 横条：双行 surface（角色前置 + 实时/摘要第二行 + 模型靠右）。 */
export const ConvStrip = memo(function ConvStrip({
  status,
  icon,
  title,
  role,
  line2,
  model,
  onStop,
  actions,
  open = false,
  onToggle,
  'data-testid': testId,
}: ConvStripProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className={`conv-strip ${styles.strip}`} data-testid={testId} onClick={onToggle}>
      <div className={styles.l1}>
        <StatusGlyph status={status} onStop={onStop} />
        <Icon icon={icon} size={14} style={{ color: cssVar.colorInfo, flex: 'none' }} />
        <span className={styles.title}>{title}</span>
        {role != null ? (
          <>
            <span style={{ flex: 'none', color: cssVar.colorTextQuaternary }}>·</span>
            <span className={styles.role}>{role}</span>
          </>
        ) : null}
        <span className={styles.spacer} />
        <div className={styles.right} onClick={stop}>
          {actions}
          {model != null ? <span className={styles.model}>{model}</span> : null}
          {onToggle ? <Disclosure open={open} /> : null}
        </div>
      </div>
      {line2 != null ? <div className={styles.l2}>{line2}</div> : null}
    </div>
  );
});
