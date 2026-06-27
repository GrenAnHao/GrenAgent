import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Check } from 'lucide-react';
import { memo } from 'react';

const styles = createStaticStyles(({ css }) => ({
  opt: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12.5px;
    cursor: pointer;
    transition:
      border-color 0.1s ease,
      background 0.1s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
      color: ${cssVar.colorText};
    }
  `,
  sel: css`
    border-color: ${cssVar.colorInfo};
    background: color-mix(in srgb, ${cssVar.colorInfo} 12%, transparent);
    color: ${cssVar.colorText};
  `,
  key: css`
    flex: none;
    width: 12px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 10.5px;
    color: ${cssVar.colorTextQuaternary};
  `,
  label: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rec: css`
    margin-inline-start: auto;
    flex: none;
    font-size: 10px;
    color: ${cssVar.colorInfo};
  `,
  ck: css`
    margin-inline-start: auto;
    flex: none;
    color: ${cssVar.colorInfo};
  `,
}));

interface OptionRowProps {
  index: number;
  label: string;
  selected: boolean;
  recommended?: boolean;
  multi?: boolean;
  onClick: () => void;
}

/** ask_user 选项行：等宽序号 + 文本 + 选中(靛蓝边/淡底)；多选显勾、单选显推荐标。 */
export const OptionRow = memo(function OptionRow({
  index,
  label,
  selected,
  recommended,
  multi,
  onClick,
}: OptionRowProps) {
  return (
    <div className={cx(styles.opt, selected && styles.sel)} onClick={onClick}>
      <span className={styles.key}>{index}</span>
      <span className={styles.label}>{label}</span>
      {multi && selected ? <Icon className={styles.ck} icon={Check} size={13} /> : null}
      {!multi && recommended ? <span className={styles.rec}>推荐</span> : null}
    </div>
  );
});
