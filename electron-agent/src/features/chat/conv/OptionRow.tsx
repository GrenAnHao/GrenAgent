import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Check } from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { labelOverflows } from './labelOverflows';

const styles = createStaticStyles(({ css }) => ({
  opt: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
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
  /** 序号：字母（A/B/C）或数字，等宽显示。 */
  index: number | string;
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
  const labelRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = labelRef.current;
    setOverflow(el ? labelOverflows(el) : false);
  }, [label]);

  return (
    <div className={cx(styles.opt, selected && styles.sel)} onClick={onClick}>
      <span className={styles.key}>{index}</span>
      <span
        ref={labelRef}
        className={styles.label}
        data-testid="option-row-label"
        title={overflow ? label : undefined}
      >
        {label}
      </span>
      {multi && selected ? <Icon className={styles.ck} icon={Check} size={13} /> : null}
      {!multi && recommended ? <span className={styles.rec}>推荐</span> : null}
    </div>
  );
});
