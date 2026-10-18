import { extensionUiRespond } from '../../lib/pi';
import { useVisualStore, type VisualEntry } from '../../stores/visualStore';

export interface VisualChoiceMessage {
  /** 选中的 data-choice，多选用逗号连接；页面没有选项是 'confirm'；选项可选且没选时是空串。 */
  choice: string;
  text: string;
  /** 用户在「补充」里写的说明，可选。 */
  supplement?: string;
}

/**
 * 把确认结果回写给发起这次视觉设计的会话。
 * 工作区、请求 id 都取自 entry（发起会话登记的），不取「当前画面上的会话」：
 * 用户切到别的会话或别的项目后再点确认，回包仍然落在原来的会话上。
 */
export function submitVisualChoice(entry: VisualEntry, message: VisualChoiceMessage): boolean {
  if (!entry.pending || !entry.requestId) return false;
  const supplement = message.supplement?.trim();
  const value = JSON.stringify({
    choice: message.choice,
    text: message.text,
    ...(supplement ? { supplement } : {}),
    timestamp: Date.now(),
  });
  useVisualStore.getState().markSubmitted(entry.rev);
  useVisualStore.getState().setPending(entry, false);
  void Promise.resolve(
    extensionUiRespond(entry.workspace, { type: 'extension_ui_response', id: entry.requestId, value }),
  ).catch((error: unknown) => console.error('[visual] extension_ui_respond failed:', error));
  return true;
}

/** iframe 里 postMessage 过来的确认消息；格式不对返回 null。选项可选，choice 允许空串。 */
export function parseVisualChoiceMessage(data: unknown): VisualChoiceMessage | null {
  if (!data || typeof data !== 'object') return null;
  const msg = data as { type?: unknown; choice?: unknown; text?: unknown; supplement?: unknown };
  if (msg.type !== 'visual-choice' || typeof msg.choice !== 'string') return null;
  const text = typeof msg.text === 'string' ? msg.text : msg.choice;
  return {
    choice: msg.choice,
    text,
    ...(typeof msg.supplement === 'string' && msg.supplement.trim() ? { supplement: msg.supplement } : {}),
  };
}
