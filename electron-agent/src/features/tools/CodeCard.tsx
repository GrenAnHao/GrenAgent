import { createStaticStyles, cssVar, cx } from 'antd-style';
import { memo, type ReactNode } from 'react';
import FileIcon from '../../components/FileIcon';
import { languageFileName, languageLabel } from './codeLanguage';

/** 读取、检索正文统一内边距。borderless 高亮会把 pre 内边距清零。 */
export const codeCardContentClass = createStaticStyles(({ css }) => ({
  content: css`
    pre {
      padding: 16px !important;
    }
  `,
})).content;

const styles = createStaticStyles(({ css }) => ({
  shell: css`
    overflow: hidden;
    width: 100%;
    min-width: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 4px;
    border-block-end: 1px solid ${cssVar.colorFillQuaternary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  title: css`
    display: flex;
    flex: 1;
    gap: 4px;
    align-items: center;
    min-width: 0;
    padding-inline: 8px;
  `,
  name: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  stats: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    padding-inline-end: 8px;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  `,
  add: css`
    color: ${cssVar.colorSuccess};
  `,
  del: css`
    color: ${cssVar.colorError};
  `,
  body: css`
    min-width: 0;
    max-height: min(50vh, 360px);
    overflow: auto;
  `,
  bodyContained: css`
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `,
  core: css`
    width: max-content;
    min-width: 100%;

    &,
    & * {
      border-radius: 0 !important;
      overflow: visible !important;
    }
  `,
  coreContained: css`
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    min-height: auto;

    & * {
      border-radius: 0 !important;
    }
  `,
}));

export const CodeCard = memo(function CodeCard({
  fileName,
  language,
  added = 0,
  deleted = 0,
  contained = false,
  maxHeight,
  children,
}: {
  fileName?: string;
  language?: string;
  added?: number;
  deleted?: number;
  /** 正文不自己滚，高度交给内部组件，避免把整个子组件拖着走。 */
  contained?: boolean;
  /** 正文最大高度（CSS 长度）。不给就是会话卡的 `min(50vh, 360px)`。 */
  maxHeight?: string;
  children: ReactNode;
}) {
  const title = fileName || (language ? languageLabel(language) : '');
  const iconName = fileName || (language ? languageFileName(language) : 'file');
  const showStats = added > 0 || deleted > 0;

  return (
    <div className={styles.shell} data-testid="code-card">
      <div className={styles.header} data-testid="code-card-header">
        <div className={styles.title}>
          <FileIcon fileName={iconName} size={18} variant="raw" />
          <span className={styles.name} data-testid="code-card-name">
            {title}
          </span>
        </div>
        {showStats ? (
          <div className={styles.stats} data-testid="code-card-stats">
            {added > 0 ? <span className={styles.add}>+{added}</span> : null}
            {deleted > 0 ? <span className={styles.del}>-{deleted}</span> : null}
          </div>
        ) : null}
      </div>
      <div
        className={cx(styles.body, contained && styles.bodyContained)}
        data-testid="code-card-body"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <div className={contained ? styles.coreContained : styles.core}>{children}</div>
      </div>
    </div>
  );
});
