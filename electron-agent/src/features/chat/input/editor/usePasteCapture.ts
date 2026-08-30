import { useEffect, type RefObject } from 'react';
import type { ImageAttachment } from '../ChatInputContext';
import { fileToImageAttachment } from './imageAttachment';
import { isLongPaste, makePastedText } from './pastedText';
import type { PastedText } from './types';

interface Options {
  targetRef: RefObject<HTMLElement | null>;
  onImages: (items: ImageAttachment[]) => void;
  onPastedText: (text: PastedText) => void;
  /** 短文本粘贴时尝试转成链接标签；返回 true 表示已处理，应阻止默认粘贴。 */
  onUrlText?: (text: string) => boolean;
  /** 短文本粘贴时尝试转成命令标签；返回 true 表示已处理，应阻止默认粘贴。 */
  onCommandText?: (text: string) => boolean;
}

/**
 * 捕获阶段拦截粘贴：图片转附件、超阈值长文本转「粘贴文本」chip、`/命令` 转命令标签。
 * 用 capture + stopPropagation 抢在 Lexical 的粘贴处理之前，其余短文本放行走编辑器默认粘贴。
 */
export function usePasteCapture({ targetRef, onImages, onPastedText, onUrlText, onCommandText }: Options) {
  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    const handler = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;

      const imageFiles = Array.from(dt.items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);

      if (imageFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void Promise.all(imageFiles.map(fileToImageAttachment)).then(onImages);
        return;
      }

      const text = dt.getData('text/plain');
      if (!text) return;

      if (isLongPaste(text)) {
        e.preventDefault();
        e.stopPropagation();
        onPastedText(makePastedText(text));
        return;
      }

      if (onUrlText?.(text)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (onCommandText?.(text)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    el.addEventListener('paste', handler, true);
    return () => el.removeEventListener('paste', handler, true);
  }, [targetRef, onImages, onPastedText, onUrlText, onCommandText]);
}
