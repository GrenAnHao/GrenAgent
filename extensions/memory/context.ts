export function buildMemoryContext(items: Array<{ level: number; content: string }>, maxChars = 6000): string | undefined {
  const lines = items.map((item) => `- [L${item.level}] ${item.content.trim()}`).filter(Boolean);
  if (!lines.length) return undefined;
  return `## Relevant memory\n${lines.join('\n')}`.slice(0, maxChars);
}
