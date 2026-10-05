import { createStaticStyles, cssVar } from 'antd-style';
import { cardStyles } from '../tools/cardStyles';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 0;
  `,
  line: css`
    flex: 1 1 auto;
    height: 1px;
    background: ${cssVar.colorBorderSecondary};
  `,
  label: css`
    flex: none;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.55;
  `,
}));

/** 会话里的压缩分隔线。进行中「正在压缩」用和深度思考一样的灰色扫光，完成后「已压缩」静止。 */
export function CompactionDivider({
  label,
  live = false,
  testId = 'compaction-marker',
}: {
  label: string;
  live?: boolean;
  testId?: string;
}) {
  return (
    <div className={styles.row} role="status" data-testid={testId}>
      <span className={styles.line} aria-hidden />
      <span className={live ? cardStyles.shinyText : styles.label}>{label}</span>
      <span className={styles.line} aria-hidden />
    </div>
  );
}
