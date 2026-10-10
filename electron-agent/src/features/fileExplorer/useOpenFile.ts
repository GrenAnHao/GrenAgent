import { useCallback, useEffect, useRef, useState } from 'react';
import { files, type FilesChangedEvent } from '../../lib/files';
import { pathsEquivalent } from '../../lib/pathUtils';
import { baseName, detectLineSeparator, fileKindOf, parentDir, type LineSeparator } from './fileKinds';
import type { UnsavedChoice } from './unsavedChanges';

export type ViewMode = 'preview' | 'edit';

export interface TextFile {
  status: 'text';
  path: string;
  kind: 'markdown' | 'text';
  size: number;
  truncated: boolean;
  /** 磁盘上（最近一次读到或保存）的内容。 */
  original: string;
  content: string;
  /** 换文件、放弃修改、从磁盘重新载入时变；编辑器据此整份替换文档，其余时候它自己持有文档。 */
  docVersion: number;
  lineSeparator: LineSeparator;
  mode: ViewMode;
  /** 磁盘上的文件被别人改了 / 删了，而这边有未保存的修改。 */
  disk: 'same' | 'changed' | 'deleted';
  saving: boolean;
  saveError: string | null;
}

export type OpenFileState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'error'; path: string; message: string }
  | { status: 'image'; path: string; size: number; url: string }
  | { status: 'binary'; path: string; size: number }
  | TextFile;

export interface OpenFileApi {
  file: OpenFileState;
  dirty: boolean;
  open: (path: string) => Promise<void>;
  setContent: (content: string) => void;
  setMode: (mode: ViewMode) => void;
  toggleMode: () => void;
  save: () => Promise<boolean>;
  reloadFromDisk: () => Promise<void>;
  /** 磁盘变更提示里选「保留我的修改」：同一份磁盘内容不再提示，之后保存会覆盖它。 */
  keepLocal: () => void;
  onFilesChanged: (event: Pick<FilesChangedEvent, 'dirs' | 'paths'>) => void;
  /** 有未保存修改时问用户；可以继续（保存成功或放弃）返回 true。 */
  resolveUnsaved: () => Promise<boolean>;
  isDirty: () => boolean;
}

type Confirm = (fileName: string) => Promise<UnsavedChoice>;

