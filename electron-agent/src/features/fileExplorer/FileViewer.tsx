import { Alert, App, Button } from 'antd';
import { cx } from 'antd-style';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { files } from '../../lib/files';
import { useElementMeasure } from '../../hooks/useElementMeasure';
import { formatBytes } from '../devtools/devtoolsFormat';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { LARGE_TEXT_BYTES, pathSegments } from './fileKinds';
import { MarkdownPreview } from './MarkdownPreview';
import type { OpenFileApi, TextFile } from './useOpenFile';
import { ViewerToolbar, type ViewerNav } from './ViewerToolbar';
import { FindBar } from '../find/FindBar';
import { useFindScope } from '../find/findStore';

// CodeMirror 只有打开文本文件才用得到，不进首包。
const LazyCodeEditor = lazy(() => import('./CodeEditor'));

/** 内容区比这宽时，markdown 编辑模式左边编辑、右边预览。 */
const SPLIT_PREVIEW_MIN_WIDTH = 1100;
const SPLIT_PREVIEW_DEBOUNCE_MS = 300;
const fitsSplitPreview = (width: number) => width >= SPLIT_PREVIEW_MIN_WIDTH;

export interface FileViewerProps {
  workspace: string;
  root: string | null;
  api: OpenFileApi;
  isDark: boolean;
  /** markdown 预览里点了链接（锚点由预览自己滚动，不会走到这里）。 */
  onOpenLink?: (href: string, options: { system: boolean }) => void;
  nav: ViewerNav;
  /** 这个文件标签的查找范围 id（即标签 id）；不给就没有查找。 */
  findScope?: string;
}

