import { readFile, rm, writeFile } from 'node:fs/promises';

export interface AskUserDraft {
  toolCallId: string;
  selected: Record<string, string[]>;
  customTexts: Record<string, string>;
  extraText: string;
  extraImages: Array<{ type: 'image'; mimeType: string; data: string }>;
}

export function askUserDraftPath(sessionFile: string): string {
  return `${sessionFile}.ask-user-draft.json`;
}

export async function readAskUserDraft(sessionFile: string, toolCallId: string): Promise<AskUserDraft | null> {
  try {
    const parsed = JSON.parse(await readFile(askUserDraftPath(sessionFile), 'utf8')) as Partial<AskUserDraft>;
    if (!parsed || parsed.toolCallId !== toolCallId) return null;
    if (!parsed.selected || typeof parsed.selected !== 'object') return null;
    return {
      toolCallId,
      selected: parsed.selected,
      customTexts: parsed.customTexts && typeof parsed.customTexts === 'object' ? parsed.customTexts : {},
      extraText: typeof parsed.extraText === 'string' ? parsed.extraText : '',
      extraImages: Array.isArray(parsed.extraImages) ? parsed.extraImages.filter((img) => img && img.type === 'image' && typeof img.mimeType === 'string' && typeof img.data === 'string') : [],
    };
  } catch {
    return null;
  }
}

export async function writeAskUserDraft(sessionFile: string, draft: AskUserDraft): Promise<void> {
  await writeFile(askUserDraftPath(sessionFile), JSON.stringify(draft));
}

export async function deleteAskUserDraft(sessionFile: string): Promise<void> {
  await rm(askUserDraftPath(sessionFile), { force: true });
}
