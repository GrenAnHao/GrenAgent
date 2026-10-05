import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ExternalLink, PencilLine } from 'lucide-react';
import { openPath } from '../../platform/runtime';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useDockStore, type ReviewPayload } from '../../stores/dockStore';
import { reviewView } from '../chat/reviewView';
import { resolveWorkspaceFile } from '../chat/turnDeliverables';
import { FileDiffBlock } from '../tools/FileDiffBlock';
import { dockTabStyles } from './dockTabStyles';
import type { DockBodyProps } from './TabBodyRenderer';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: ${cssVar.colorBgContainer};
  `,
  toolbar: css`
    display: flex;
    flex: none;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  title: css`
    display: inline-flex;
    min-width: 0;
    gap: 6px;
    align-items: center;
    overflow: hidden;
    color: ${cssVar.colorText};
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
  `,
  open: css`
    display: inline-flex;
    flex: none;
    gap: 4px;
    align-items: center;
    padding: 2px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font: inherit;
    font-size: 12px;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }

    &:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `,
  files: css`
    display: flex;
    flex: none;
    flex-direction: column;
    max-height: 40%;
    min-height: 0;
    overflow: auto;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  row: css`
    display: flex;
    gap: 8px;
    align-items: center;
    width: 100%;
    padding: 5px 10px;
    border: none;
    background: transparent;
    color: ${cssVar.colorText};
    font: inherit;
    font-size: 13px;
    text-align: start;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  rowSelected: css`
    background: ${cssVar.colorFillSecondary};
  `,
  name: css`
    overflow: hidden;
    flex: 0 1 auto;
    min-width: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  totals: css`
    flex-shrink: 0;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
  added: css`
    color: ${cssVar.colorSuccess};
  `,
  deleted: css`
    color: ${cssVar.colorError};
  `,
  hunks: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  `,
}));

function EmptyBody({ testId, text }: { testId?: string; text: string }) {
  return (
    <div className={dockTabStyles.empty} data-testid={testId}>
      {text}
    </div>
  );
}

export function TurnReviewBody({ tab }: DockBodyProps) {
  const payload = tab.payload as ReviewPayload;
  const context = useOptionalAgentStoreContext();
  const messages = context?.store.useStore((state) => state.messages) ?? [];
  const view = context ? reviewView(messages, payload) : { kind: 'empty' as const };
  const workspace = payload.workspace ?? context?.workspace ?? '';

  if (view.kind === 'empty') {
    return <EmptyBody testId="review-empty" text="从对话里的已编辑进来，查看本轮改动。" />;
  }
  if (view.kind === 'missing') {
    return <EmptyBody text="找不到这一轮" />;
  }
  if (view.kind === 'none') {
    return <EmptyBody text="这一轮没有文件改动" />;
  }
  if (view.kind === 'unavailable') {
    return <EmptyBody text="改动内容已不可用" />;
  }

  const selected = view.files[view.selected];
  const resolved = selected ? resolveWorkspaceFile(workspace, selected.path) : null;

  return (
    <div className={styles.root} data-testid="turn-review">
      <div className={styles.toolbar}>
        <span className={styles.title}>
          <Icon icon={PencilLine} size={14} />
          {`本轮改动 · ${view.files.length} 个文件`}
        </span>
        <button
          type="button"
          className={styles.open}
          disabled={!resolved}
          onClick={() => {
            if (!resolved) return;
            void openPath(resolved);
          }}
        >
          <Icon icon={ExternalLink} size={14} />
          打开文件
        </button>
      </div>
      <div className={styles.files}>
        {view.files.map((file, index) => (
          <button
            key={file.path}
            type="button"
            className={cx(styles.row, index === view.selected && styles.rowSelected)}
            onClick={() => {
              useDockStore.getState().updateTab(tab.id, { payload: { ...payload, fileIndex: index } });
            }}
          >
            <span className={styles.name}>{file.display}</span>
            <span className={styles.totals}>
              <span className={styles.added}>+{file.added}</span>{' '}
              <span className={styles.deleted}>-{file.deleted}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.hunks}>
        {view.hunks.map((hunk, index) => (
          <FileDiffBlock
            key={`${hunk.path}-${index}`}
            path={hunk.path}
            rows={hunk.rows}
            added={hunk.added}
            deleted={hunk.deleted}
          />
        ))}
      </div>
    </div>
  );
}
