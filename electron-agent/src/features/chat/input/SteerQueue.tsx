import { Icon } from '@lobehub/ui';
import { CornerDownRight, ListPlus } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { useChatInput } from './ChatInputContext';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;
    gap: 4px;

    margin-bottom: 6px;
  `,
  item: css`
    display: flex;
    gap: 6px;
    align-items: center;

    padding: 4px 10px;
    border-radius: ${cssVar.borderRadius};

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};
  `,
  label: css`
    flex-shrink: 0;

    font-weight: 500;
    color: ${cssVar.colorTextTertiary};
  `,
  text: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;

    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

/**
 * 执行中已排队的引导（steer，注入当前回合）/ 跟进（followUp，回合结束后执行）消息指示器。
 * 数据来自 pi 的 queue_update 事件（store.steering / store.followUp）。
 */
export function SteerQueue() {
  const { steering, followUp } = useChatInput();
  if (steering.length === 0 && followUp.length === 0) return null;

  return (
    <div className={styles.wrap} data-testid="steer-queue">
      {steering.map((text, i) => (
        <div key={`s-${i}`} className={styles.item}>
          <Icon icon={CornerDownRight} size={13} />
          <span className={styles.label}>引导</span>
          <span className={styles.text}>{text}</span>
        </div>
      ))}
      {followUp.map((text, i) => (
        <div key={`f-${i}`} className={styles.item}>
          <Icon icon={ListPlus} size={13} />
          <span className={styles.label}>跟进</span>
          <span className={styles.text}>{text}</span>
        </div>
      ))}
    </div>
  );
}
