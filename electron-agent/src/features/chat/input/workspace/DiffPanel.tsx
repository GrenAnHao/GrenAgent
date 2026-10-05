import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Modal } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ErrorBoundary } from '../../../../components/ErrorBoundary';
import { pi, type GitFileStatus } from '../../../../lib/pi';
import { useGitInfo, useGitStore } from '../../../../stores/gitStore';
import { FileDiffBlock } from '../../../tools/FileDiffBlock';
import { rowsFromGitPatch, totals } from '../../../tools/fileDiffModel';

const STATUS_META: Record<string, { tag: string; color: string; bg: string }> = {
  modified: { tag: 'M', color: cssVar.colorWarning, bg: cssVar.colorWarningBg },
  staged: { tag: 'A', color: cssVar.colorSuccess, bg: cssVar.colorSuccessBg },
  untracked: { tag: 'U', color: cssVar.colorTextSecondary, bg: cssVar.colorFillSecondary },
};

/**
 * 弹窗正文高度：视口减去弹窗头（56）、body 底部内边距（16）和上下留白，最高 820px。
 * 右侧 diff 卡片扣掉自己的文件头（约 34px）后正好铺满。
 */
const PANE_H = 'min(calc(100dvh - 160px), 820px)';
const DIFF_MAX_H = `calc(${PANE_H} - 36px)`;
/**
 * lobe Modal 的 body 默认 maxHeight 75dvh + overflow auto，再加底部 16px 内边距，
 * 正文稍高一点 body 就会自己滚。这里高度由 PANE_H 定，滚动只在文件列表和 diff 内部。
 */
const MODAL_STYLES: { body: CSSProperties } = { body: { maxHeight: 'none', overflow: 'hidden' } };

const d = createStaticStyles(({ css }) => ({
  wrap: css`
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);

    width: 100%;
    height: ${PANE_H};
  `,
  files: css`
    scrollbar-width: thin;
    overflow-y: auto;
    padding: 4px;
    border-right: 1px solid ${cssVar.colorBorderSecondary};
  `,
  file: css`
    display: flex;
    gap: 7px;
    align-items: center;

    padding: 6px 8px;
    border-radius: 6px;

    font-size: 12.5px;
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  fileSel: css`
    background: ${cssVar.colorFillSecondary};
  `,
  fn: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tag: css`
    flex: none;
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
  `,
  pane: css`
    overflow: hidden;
    min-width: 0;
    min-height: 0;
    padding-inline-start: 12px;
  `,
  center: css`
    display: flex;
    align-items: center;
    justify-content: center;

    height: 100%;

    font-size: 12.5px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

function DiffView({ workspace }: { workspace: string }) {
  const git = useGitInfo(workspace);
  const [sel, setSel] = useState<string | null>(git.changes[0]?.path ?? null);
  // patch 记下属于哪个文件：切换文件时，新请求回来之前不拿旧 patch 配新文件名渲染。
  const [loaded, setLoaded] = useState<{ path: string; patch: string } | null>(null);

  // 打开时改动列表可能还在刷新：选中项不在列表里就落到第一项。
  useEffect(() => {
    if (sel && git.changes.some((f) => f.path === sel)) return;
    setSel(git.changes[0]?.path ?? null);
  }, [git.changes, sel]);

  useEffect(() => {
    if (!sel) return;
    let alive = true;
    pi.getGitDiff(workspace, sel)
      .then((text) => {
        if (alive) setLoaded({ path: sel, patch: text });
      })
      .catch(() => {
        if (alive) setLoaded({ path: sel, patch: '' });
      });
    return () => {
      alive = false;
    };
  }, [workspace, sel]);

  const current = loaded && loaded.path === sel ? loaded : null;
  const parsed = useMemo(() => {
    const rows = current ? rowsFromGitPatch(current.patch) : [];
    return { rows, ...totals(rows) };
  }, [current]);

  let body;
  if (!sel) {
    body = <div className={d.center}>没有改动</div>;
  } else if (!current) {
    body = <div className={d.center}>加载中…</div>;
  } else if (parsed.rows.length === 0) {
    body = <div className={d.center}>{current.patch.trim() ? '二进制文件或无文本 diff' : '无文本 diff'}</div>;
  } else {
    // PatchDiff 解析不了的 patch（极少见）退回行级 diff，组件和会话里的编辑卡同一个。
    body = (
      <ErrorBoundary
        key={`${current.path}:${current.patch.length}`}
        fallback={
          <FileDiffBlock
            added={parsed.added}
            deleted={parsed.deleted}
            maxHeight={DIFF_MAX_H}
            path={current.path}
            rows={parsed.rows}
          />
        }
      >
        <FileDiffBlock
          added={parsed.added}
          deleted={parsed.deleted}
          maxHeight={DIFF_MAX_H}
          patch={current.patch}
          path={current.path}
        />
      </ErrorBoundary>
    );
  }

  return (
    <div className={d.wrap}>
      <div className={d.files}>
        {git.changes.map((f: GitFileStatus) => {
          const meta = STATUS_META[f.status] ?? {
            tag: 'M',
            color: cssVar.colorWarning,
            bg: cssVar.colorWarningBg,
          };
          return (
            <div
              key={f.path}
              className={cx(d.file, f.path === sel && d.fileSel)}
              title={f.path}
              onClick={() => setSel(f.path)}
            >
              <span className={d.tag} style={{ color: meta.color, background: meta.bg }}>
                {meta.tag}
              </span>
              <span className={d.fn}>{f.path}</span>
            </div>
          );
        })}
      </div>
      <div className={d.pane} data-testid="git-changes-diff">
        {body}
      </div>
    </div>
  );
}

/**
 * 改动模态框：文件列表 + 会话同款 diff 卡片（FileDiffBlock，按 git patch 渲染真实行号）。
 * 受控组件，由分支气泡里的「查看改动」入口开关。打开时刷新 git 概况。
 */
export function ChangesModal({
  workspace,
  open,
  onClose,
}: {
  workspace: string;
  open: boolean;
  onClose: () => void;
}) {
  const git = useGitInfo(workspace);
  const n = git.changes.length;

  useEffect(() => {
    if (open) void useGitStore.getState().load(workspace, true);
  }, [open, workspace]);

  return (
    <Modal
      centered
      data-testid="git-changes-modal"
      footer={null}
      styles={MODAL_STYLES}
      open={open}
      title={`改动（${n}）`}
      width="min(1280px, 92vw)"
      onCancel={onClose}
    >
      {open ? <DiffView workspace={workspace} /> : null}
    </Modal>
  );
}
