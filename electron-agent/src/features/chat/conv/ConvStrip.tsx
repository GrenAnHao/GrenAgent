import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode } from 'react';
import { ModelNameTag } from '../ModelNameTag';
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
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    transition: border-color 0.12s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }

    /* 运行态：默认转圈，悬停换成停止方块。规则必须挂在 .conv-strip 自身上。 */
    &:hover [data-role='run-spinner'] {
      display: none;
    }

    &:hover [data-role='run-stop'] {
      display: inline-flex;
    }
  `,
  l1: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,
  title: css`
    flex: none;
    font-weight: 600;
    color: ${cssVar.colorText};
    white-space: nowrap;
  `,
  role: css`
    flex: 1 1 0;
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
    flex: 0 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 46%;
  `,
  chevron: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 2px;
    margin: -2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  l2: css`
    padding-inline-start: 22px;
    overflow: hidden;
    min-width: 0;
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
  /** 模型名（第一行最右）。字符串渲染成标签；空白不占位。 */
  model?: ReactNode;
  /** 运行可停止：传入后左侧状态图标 hover 变停止键。 */
  onStop?: (e: MouseEvent) => void;
  /** 其它右侧操作（置于 model 左侧）。 */
  actions?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  /** 点横条本体时调用（如在右坞打开详情）。提供后展开/收起只走右侧折叠箭头。 */
  onOpen?: () => void;
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
  onOpen,
  'data-testid': testId,
}: ConvStripProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    onToggle?.();
  };
  return (
    <div className={`conv-strip ${styles.strip}`} data-testid={testId} onClick={onOpen ?? onToggle}>
      <div className={styles.l1}>
        <StatusGlyph status={status} onStop={onStop} />
        <Icon icon={icon} size={14} style={{ color: cssVar.colorInfo, flex: 'none' }} />
        <span className={styles.title}>{title}</span>
        {role != null ? (
          <>
            <span style={{ flex: 'none', color: cssVar.colorTextQuaternary }}>·</span>
            <span
              className={styles.role}
              data-testid="conv-strip-role"
              title={typeof role === 'string' ? role : undefined}
            >
              {role}
            </span>
          </>
        ) : (
          <span className={styles.spacer} />
        )}
        <div className={styles.right} onClick={stop}>
          {actions}
          {typeof model === 'string' ? (
            <ModelNameTag name={model} testId="conv-strip-model" />
          ) : (
            model || null
          )}
          {onToggle && onOpen ? (
            <button
              type="button"
              className={styles.chevron}
              aria-label={open ? '收起' : '展开'}
              aria-expanded={open}
              title={open ? '收起' : '展开'}
              onClick={toggle}
            >
              <Disclosure open={open} />
            </button>
          ) : onToggle ? (
            <Disclosure open={open} />
          ) : null}
        </div>
      </div>
      {line2 != null ? <div className={styles.l2}>{line2}</div> : null}
    </div>
  );
});
