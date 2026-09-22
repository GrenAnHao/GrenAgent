/** 底部输入框的最小外部写入 / 发送接缝（编辑失败回填、回退入框、编辑后发送）。 */

export type PromptImage = { type: 'image'; mimeType: string; data: string };

type SetValue = (text: string) => void;
type SendFn = (text: string, images?: PromptImage[]) => void | Promise<void>;

let setValueFn: SetValue | null = null;
let sendFn: SendFn | null = null;

export function registerComposerSetValue(fn: SetValue | null): void {
  setValueFn = fn;
}

export function registerComposerSend(fn: SendFn | null): void {
  sendFn = fn;
}

export function setComposerValue(text: string): void {
  setValueFn?.(text);
}

export async function sendViaComposer(text: string, images?: PromptImage[]): Promise<void> {
  if (!sendFn) throw new Error('composer send is not registered');
  await sendFn(text, images);
}
