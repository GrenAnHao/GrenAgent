import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';
import FileIcon from '../../components/FileIcon';
import { languageFileName, languageLabel } from './codeLanguage';

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
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      height: 0;
    }

    &:hover {
      scrollbar-width: thin;
    }

    &:hover::-webkit-scrollbar {
      height: 6px;
    }
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
}));

export const CodeCard = memo(function CodeCard({
  fileName,
  language,
  added = 0,
  deleted = 0,
  children,
}: {
  fileName?: string;
  language?: string;
  added?: number;
  deleted?: number;
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
      <div className={styles.body} data-testid="code-card-body">
        <div className={styles.core}>{children}</div>
      </div>
    </div>
  );
});
