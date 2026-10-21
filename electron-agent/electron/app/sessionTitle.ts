import { readFile } from 'node:fs/promises';
import { firstUserMessage, titleModelInput } from '../../../extensions/_shared/session-title.js';
import { chainSummaryTitle, cleanGeneratedTitle, TITLE_MAX_TOKENS, titleLocale } from '../../../extensions/auto-title/title.js';

export interface TitleCall {
  user: string;
  systemPrompt: string;
  maxTokens: number;
  /** 不给就用默认会话模型。 */
  provider?: string;
  modelId?: string;
}

export interface SessionTitleOptions {
  complete: (input: TitleCall) => Promise<string>;
  /** 设置里的标题模型（provider/id），没配返回空。 */
  titleModel: () => string | undefined;
  readFile?: (path: string) => Promise<string>;
}

interface ModelRef {
  provider: string;
  modelId: string;
}

function parseLines(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const entry = JSON.parse(line) as unknown;
      return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** 会话里最后一条助手消息用的模型：没配标题模型时用它，和 auto-title 退回当前对话模型一致。 */
function sessionModel(entries: Array<Record<string, unknown>>): ModelRef | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].message as { role?: unknown; provider?: unknown; model?: unknown } | undefined;
    if (entries[i].type !== 'message' || message?.role !== 'assistant') continue;
    if (typeof message.provider === 'string' && typeof message.model === 'string' && message.provider && message.model) {
      return { provider: message.provider, modelId: message.model };
    }
  }
  return undefined;
}

function parseSpec(spec: string | undefined): ModelRef | undefined {
  const trimmed = spec?.trim() ?? '';
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/**
 * 「重新生成标题」：按会话文件里的第一条用户消息重新起名，和 auto-title 用同一套输入整理、提示词和清洗。
 * 模型依次试：设置里的标题模型 → 会话最后用的模型 → 默认会话模型。都没给出能用的标题时返回空串；
 * 全部报错时抛出最后一个错误，调用方提示给用户。
 * 见 .agents/notes/implemented/feature/2026-10-19-session-title-quality.md
 */
export async function generateSessionTitle(sessionPath: string, options: SessionTitleOptions): Promise<string> {
  const raw = await (options.readFile ?? ((path: string) => readFile(path, 'utf8')))(sessionPath);
  const entries = parseLines(raw);
  const first = firstUserMessage(entries);
  if (!first) return '';
  const input = titleModelInput(first.text, first.images);
  if (!input) return '';
  const prompt = chainSummaryTitle(input, titleLocale());

  const candidates: Array<ModelRef | undefined> = [];
  const seen = new Set<string>();
  for (const model of [parseSpec(options.titleModel()), sessionModel(entries), undefined]) {
    const key = model ? `${model.provider}/${model.modelId}` : '';
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(model);
  }

  let lastError: unknown;
  let answered = false;
  for (const model of candidates) {
    try {
      const output = await options.complete({
        user: prompt.user,
        systemPrompt: prompt.system,
        maxTokens: TITLE_MAX_TOKENS,
        ...(model ? { provider: model.provider, modelId: model.modelId } : {}),
      });
      answered = true;
      const title = cleanGeneratedTitle(output);
      if (title) return title;
    } catch (error) {
      lastError = error;
    }
  }
  if (!answered && lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  return '';
}