export function FileViewer({ workspace, root, api, isDark, onOpenLink, nav, findScope }: FileViewerProps) {
  const { file } = api;
  const { message } = App.useApp();
  const ref = useRef<HTMLDivElement | null>(null);
  const splitFits = useElementMeasure(ref, fitsSplitPreview);

  const openExternal = (path: string) => {
    files.openExternal(workspace, path).catch((err: unknown) => {
      void message.error(`无法用系统程序打开：${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // 没有打开文件（空闲 / 加载中 / 出错）时仍然显示后退 / 前进 / 刷新：打开失败的文件之后要能退回去。
  const navOnlyToolbar = (path: string | null) => (
    <ViewerToolbar
      segments={path ? pathSegments(root ?? '', path) : []}
      size={null}
      truncated={false}
      modeSwitch={null}
      dirty={false}
      saving={false}
      diff={null}
      onModeChange={api.setMode}
      onToggleDiff={() => {}}
      onSave={() => {}}
      nav={nav}
    />
  );

  let content;
  if (file.status === 'idle') {
    content = (
      <>
        {navOnlyToolbar(null)}
        <div className={styles.center}>从右边选一个文件查看</div>
      </>
    );
  } else if (file.status === 'loading') {
    content = (
      <>
        {navOnlyToolbar(file.path)}
        <div className={styles.center}>加载中…</div>
      </>
    );
  } else if (file.status === 'error') {
    content = (
      <>
        {navOnlyToolbar(file.path)}
        <div className={styles.center} data-testid="file-viewer-error">
          <span>打不开这个文件：{file.message}</span>
          <Button size="small" onClick={() => void api.open(file.path)}>
            重试
          </Button>
        </div>
      </>
    );
  } else {
    const toolbarBase = {
      segments: pathSegments(root ?? '', file.path),
      size: file.size,
      dirty: api.dirty,
      onModeChange: api.setMode,
      onSave: () => void api.save(),
      onOpenExternal: () => openExternal(file.path),
      nav,
    };
    if (file.status === 'text') {
      content = (
        <TextViewer
          file={file}
          api={api}
          isDark={isDark}
          splitFits={splitFits}
          toolbarBase={toolbarBase}
          onOpenExternal={openExternal}
          onOpenLink={onOpenLink}
          onNotice={(text) => void message.warning(text)}
          findScope={findScope}
          refocus={() => ref.current?.focus({ preventScroll: true })}
        />
      );
    } else {
      content = (
        <>
          <ViewerToolbar {...toolbarBase} truncated={false} modeSwitch={null} saving={false} diff={null} onToggleDiff={() => {}} />
          {file.status === 'image' ? (
            <div className={styles.image} data-testid="file-image-preview">
              <img src={file.url} alt={toolbarBase.segments.at(-1) ?? ''} />
            </div>
          ) : (
            <div className={styles.center} data-testid="file-unsupported">
              <span>这是二进制文件，不支持预览。</span>
              <Button size="small" onClick={() => openExternal(file.path)}>
                用系统打开
              </Button>
            </div>
          )}
        </>
      );
    }
  }

  return (
    // tabIndex：横幅按钮点完就卸载，焦点要有地方落，Ctrl+S 这类快捷键才还在这个标签里。
    <div ref={ref} className={styles.viewer} tabIndex={-1} data-testid="file-viewer">
      {content}
    </div>
  );
}

type ToolbarBase = Pick<
  Parameters<typeof ViewerToolbar>[0],
  'segments' | 'size' | 'dirty' | 'onModeChange' | 'onSave' | 'onOpenExternal' | 'nav'
>;

interface TextViewerProps {
  file: TextFile;
  api: OpenFileApi;
  isDark: boolean;
  /** 内容区够宽，编辑 markdown 时能左右分栏。 */
  splitFits: boolean;
  toolbarBase: ToolbarBase;
  onOpenExternal: (path: string) => void;
  onOpenLink?: (href: string, options: { system: boolean }) => void;
  onNotice: (text: string) => void;
  findScope?: string;
  /** 横幅里的按钮点完会消失，把焦点还给内容区。 */
  refocus: () => void;
}

function TextViewer({ file, api, isDark, splitFits, toolbarBase, onOpenExternal, onOpenLink, onNotice, findScope, refocus }: TextViewerProps) {
  const [showDiff, setShowDiff] = useState(false);
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const editing = file.mode === 'edit';
  const isMarkdown = file.kind === 'markdown';
  const large = file.size > LARGE_TEXT_BYTES;

  useEffect(() => {
    setShowDiff(false);
  }, [file.path, file.docVersion]);

  // markdown 只看不改就不加载编辑器；进过一次编辑后保留它（藏起来），撤销历史不丢。
  useEffect(() => {
    if (!isMarkdown || editing) setEditorPath(file.path);
  }, [file.path, isMarkdown, editing]);
  const mountEditor = !isMarkdown || editing || editorPath === file.path;
  const showEditor = !isMarkdown || editing;
  const showPreview = isMarkdown && (!editing || splitFits);
  // 查找的对象：markdown 只看不改时查预览，其余（代码、编辑中的 markdown）查编辑器。
  const findTarget: 'preview' | 'editor' = isMarkdown && !editing ? 'preview' : 'editor';
  const findOpen = useFindScope(findScope ?? '').open;

  return (
    <>
      <ViewerToolbar
        {...toolbarBase}
        truncated={file.truncated}
        saving={file.saving}
        modeSwitch={{ mode: file.mode, previewLabel: isMarkdown ? '预览' : '只读', disabled: file.truncated }}
        diff={editing ? { active: showDiff, disabled: large || (!api.dirty && !showDiff) } : null}
        onToggleDiff={() => setShowDiff((on) => !on)}
      />
      {findScope && findOpen ? <FindBar scope={findScope} placeholder="在文件中查找" data-testid="file-find-bar" /> : null}
      {file.disk === 'changed' ? (
        <Alert
          className={styles.banner}
          type="warning"
          showIcon
          data-testid="file-disk-changed"
          title="磁盘上的这个文件被改过了，和你未保存的修改冲突。"
          action={
            <>
              <Button size="small" danger onClick={() => void api.reloadFromDisk().then(refocus)}>
                重新载入
              </Button>
              <Button
                size="small"
                style={{ marginInlineStart: 6 }}
                onClick={() => {
                  api.keepLocal();
                  refocus();
                }}
              >
                保留我的修改
              </Button>
            </>
          }
        />
      ) : null}
      {file.disk === 'deleted' ? (
        <Alert className={styles.banner} type="warning" showIcon data-testid="file-disk-deleted" title="磁盘上的这个文件已被删除，保存会重新创建它。" />
      ) : null}
      {file.truncated ? (
        <Alert
          className={styles.banner}
          type="info"
          showIcon
          data-testid="file-truncated"
          title={`文件有 ${formatBytes(file.size)}，只显示前 5 MB，不能编辑。`}
          action={
            <Button size="small" onClick={() => onOpenExternal(file.path)}>
              用系统打开
            </Button>
          }
        />
      ) : null}
      {file.saveError ? (
        <Alert className={styles.banner} type="error" showIcon data-testid="file-save-error" title={`保存失败：${file.saveError}`} />
      ) : null}
      <div className={styles.body}>
        {mountEditor ? (
          <div className={styles.pane} style={showEditor ? undefined : { display: 'none' }}>
            <Suspense fallback={<div className={styles.center}>加载编辑器…</div>}>
              <LazyCodeEditor
                path={file.path}
                docVersion={file.docVersion}
                value={file.content}
                original={file.original}
                readOnly={!editing}
                showDiff={editing && showDiff}
                lineSeparator={file.lineSeparator}
                large={large}
                isDark={isDark}
                onChange={api.setContent}
                onActivity={api.noteEdit}
                bindEditorText={api.bindEditorText}
                findScope={findTarget === 'editor' ? findScope : undefined}
              />
            </Suspense>
          </div>
        ) : null}
        {showPreview ? (
          <div className={cx(styles.pane, editing && styles.splitPreview)}>
            <MarkdownPreview
              content={file.content}
              debounceMs={editing ? SPLIT_PREVIEW_DEBOUNCE_MS : 0}
              onOpenLink={onOpenLink}
              onNotice={onNotice}
              findScope={findTarget === 'preview' ? findScope : undefined}
              findResetKey={file.path}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
