import { extensionUiRespond, type ExtensionUiRequest } from '../../../lib/pi';
import type { ChatMessage } from '../../../stores/agentReducer';
import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';
import { isApprovalSelect } from './PromptRequestCard';

export type UiPromptReceipt = {
  outcome: 'answered' | 'confirmed' | 'cancelled';
  title: string;
  value?: string;
};

export function shouldRenderUiPromptInOverlay(request: ExtensionUiRequest): boolean {
  if (request.source === 'permission') return false;
  if (request.method === 'confirm' || request.method === 'input') return true;
  if (request.method === 'select') return !isApprovalSelect(request.options);
  return false;
}

export function parseUiPromptReceipt(raw: string): UiPromptReceipt | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.title !== 'string') return null;
    if (parsed.outcome === 'cancelled') {
      return { outcome: 'cancelled', title: parsed.title };
    }
    if (
      (parsed.outcome === 'answered' || parsed.outcome === 'confirmed') &&
      typeof parsed.value === 'string'
    ) {
      return { outcome: parsed.outcome, title: parsed.title, value: parsed.value };
    }
    return null;
  } catch {
    return null;
  }
}

export function appendUiPromptReceipt(
  setState: (fn: (s: { messages: ChatMessage[] }) => { messages: ChatMessage[] }) => void,
  receipt: UiPromptReceipt,
): void {
  setState((s) => ({
    messages: [
      ...s.messages,
      {
        kind: 'notice',
        id: `local-${crypto.randomUUID()}`,
        customType: 'ui-prompt-receipt',
        content: JSON.stringify(receipt),
      },
    ],
  }));
}

export async function cancelPendingOverlay(
  workspace: string,
): Promise<'idle' | 'cancelled' | 'failed'> {
  const inline = useInlineQuestionStore.getState().byWorkspace[workspace];
  if (inline) {
    try {
      await extensionUiRespond(workspace, {
        type: 'extension_ui_response',
        id: inline.id,
        cancelled: true,
      });
      useInlineQuestionStore.getState().clear(workspace, inline.id);
      return 'cancelled';
    } catch {
      return 'failed';
    }
  }

  const uiPrompt = useUiPromptStore.getState().byWorkspace[workspace];
  if (!uiPrompt || !shouldRenderUiPromptInOverlay(uiPrompt.request)) {
    return 'idle';
  }

  const { id, method } = uiPrompt.request;
  const response =
    method === 'confirm'
      ? { type: 'extension_ui_response' as const, id, confirmed: false }
      : { type: 'extension_ui_response' as const, id, cancelled: true };

  try {
    await extensionUiRespond(workspace, response);
    useUiPromptStore.getState().clear(workspace, id);
    return 'cancelled';
  } catch {
    return 'failed';
  }
}
