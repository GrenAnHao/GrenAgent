import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from 'antd';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { agentDataApi } from '../../lib/agentData';
import {
  CODE_PAGE_SIZE,
  decodeCodeResult,
  appendCodeResultPage,
  type CodeResultRow,
  type CodeResultView,
} from './codeResult';
import { CodeResultContent, codeRequestError } from './CodeRelations';
import { browseStyles as s } from './codeBrowseStyles';

interface BranchProps {
  workspace: string;
  path: string;
  hideIgnored: boolean;
  revision: number;
  enabled: boolean;
  selected?: CodeResultRow;
  onSelect: (row: CodeResultRow, el: HTMLElement) => void;
  actions: (file: string) => ReactNode;
}
export function IndexDirectoryRow({ fileCount, ...props }: BranchProps & { fileCount?: number }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight,
    Icon = open ? FolderOpen : Folder;
  return (
    <>
      <button
        className={s.folder}
        data-code-entry
        data-directory={props.path}
        aria-expanded={open}
        title={props.path}
        onClick={() => setOpen(!open)}
      >
        <Chevron size={13} />
        <Icon size={15} />
        <span>{props.path.split('/').pop()}</span>
        <small>{fileCount?.toLocaleString()}</small>
      </button>
      {open && <Branch {...props} />}
    </>
  );
}
function Branch(props: BranchProps) {
  const { workspace, path, hideIgnored, revision, enabled } = props;
  const [result, setResult] = useState<CodeResultView>();
  const [error, setError] = useState<{ message: string; offset: number }>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  async function load(offset = 0) {
    const key = ++epoch.current;
    setBusy(true);
    setError(undefined);
    try {
      const raw = await agentDataApi.code.call({
        workspace,
        tool: 'codegraph_files',
        args: { path, hideIgnored, format: 'children', limit: CODE_PAGE_SIZE, offset },
      });
      if (epoch.current !== key) return;
      const next = decodeCodeResult('codegraph_files', raw);
      if (next.isError || next.recognition !== 'rows') throw new Error(next.text || '目录数据无法读取');
      if (offset && result?.page?.total !== next.page?.total) {
        setRetry((r) => r + 1);
        return;
      }
      setResult((old) => (offset && old ? appendCodeResultPage(old, next) : next));
    } catch (e) {
      if (key === epoch.current) setError({ message: codeRequestError(e), offset });
    } finally {
      if (key === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (enabled) void load();
    return () => {
      epoch.current++;
    };
  }, [workspace, path, hideIgnored, revision, enabled, retry]);
  return (
    <div className={s.branch}>
      {error && (
        <div role="alert">
          {error.message}
          <Button type="link" size="small" onClick={() => void load(error.offset)}>
            重试
          </Button>
        </div>
      )}
      {!result && busy && <small>读取目录…</small>}
      {result && (
        <CodeResultContent
          result={result}
          tool="codegraph_files"
          onSelect={props.onSelect}
          selected={props.selected}
          more={{
            remaining: (result.page?.total ?? 0) - result.rows.length,
            loading: busy,
            onLoad: () => void load(result.rows.length),
          }}
          browser={{
            nested: true,
            actions: props.actions,
            directory: (row) => <IndexDirectoryRow {...props} path={row.file!} fileCount={row.fileCount} />,
          }}
        />
      )}
    </div>
  );
}
