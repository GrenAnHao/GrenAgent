import { ActionIcon, Block, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import {
  Ban,
  CheckCircle2,
  CircleDot,
  CircleStop,
  Eye,
  FilePen,
  Loader2,
  PencilLine,
  XCircle,
} from 'lucide-react';
import { useMemo, type MouseEvent } from 'react';
import type { SubAgentItem } from '../../lib/pi';
import { accessLabel, parseSubAgentType, presetLabel } from './subAgentType';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  main: css`
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: 4px;
  `,
  title: css`
    overflow: hidden;
    font-size: 13px;
    line-height: 1.4;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  pill: css`
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0 6px;
    height: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    font-size: 11px;
    line-height: 1;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;
  `,
  pillReadonly: css`
    border-color: color-mix(in srgb, ${cssVar.colorInfo} 40%, transparent);
    background: color-mix(in srgb, ${cssVar.colorInfo} 12%, transparent);
    color: ${cssVar.colorInfo};
  `,
  pillWrite: css`
    border-color: color-mix(in srgb, ${cssVar.colorWarning} 40%, transparent);
    background: color-mix(in srgb, ${cssVar.colorWarning} 12%, transparent);
    color: ${cssVar.colorWarning};
  `,
  dim: css`
    overflow: hidden;
    max-width: 120px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  stop: css`
    flex: none;
  `,
}));

function statusMeta(status: string) {
  switch (status) {
    case 'running':
      return { icon: Loader2, color: cssVar.colorInfo, spin: true };
    case 'done':
      return { icon: CheckCircle2, color: cssVar.colorSuccess, spin: false };
    case 'error':
      return { icon: XCircle, color: cssVar.colorError, spin: false };
    case 'cancelled':
      return { icon: Ban, color: cssVar.colorTextTertiary, spin: false };
    default:
      return { icon: CircleDot, color: cssVar.colorTextTertiary, spin: false };
  }
}

/** 时间戳 → 中文相对时间（刚刚 / N分钟前 / N小时前 / N天前）。 */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.floor(hr / 24);
  return `${day}天前`;
}

interface SubAgentCardProps {
  item: SubAgentItem;
  onOpen: () => void;
  onStop: () => void;
}

export function SubAgentCard({ item, onOpen, onStop }: SubAgentCardProps) {
  const type = useMemo(() => parseSubAgentType(item.profile), [item.profile]);
  const sm = statusMeta(item.status);
  const running = item.status === 'running';
  const access = accessLabel(type);

  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    onStop();
  };

  return (
    <div className={styles.card} onClick={onOpen} data-testid={`subagent-card-${item.id}`}>
      <Block
        align="center"
        justify="center"
        style={{ flex: 'none', width: 24, height: 24, color: sm.color }}
      >
        <Icon icon={sm.icon} size={15} spin={sm.spin} />
      </Block>
      <div className={styles.main}>
        <span className={styles.title} title={item.task}>
          {item.task || '子代理任务'}
        </span>
        <div className={styles.meta}>
          <span className={styles.pill} title={`预设：${type.preset}`}>
            {presetLabel(type.preset)}
          </span>
          <span
            className={cx(styles.pill, type.access === 'readonly' ? styles.pillReadonly : styles.pillWrite)}
            title={`文件系统：${access}`}
          >
            <Icon icon={type.access === 'readonly' ? Eye : type.restricted ? FilePen : PencilLine} size={11} />
            {access}
          </span>
          {item.model ? (
            <span className={styles.dim} title={item.model}>
              {item.model}
            </span>
          ) : null}
          <span>{formatRelative(item.updatedAt)}</span>
        </div>
      </div>
      {running ? (
        <ActionIcon
          className={styles.stop}
          icon={CircleStop}
          size="small"
          title="停止子代理"
          onClick={stop}
        />
      ) : null}
    </div>
  );
}
