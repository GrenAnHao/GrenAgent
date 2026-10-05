import { useEffect, useRef, useState, type RefObject } from 'react';
import { getCurrentWebview } from '../../../../platform/runtime';
import { INSERT_MENTION_COMMAND, type IEditor } from '@lobehub/editor';
import { $getSelection, $isRangeSelection } from 'lexical';
import { files } from '../../../../lib/files';
import { binaryToImageAttachment } from './imageAttachment';
import { fileMentionMeta } from './mention';
import { countLines, isLongPaste, makeFileReference, makePastedText } from './pastedText';
import { loadFiles } from './useFileMention';
import type { ImageAttachment } from '../ChatInputContext';
import type { PastedText } from './types';

/** 当前拖放的内容类型——用于输入区提示文案。 */
export type DragKind = 'file' | 'text' | 'image';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);

// 可读成文本块的扩展名（白名单）；其余二进制/未知类型回退为 `@` 引用。
const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'txt', 'text', 'log', 'csv', 'tsv',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'rs', 'py', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'rb', 'php', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'sql', 'vue', 'svelte', 'astro', 'swift', 'dart', 'scala', 'r', 'jl',
  'gradle', 'properties', 'dockerfile', 'makefile', 'gitignore', 'editorconfig',
]);

// 读文本统计行数的体积上限（base64 长度，约对应 3MB 原文件）：超过就不解码，直接回退 `@` 引用。
const MAX_TEXT_B64 = 4_000_000;

interface Options {
  editor: IEditor;
  workspace: string;
  zoneRef: RefObject<HTMLElement | null>;
  onImages: (items: ImageAttachment[]) => void;
  /** 拖入的文本文件暂存为引用 chip（发送时写成 `@path`）；长文本拖拽也走这里（发送时展开）。 */
  onPastedText: (text: PastedText) => void;
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot >= 0 ? p.slice(dot + 1).toLowerCase() : '';
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

function isTextFile(path: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (/^application\/(json|xml|javascript|x-yaml|yaml|x-sh|toml|x-toml)/.test(mime)) return true;
  return TEXT_EXT.has(extOf(path)) || TEXT_EXT.has(baseName(path).toLowerCase());
}

function decodeText(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function imageNameFromSrc(src: string): string {
  const dataMime = /^data:(image\/[a-z0-9.+-]+)/i.exec(src)?.[1];
  if (dataMime) return `image.${dataMime.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`;
  if (!src.startsWith('blob:')) {
    const base = src.split(/[?#]/)[0].split('/').pop();
    if (base && base.includes('.')) return decodeURIComponent(base);
  }
  return 'image.png';
}

/** 从 dragstart 的目标里找出被拖的图片元素（兼容 antd Image 的遮罩 / 包裹容器场景）。 */
function pickDraggedImage(target: EventTarget | null): { src: string; name: string } | null {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return null;
  const img =
    el instanceof HTMLImageElement
      ? el
      : ((el.closest?.('img') as HTMLImageElement | null) ??
        (el.querySelector?.('img') as HTMLImageElement | null) ??
        (el.closest?.('.ant-image')?.querySelector('img') as HTMLImageElement | null) ??
        null);
  const src = img?.currentSrc || img?.src || '';
  if (!src) return null;
  return { src, name: img?.alt?.trim() || imageNameFromSrc(src) };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 监听 Electron preload 转发的拖放事件，文件以绝对路径传入。
 * 落在输入区内才处理：图片读成附件；文本文件不论大小都只发路径，chip 上显示文件名和行数，
 * 发送时写成 `@path`（区内用相对路径，区外先复制到 `.pi/dropped/`）；目录 / 二进制 / 读失败回退为 `@` 引用 pill。
 * 应用内拖拽（从消息里拖选区文本 / 拖图片）也在此处理：dragstart 截存内容，drop 时插入。
 */
export function useTauriFileDrop({ editor, workspace, zoneRef, onImages, onPastedText }: Options) {
  const [dragOver, setDragOver] = useState(false);
  const [dragKind, setDragKind] = useState<DragKind>('file');
  // dragstart 暂存应用内选区，外部应用拖入的文本则由 preload 从 DataTransfer 读取。
  const dragTextRef = useRef('');
  // 应用内拖拽的图片（消息里的生成图等）：dragstart 截存其 src，drop 落在输入区且无文件路径时转成附件。
  const dragImageRef = useRef<{ src: string; name: string } | null>(null);
  const dragFromEditorRef = useRef(false);

  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const root = editor.getLexicalEditor()?.getRootElement();
      dragFromEditorRef.current = e.target instanceof Node && Boolean(root?.contains(e.target));
      const image = pickDraggedImage(e.target);
      if (image) {
        // 拖的是图片（如消息里的生成图）：优先按图片处理，忽略遗留选区。
        dragImageRef.current = image;
        dragTextRef.current = '';
      } else {
        dragImageRef.current = null;
        dragTextRef.current = window.getSelection()?.toString() ?? '';
      }
    };
    // preload 同步转发 drop；dragend 到来时已处理完，可直接清除取消拖放留下的内容。
    const onDragEnd = () => {
      dragTextRef.current = '';
      dragImageRef.current = null;
      dragFromEditorRef.current = false;
    };
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('dragend', onDragEnd, true);
    return () => {
      document.removeEventListener('dragstart', onDragStart, true);
      document.removeEventListener('dragend', onDragEnd, true);
    };
  }, [editor]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    const isOver = (pos: { x: number; y: number } | undefined): boolean => {
      const el = zoneRef.current;
      if (!el || !pos) return false;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    // 应用内拖入的纯文本：长文本走「粘贴文本」chip（与粘贴一致，避免上下文爆炸），短文本插入光标处。
    const insertDroppedText = (text: string) => {
      if (isLongPaste(text)) {
        onPastedText(makePastedText(text));
        return;
      }
      editor.focus();
      editor.getLexicalEditor()?.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(text);
      });
    };

    // 应用内拖入的图片（消息里的生成图等）：data URL 直接解析，blob/asset URL 用 fetch 取字节，转成附件。
    const insertDroppedImage = async (image: { src: string; name: string }) => {
      try {
        const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(image.src);
        if (dataUrl) {
          onImages([binaryToImageAttachment(image.name, dataUrl[1], dataUrl[2])]);
          return;
        }
        const blob = await (await fetch(image.src)).blob();
        onImages([binaryToImageAttachment(image.name, blob.type || 'image/png', await blobToBase64(blob))]);
      } catch {
        /* 读取失败：忽略 */
      }
    };

    const insertMention = (rel: string | null, normPath: string, name: string, isDirectory: boolean) => {
      editor.focus();
      editor.dispatchCommand(INSERT_MENTION_COMMAND, {
        label: name,
        metadata: fileMentionMeta(rel ?? normPath, name, isDirectory),
      });
      editor.getLexicalEditor()?.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText(' ');
      });
    };

