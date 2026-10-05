import { Tag } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';

const styles = createStaticStyles(({ css }) => ({
  tag: css`
    &.ant-tag {
      flex: 0 1 auto;
      width: auto;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
    }
  `,
  text: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

/** 子代理模型名。空字符串不渲染，避免留下一块空底。 */
export function ModelNameTag({ name, testId }: { name: string; testId?: string }) {
  const text = name.trim();
  if (!text) return null;
  return (
    <Tag size="small" title={text} className={styles.tag} data-testid={testId}>
      <span className={styles.text}>{text}</span>
    </Tag>
  );
}
