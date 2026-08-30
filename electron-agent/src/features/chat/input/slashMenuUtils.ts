export interface SlashContext {
  query: string;
  /** Index of '/' in the full text */
  slashIndex: number;
  /** Cursor position (end of replaceable token) */
  replaceEnd: number;
}

/** Returns slash-menu context when the current line before `cursor` is `/` + optional query (no spaces). */
export function parseSlashContext(text: string, cursor: number): SlashContext | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const lineStart = text.lastIndexOf('\n', safeCursor - 1) + 1;
  const linePrefix = text.slice(lineStart, safeCursor);
  const match = linePrefix.match(/^\/([^\s]*)$/);
  if (!match) return null;

  return {
    query: match[1] ?? '',
    slashIndex: lineStart,
    replaceEnd: safeCursor,
  };
}

/** Removes the `/query` token described by `ctx` from `text`. */
export function stripSlashToken(text: string, ctx: SlashContext): string {
  return text.slice(0, ctx.slashIndex) + text.slice(ctx.replaceEnd);
}

/** Replaces the active slash token with `/commandName ` and moves the caret after the trailing space. */
export function insertCommandDraft(
  text: string,
  ctx: SlashContext,
  commandName: string,
): { text: string; cursor: number } {
  const commandText = `/${commandName}`;
  const beforeSlash = text.slice(0, ctx.slashIndex);
  const afterQuery = text.slice(ctx.replaceEnd);
  const newText = `${beforeSlash}${commandText} ${afterQuery}`;
  return { text: newText, cursor: beforeSlash.length + commandText.length + 1 };
}
