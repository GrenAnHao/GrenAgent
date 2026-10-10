import { Button, Input, Tree, type TreeDataNode, type TreeProps } from 'antd';
import { Search } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import FileIcon from '../../components/FileIcon';
import { fileExplorerStyles as styles } from './fileExplorerStyles';
import { buildTree, searchTree, type TreeNode } from './treeModel';
import { useElementSize } from './useElementSize';
import type { FileTreeState } from './useFileTree';

/** 条目太多只列了一部分的目录，末尾挂一个不可选的提示节点。 */
const TRUNCATED_KEY_SUFFIX = '\u0000truncated';

function highlight(name: string, needle: string): ReactNode {
  if (!needle) return name;
  const at = name.toLowerCase().indexOf(needle);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <span className={styles.match}>{name.slice(at, at + needle.length)}</span>
      {name.slice(at + needle.length)}
    </>
  );
}

function truncatedNode(dir: string): TreeDataNode {
  return {
    key: `${dir}${TRUNCATED_KEY_SUFFIX}`,
    title: <span className={styles.truncatedNode}>条目太多，只列出前 5000 个</span>,
    isLeaf: true,
    selectable: false,
    disabled: true,
  };
}

function toDataNodes(nodes: TreeNode[], dir: string, truncatedDirs: ReadonlySet<string>, needle: string): TreeDataNode[] {
  const out: TreeDataNode[] = nodes.map((node) => ({
    key: node.key,
    title: highlight(node.entry.name, needle),
    isLeaf: node.isLeaf,
    icon: <FileIcon fileName={node.entry.name} isDirectory={node.entry.isDir} size={16} />,
    ...(node.children ? { children: toDataNodes(node.children, node.key, truncatedDirs, needle) } : {}),
  }));
  if (truncatedDirs.has(dir)) out.push(truncatedNode(dir));
  return out;
}

export interface FileTreeProps {
  tree: FileTreeState;
  selectedPath: string | null;
  onOpen: (path: string) => void;
}

/** 文件树：只渲染可视区（virtual）；展开目录时才列那一层；筛选只在已加载的节点里找。 */
export function FileTree({ tree, selectedPath, onOpen }: FileTreeProps) {
  const [query, setQuery] = useState('');
  const needle = useDeferredValue(query).trim().toLowerCase();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { height } = useElementSize(bodyRef);

  const search = useMemo(() => (tree.root ? searchTree(tree.root, tree.dirs, needle) : null), [tree.root, tree.dirs, needle]);
  const [searchExpanded, setSearchExpanded] = useState<string[]>([]);
  useEffect(() => {
    setSearchExpanded(search ? [...search.expand] : []);
  }, [search]);

  const treeData = useMemo(
    () => (tree.root ? toDataNodes(buildTree(tree.root, tree.dirs, search?.visible), tree.root, tree.truncatedDirs, search ? needle : '') : []),
    [tree.root, tree.dirs, tree.truncatedDirs, search, needle],
  );
  const loadedKeys = useMemo(() => [...tree.dirs.keys()], [tree.dirs]);

  const loadData: TreeProps['loadData'] = async (node) => {
    try {
      await tree.loadDir(String(node.key));
    } catch {
      // 列不出来（刚被删、没权限）：保持未加载，下次展开再试。
    }
  };

  if (tree.error) {
    return (
      <div className={styles.center} data-testid="file-tree-error">
        <span>无法列出工作区文件：{tree.error}</span>
        <Button size="small" onClick={tree.reload}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.treeSearch}>
        <Input
          data-testid="file-tree-search"
          size="small"
          allowClear
          variant="filled"
          prefix={<Search size={14} />}
          placeholder="筛选已展开的文件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {search && search.matches === 0 ? <div className={styles.treeHint}>已展开的目录里没有匹配的文件</div> : null}
      <div ref={bodyRef} className={styles.treeBody} data-testid="file-tree">
        {tree.root ? (
          <Tree.DirectoryTree
            blockNode
            showIcon
            virtual={height > 0}
            height={height > 0 ? height : undefined}
            treeData={treeData}
            loadData={loadData}
            loadedKeys={loadedKeys}
            expandedKeys={search ? searchExpanded : tree.expanded}
            onExpand={(keys) => (search ? setSearchExpanded(keys.map(String)) : tree.setExpanded(keys.map(String)))}
            selectedKeys={selectedPath ? [selectedPath] : []}
            onSelect={(_keys, info) => {
              if (info.node.isLeaf && !String(info.node.key).endsWith(TRUNCATED_KEY_SUFFIX)) onOpen(String(info.node.key));
            }}
          />
        ) : (
          <div className={styles.treeHint} data-testid="file-tree-loading">
            加载中…
          </div>
        )}
      </div>
    </>
  );
}
