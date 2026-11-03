// The syntax repair implementation is vendored from jsonrepair v3.15.0 (ISC).
// See jsonrepair-3.15.0/LICENSE.md and INVENTORY.md for provenance.
export { jsonrepair as repairSyntax } from './jsonrepair-3.15.0/regular/jsonrepair.js';

/** Locate a complete object or array without completing a truncated candidate. */
export function scanJsonValue(text: string, start: number, maxDepth: number): { end: number | null; depthExceeded: boolean; unsupported: boolean } {
  const opening = text[start];
  const result = { end: null as number | null, depthExceeded: false, unsupported: false };
  if (opening !== '{' && opening !== '[') return result;
  const stack = [opening === '{' ? '}' : ']'];
  let quote: string | undefined;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const character = text[i];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (text.startsWith('...', i) || character === '…') result.unsupported = true;
    if (character === '{' || character === '[') {
      stack.push(character === '{' ? '}' : ']');
      if (stack.length > maxDepth) return { ...result, depthExceeded: true };
    } else if (character === '}' || character === ']') {
      if (stack.pop() !== character) return result;
      if (stack.length === 0) return { ...result, end: i + 1 };
    }
  }
  return result;
}
export function scanJsonEnd(text: string, start: number): number | null {
  return scanJsonValue(text, start, Number.POSITIVE_INFINITY).end;
}