function isDirtyState(file: OpenFileState): boolean {
  return file.status === 'text' && file.content !== file.original;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

let docVersionSeq = 0;

export function useOpenFile(workspace: string, confirm: Confirm): OpenFileApi {
  const [file, setFile] = useState<OpenFileState>({ status: 'idle' });
  const fileRef = useRef<OpenFileState>(file);
  const tokenRef = useRef(0);
  /** 用户选过「保留我的修改」时那份磁盘内容。 */
  const dismissedDiskRef = useRef<string | null>(null);
  /** 最近一次检测到、和本地不同的磁盘内容。 */
  const pendingDiskRef = useRef<string | null>(null);

  /** 同步更新 ref 和 state：异步回调里读到的总是最新状态。换掉图片时顺手回收 blob URL。 */
  const update = useCallback((fn: (cur: OpenFileState) => OpenFileState) => {
    const prev = fileRef.current;
    const next = fn(prev);
    if (next === prev) return;
    if (prev.status === 'image' && (next.status !== 'image' || next.url !== prev.url)) URL.revokeObjectURL(prev.url);
    fileRef.current = next;
    setFile(next);
  }, []);

  useEffect(
    () => () => {
      const cur = fileRef.current;
      if (cur.status === 'image') URL.revokeObjectURL(cur.url);
    },
    [],
  );

  const loadPath = useCallback(
    async (path: string): Promise<OpenFileState> => {
      const kind = fileKindOf(path);
      if (kind === 'image') {
        const bin = await files.readBinary(workspace, path);
        return { status: 'image', path, size: bin.size, url: URL.createObjectURL(base64ToBlob(bin.data, bin.mime_type)) };
      }
      const view = await files.readView(workspace, path);
      if (view.kind === 'binary') return { status: 'binary', path, size: view.size };
      return {
        status: 'text',
        path,
        kind,
        size: view.size,
        truncated: view.truncated,
        original: view.content,
        content: view.content,
        docVersion: ++docVersionSeq,
        lineSeparator: detectLineSeparator(view.content),
        mode: 'preview',
        disk: 'same',
        saving: false,
        saveError: null,
      };
    },
    [workspace],
  );

  const save = useCallback(async (): Promise<boolean> => {
    const cur = fileRef.current;
    if (cur.status !== 'text' || cur.truncated || cur.saving) return false;
    const { path, content } = cur;
    update((f) => (f.status === 'text' && f.path === path ? { ...f, saving: true, saveError: null } : f));
    try {
      await files.write(workspace, path, content);
      dismissedDiskRef.current = null;
      pendingDiskRef.current = null;
      update((f) =>
        f.status === 'text' && f.path === path ? { ...f, original: content, saving: false, disk: 'same' } : f,
      );
      return true;
    } catch (err) {
      update((f) => (f.status === 'text' && f.path === path ? { ...f, saving: false, saveError: errorText(err) } : f));
      return false;
    }
  }, [workspace, update]);

  const resolveUnsaved = useCallback(async (): Promise<boolean> => {
    const cur = fileRef.current;
    if (!isDirtyState(cur) || cur.status !== 'text') return true;
    const choice = await confirm(baseName(cur.path));
    if (choice === 'cancel') return false;
    if (choice === 'save') return save();
    update((f) => (f.status === 'text' ? { ...f, content: f.original, docVersion: ++docVersionSeq } : f));
    return true;
  }, [confirm, save, update]);

  const open = useCallback(
    async (path: string) => {
      const cur = fileRef.current;
      if ('path' in cur && cur.path === path && cur.status !== 'error') return;
      if (!(await resolveUnsaved())) return;
      const token = ++tokenRef.current;
      dismissedDiskRef.current = null;
      pendingDiskRef.current = null;
      update(() => ({ status: 'loading', path }));
      try {
        const next = await loadPath(path);
        if (token !== tokenRef.current) {
          if (next.status === 'image') URL.revokeObjectURL(next.url);
          return;
        }
        update(() => next);
      } catch (err) {
        if (token === tokenRef.current) update(() => ({ status: 'error', path, message: errorText(err) }));
      }
    },
    [loadPath, resolveUnsaved, update],
  );

  const setContent = useCallback(
    (content: string) => update((f) => (f.status === 'text' && f.content !== content ? { ...f, content } : f)),
    [update],
  );

  const setMode = useCallback(
    (mode: ViewMode) =>
      update((f) => (f.status === 'text' && f.mode !== mode && !(mode === 'edit' && f.truncated) ? { ...f, mode } : f)),
    [update],
  );

  const toggleMode = useCallback(() => {
    const cur = fileRef.current;
    if (cur.status === 'text') setMode(cur.mode === 'edit' ? 'preview' : 'edit');
  }, [setMode]);

  const reloadFromDisk = useCallback(async () => {
    const cur = fileRef.current;
    if (cur.status !== 'text') return;
    const view = await files.readView(workspace, cur.path);
    if (view.kind !== 'text') return;
    dismissedDiskRef.current = null;
    pendingDiskRef.current = null;
    update((f) =>
      f.status === 'text' && f.path === cur.path
        ? {
            ...f,
            original: view.content,
            content: view.content,
            size: view.size,
            truncated: view.truncated,
            lineSeparator: detectLineSeparator(view.content),
            docVersion: ++docVersionSeq,
            disk: 'same',
            mode: view.truncated ? 'preview' : f.mode,
          }
        : f,
    );
  }, [workspace, update]);

  const keepLocal = useCallback(() => {
    dismissedDiskRef.current = pendingDiskRef.current;
    update((f) => (f.status === 'text' && f.disk !== 'same' ? { ...f, disk: 'same' } : f));
  }, [update]);

  const checkText = useCallback(
    async (path: string) => {
      let view;
      try {
        view = await files.readView(workspace, path);
      } catch (err) {
        if (!/does not exist/i.test(errorText(err))) return;
        update((f) => (f.status === 'text' && f.path === path ? { ...f, disk: 'deleted' } : f));
        return;
      }
      if (view.kind !== 'text') return;
      const disk = view;
      // 读盘期间用户可能还在打字：按路径认文件，脏不脏以此刻的状态为准。
      update((f) => {
        if (f.status !== 'text' || f.path !== path) return f;
        if (disk.content === f.original) return f.disk === 'same' ? f : { ...f, disk: 'same' };
        if (disk.content === dismissedDiskRef.current) return f;
        if (isDirtyState(f)) {
          pendingDiskRef.current = disk.content;
          return f.disk === 'changed' ? f : { ...f, disk: 'changed' };
        }
        return {
          ...f,
          original: disk.content,
          content: disk.content,
          size: disk.size,
          truncated: disk.truncated,
          lineSeparator: detectLineSeparator(disk.content),
          docVersion: ++docVersionSeq,
          disk: 'same',
          mode: disk.truncated ? 'preview' : f.mode,
        };
      });
    },
    [workspace, update],
  );

  const onFilesChanged = useCallback(
    (event: Pick<FilesChangedEvent, 'dirs' | 'paths'>) => {
      const cur = fileRef.current;
      if (cur.status === 'idle' || cur.status === 'loading') return;
      const named = event.paths.some((p) => pathsEquivalent(p, cur.path));
      const parent = parentDir(cur.path);
      const inParent = event.dirs.some((d) => pathsEquivalent(d, parent));
      if (cur.status === 'text') {
        // 文本文件靠内容比对把关：自己刚保存、或别的文件变了触发的事件，内容一样就什么都不做。
        if (named || inParent) void checkText(cur.path);
        return;
      }
      if (!named) return;
      const token = tokenRef.current;
      loadPath(cur.path)
        .then((next) => {
          if (token !== tokenRef.current || fileRef.current.status === 'text') {
            if (next.status === 'image') URL.revokeObjectURL(next.url);
            return;
          }
          update(() => next);
        })
        .catch(() => {});
    },
    [checkText, loadPath, update],
  );

  const isDirty = useCallback(() => isDirtyState(fileRef.current), []);

  return {
    file,
    dirty: isDirtyState(file),
    open,
    setContent,
    setMode,
    toggleMode,
    save,
    reloadFromDisk,
    keepLocal,
    onFilesChanged,
    resolveUnsaved,
    isDirty,
  };
}
