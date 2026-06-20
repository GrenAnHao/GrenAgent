import { createElement, useCallback, useEffect, useRef } from 'react';
import type { IEditor, ISlashMenuOption } from '@lobehub/editor';
import FileIcon from '../../../../components/FileIcon';
import { files } from '../../../../lib/files';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';
import { fileMentionMeta } from './mention';
import {
  filterFiles,
  flattenFileTree,
  workspaceRootPath,
  type FlatFile,
} from './fileTree';
import type { LocalFileMentionMeta } from './types';

interface FileTreeEntry {
  files: FlatFile[];
  root: string;
  expiresAt: number;
}

const TTL_MS = 15_000;
const cache = new Map<string, FileTreeEntry>();
const inflight = new Map<string, Promise<FileTreeEntry>>();

/** 加载并缓存工作区文件树（提及搜索与拖拽落点换算共用）。 */
export async function loadFiles(workspace: string): Promise<FileTreeEntry> {
  const now = Date.now();
  const cached = cache.get(workspace);
  if (cached && cached.expiresAt > now) return cached;

  const existing = inflight.get(workspace);
  if (existing) return existing;

  const req = files
    .getTree(workspace, false)
    .then((tree) => {
      const entry: FileTreeEntry = {
        files: flattenFileTree(tree),
        root: workspaceRootPath(tree),
        expiresAt: Date.now() + TTL_MS,
      };
      cache.set(workspace, entry);
      return entry;
    })
    .finally(() => {
      inflight.delete(workspace);
    });

  inflight.set(workspace, req);
  return req;
}

/** 路径过长会把菜单撑宽，保留尾部（更有信息量的文件名/末级目录）。 */
function clampPath(path: string): string {
  return path.length > 44 ? `…${path.slice(path.length - 43)}` : path;
}

type MentionSearch = {
  leadOffset: number;
  matchingString: string;
  replaceableString: string;
} | null;

export function useFileMention(workspace: string) {
  const filesRef = useRef<FlatFile[]>([]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void loadFiles(workspace)
      .then((entry) => {
        if (!cancelled) filesRef.current = entry.files;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const mentionItems = useCallback(
    async (search: MentionSearch): Promise<ISlashMenuOption[]> => {
      if (filesRef.current.length === 0 && workspace) {
        try {
          filesRef.current = (await loadFiles(workspace)).files;
        } catch {
          /* keep empty */
        }
      }
      return filterFiles(filesRef.current, search?.matchingString ?? '', 50).map((f) => ({
        key: f.path,
        label: f.name,
        extra: clampPath(f.path),
        icon: createElement(FileIcon, {
          fileName: f.name,
          isDirectory: f.isDirectory,
          size: 16,
          variant: 'raw',
        }),
        metadata: fileMentionMeta(f.path, f.name, f.isDirectory),
      }));
    },
    [workspace],
  );

  const onSelect = useCallback((editor: IEditor, option: ISlashMenuOption) => {
    const meta = option.metadata as LocalFileMentionMeta;
    editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, {
      category: meta.isDirectory ? 'directory' : 'file',
      label: meta.name,
      value: meta.path,
    });
  }, []);

  return { mentionItems, onSelect };
}
