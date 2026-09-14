import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import { files, type FileNode } from '../../lib/files';
import { dockTabStyles } from './dockTabStyles';

interface FileTreeBodyProps {
  tab: { payload: { workspace?: string } };
  active?: boolean;
}

export function FileTreeBody({ tab }: FileTreeBodyProps) {
  const workspace = tab.payload.workspace ?? '';
  const [root, setRoot] = useState<FileNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(() => {
    if (!workspace) {
      setError('没有工作区');
      setRoot(null);
      return;
    }
    setError(null);
    files
      .getTree(workspace)
      .then((node) => {
        setRoot(node);
        setExpanded(new Set([node.path]));
      })
      .catch((err: unknown) => {
        setRoot(null);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [workspace]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className={dockTabStyles.empty} data-testid="file-tree-error">
        <span>无法加载文件树。{error}</span>
        <button type="button" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  if (!root) {
    return (
      <div className={dockTabStyles.empty} data-testid="file-tree-loading">
        加载中
      </div>
    );
  }

  return (
    <div data-testid="file-tree" style={{ overflow: 'auto', height: '100%', padding: 8 }}>
      <FileTreeNode
        node={root}
        expanded={expanded}
        onToggle={(path) => {
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          });
        }}
      />
    </div>
  );
}

function FileTreeNode({
  node,
  expanded,
  onToggle,
}: {
  node: FileNode;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isDir = node.kind === 'directory';
  const open = isDir && expanded.has(node.path);
  const kids = open ? (node.children ?? []) : [];

  if (isDir) {
    return (
      <div>
        <button
          type="button"
          data-testid={`file-tree-dir-${node.path}`}
          onClick={() => onToggle(node.path)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            padding: '2px 4px',
            cursor: 'pointer',
          }}
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
          <Icon icon={Folder} size={14} />
          <span>{node.name}</span>
        </button>
        {kids.length > 0 ? (
          <div style={{ paddingLeft: 16 }}>
            {kids.map((child) => (
              <FileTreeNode key={child.path} node={child} expanded={expanded} onToggle={onToggle} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid={`file-tree-file-${node.path}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 2px 24px' }}
    >
      <Icon icon={File} size={14} />
      <span>{node.name}</span>
    </div>
  );
}
