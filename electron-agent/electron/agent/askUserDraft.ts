import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

const pending = new Map<string, Promise<unknown>>();
function inDraftOrder<T>(sessionFile: string, operation: () => Promise<T>): Promise<T> {
  const path = resolve(sessionFile);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  pending.set(key, next);
  const settled = () => { if (pending.get(key) === next) pending.delete(key); };
  void next.then(settled, settled);
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseSelected(value: unknown): Record<string, string[]> | null {
  if (!isPlainObject(value)) return null;
  const selected: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!Array.isArray(entry) || entry.some((item) => typeof item !== 'string')) return null;
    selected[key] = entry;
  }
  return selected;
}

function parseCustomTexts(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const customTexts: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    customTexts[key] = entry;
  }
  return customTexts;
}

export async function readAskUserDraft(sessionFile: string, toolCallId: string): Promise<AskUserDraft | null> {
  return inDraftOrder(sessionFile, () => readDraft(sessionFile, toolCallId));
}

async function readDraft(sessionFile: string, toolCallId: string): Promise<AskUserDraft | null> {
  try {
    const parsed = JSON.parse(await readFile(askUserDraftPath(sessionFile), 'utf8')) as Partial<AskUserDraft>;
    if (!parsed || parsed.toolCallId !== toolCallId) return null;
    const selected = parseSelected(parsed.selected);
    if (!selected) return null;
    const customTexts = parseCustomTexts(parsed.customTexts);
    if (!customTexts) return null;
    return {
      toolCallId,
      selected,
      customTexts,
      extraText: typeof parsed.extraText === 'string' ? parsed.extraText : '',
      extraImages: Array.isArray(parsed.extraImages) ? parsed.extraImages.filter((img) => img && img.type === 'image' && typeof img.mimeType === 'string' && typeof img.data === 'string') : [],
    };
  } catch {
    return null;
  }
}

export async function writeAskUserDraft(sessionFile: string, draft: AskUserDraft): Promise<void> {
  await inDraftOrder(sessionFile, () => writeFile(askUserDraftPath(sessionFile), JSON.stringify(draft)));
}

export async function deleteAskUserDraft(sessionFile: string, toolCallId?: string): Promise<void> {
  await inDraftOrder(sessionFile, async () => {
    if (toolCallId && !await readDraft(sessionFile, toolCallId)) return;
    await rm(askUserDraftPath(sessionFile), { force: true });
  });
}