    const handleDrop = async (paths: string[]) => {
      // 先把本次拖入的绝对路径登记到白名单，工作区外文件随后才能被 readDropped 安全读取。
      await files.registerDroppedFiles(paths).catch(() => {});

      let root = '';
      let flat: { path: string; isDirectory: boolean }[] = [];
      try {
        const entry = await loadFiles(workspace);
        root = entry.root;
        flat = entry.files;
      } catch {
        /* best effort */
      }

      const images: ImageAttachment[] = [];

      for (const abs of paths) {
        const normPath = abs.replace(/\\/g, '/');
        const rel = root && normPath.startsWith(`${root}/`) ? normPath.slice(root.length + 1) : null;
        const indexed = rel ? flat.find((f) => f.path === rel) : undefined;
        const isDirectory = indexed?.isDirectory ?? false;
        const name = baseName(normPath);

        // 文件（含工作区外）：读一次 binary（区内走相对路径、区外走拖放白名单），按类型分流：
        // 图片→附件，文本→引用 chip（只发路径，不把内容拼进消息），其余/失败→ @ 引用。
        if (!isDirectory) {
          try {
            const bin = rel
              ? await files.readBinary(workspace, rel)
              : await files.readDropped(normPath);
            if (IMAGE_EXT.has(extOf(normPath)) || bin.mime_type.startsWith('image/')) {
              images.push(binaryToImageAttachment(name, bin.mime_type, bin.data));
              continue;
            }
            if (bin.data.length <= MAX_TEXT_B64 && isTextFile(normPath, bin.mime_type)) {
              // 拖入文件是让 agent 去读这个文件，不是把全文塞进这条消息：一律只发路径。
              // 内容只用来在 chip 上显示行数。
              const content = decodeText(bin.data);
              const refPath = rel ?? (await files.importDropped(workspace, normPath).catch(() => null));
              if (refPath) {
                onPastedText(makeFileReference(refPath, { lines: countLines(content), chars: content.length }));
                continue;
              }
            }
            // 二进制 / 解码失败 / 区外复制失败：回退为编辑器内 @ 引用 pill。
            if (rel) {
              insertMention(rel, normPath, name, false);
              continue;
            }
            const importedRel = await files.importDropped(workspace, normPath);
            insertMention(importedRel, normPath, name, false);
            continue;
          } catch {
            /* 读 / 复制失败：回退为 @ 引用 */
          }
        }

        // 目录 / 读失败 → 回退为 @ 引用 pill。
        insertMention(rel, normPath, name, isDirectory);
      }

      if (images.length > 0) onImages(images);
    };

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!active) return false;
        const payload = event.payload;
        if (payload.type === 'over') {
          const hasFiles = payload.types?.includes('Files');
          const hasText = dragTextRef.current || payload.types?.includes('text/plain');
          const hasImage = dragImageRef.current;
          const supported = hasFiles || hasText || hasImage || !payload.types;
          const over = !dragFromEditorRef.current && Boolean(supported) && isOver(payload.position);
          setDragOver(over);
          if (over) setDragKind(hasFiles ? 'file' : hasImage ? 'image' : hasText ? 'text' : 'file');
          return over;
        }
        if (payload.type === 'leave') {
          setDragOver(false);
          return;
        }
        if (payload.type === 'drop') {
          const over = isOver(payload.position);
          setDragOver(false);
          const image = dragImageRef.current;
          const text = dragTextRef.current || (image ? '' : payload.text ?? '');
          const fromEditor = dragFromEditorRef.current;
          dragTextRef.current = '';
          dragImageRef.current = null;
          dragFromEditorRef.current = false;
          // 输入框内部的文字移动由编辑器按落点处理，不能当作外部内容再插入。
          if (!over || fromEditor) return false;
          // 应用内拖拽：有选区文本插文本，有图片插图片；否则按文件拖放（含原生文件）处理。
          if (payload.paths.length === 0) {
            if (text) insertDroppedText(text);
            else if (image) void insertDroppedImage(image);
            return Boolean(text || image);
          }
          void handleDrop(payload.paths);
          return true;
        }
      })
      .then((u) => {
        if (active) unlisten = u;
        else u();
      })
      .catch(() => {});

    return () => {
      active = false;
      unlisten?.();
    };
  }, [editor, workspace, zoneRef, onImages, onPastedText]);

  return { dragOver, dragKind };
}
