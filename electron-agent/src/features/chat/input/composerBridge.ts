/** 底部输入框的最小外部写入 / 发送接缝（编辑失败回填、回退入框、编辑后发送、撤回引导后回填、文件树「添加到对话」）。 */

import { pathsEquivalent } from '../../../lib/pathUtils';
import { relativeSegments } from '../../fileExplorer/treeModel';

export type PromptImage = { type: 'image'; mimeType: string; data: string };

/** 从文件管理器加进对话的一个文件或目录。 */
export interface ComposerFileRef {
  /** 绝对路径（文件树里的原样）。 */
  absolute: string;
  /** 相对文件管理器项目根的路径（`/` 连接）；不在根下时为 null。 */
  relative: string | null;
  /** 文件管理器标签的工作区（不是 realpath 后的根）。 */
  workspace: string;
  name: string;
  isDirectory: boolean;
}

type SetValue = (text: string) => void;
type SendFn = (text: string, images?: PromptImage[]) => void | Promise<void>;
type LoadFn = (text: string, images?: Array<{ mimeType: string; data: string }>) => void;
type InsertFileFn = (file: ComposerFileRef) => void;

let setValueFn: SetValue | null = null;
let sendFn: SendFn | null = null;
let loadFn: LoadFn | null = null;
let insertFileFn: InsertFileFn | null = null;

export function registerComposerSetValue(fn: SetValue | null): void {
  setValueFn = fn;
}

export function registerComposerSend(fn: SendFn | null): void {
  sendFn = fn;
}

export function registerComposerLoad(fn: LoadFn | null): void {
  loadFn = fn;
}

export function registerComposerInsertFile(fn: InsertFileFn | null): void {
  insertFileFn = fn;
}

export function setComposerValue(text: string): void {
  setValueFn?.(text);
}

/**
 * 把一条消息放回输入框等人工再发：输入框里已经有字时接在后面，不覆盖；图片放回待发附件。
 * 返回 false 表示输入框还没挂上（调用方可以提示或保底）。
 */
export function loadIntoComposer(text: string, images?: Array<{ mimeType: string; data: string }>): boolean {
  if (!loadFn) return false;
  loadFn(text, images);
  return true;
}

/** 在输入框光标处插入一个文件 / 目录标签（发出去是 `@路径`）。返回 false 表示输入框还没挂上。 */
export function addFileToComposer(file: ComposerFileRef): boolean {
  if (!insertFileFn) return false;
  insertFileFn(file);
  return true;
}

/**
 * 标签里写的路径，按输入框所在会话的工作区来写，agent 才能照着读：
 * 文件管理器和会话是同一个工作区就用相对路径；否则看文件在不在会话工作区下面，在就相对它；都不是就给绝对路径。
 */
export function composerFileTagValue(composerWorkspace: string, file: ComposerFileRef): string {
  if (file.relative && file.relative !== '.' && pathsEquivalent(composerWorkspace, file.workspace)) return file.relative;
  const segments = composerWorkspace ? relativeSegments(composerWorkspace, file.absolute) : null;
  return segments && segments.length > 0 ? segments.join('/') : file.absolute;
}

export async function sendViaComposer(text: string, images?: PromptImage[]): Promise<void> {
  if (!sendFn) throw new Error('composer send is not registered');
  await sendFn(text, images);
}
