import { memo } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { PreparingIndicator } from './PreparingIndicator';

const styles = createStaticStyles(({ css }) => ({
  static: css`
    padding-block: 8px;
    font-size: 14px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export const PromptPendingRow = memo(function PromptPendingRow({
  label,
  live = false,
  'data-testid': testId,
}: {
  label: string;
  live?: boolean;
  'data-testid': string;
}) {
  if (live) {
    return (
      <div data-testid={testId}>
        <PreparingIndicator label={label} />
      </div>
    );
  }
  return (
    <div className={styles.static} data-testid={testId}>
      {label}
    </div>
  );
});
