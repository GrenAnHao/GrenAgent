/** 底部输入框的最小外部写入 / 发送接缝（编辑失败回填、回退入框、编辑后发送、撤回引导后回填）。 */

export type PromptImage = { type: 'image'; mimeType: string; data: string };

type SetValue = (text: string) => void;
type SendFn = (text: string, images?: PromptImage[]) => void | Promise<void>;
type LoadFn = (text: string, images?: Array<{ mimeType: string; data: string }>) => void;

let setValueFn: SetValue | null = null;
let sendFn: SendFn | null = null;
let loadFn: LoadFn | null = null;

export function registerComposerSetValue(fn: SetValue | null): void {
  setValueFn = fn;
}

export function registerComposerSend(fn: SendFn | null): void {
  sendFn = fn;
}

export function registerComposerLoad(fn: LoadFn | null): void {
  loadFn = fn;
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

export async function sendViaComposer(text: string, images?: PromptImage[]): Promise<void> {
  if (!sendFn) throw new Error('composer send is not registered');
  await sendFn(text, images);
}
