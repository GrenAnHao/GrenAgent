// Pure, unit-tested helpers split out of index.ts (no node / network deps), so the
// head+tail truncation preview and the llms.txt-response validation can be tested
// directly without pulling in the crawler or hitting the network.

// Keep a head and a tail slice (70/30) so the model sees both the intro and the
// conclusion / examples that often live at the end of a page.
export function headTailSlice(text: string, budget: number): { head: string; tail: string; omitted: number } {
  const headLen = Math.max(0, Math.floor(budget * 0.7));
  const tailLen = Math.max(0, budget - headLen);
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
  return { head, tail, omitted: text.length - head.length - tail.length };
}

// True when an llms.txt-style response is real text content: not empty, not served
// as text/html, and not an HTML document body (sites often answer a missing path
// with a 200 soft-404 HTML page, which we must reject).
export function isUsableLlmsBody(contentType: string, body: string): boolean {
  if (contentType.toLowerCase().includes("text/html")) return false;
  if (!body.trim()) return false;
  const head = body.slice(0, 256).toLowerCase().trimStart();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return false;
  return true;
}
