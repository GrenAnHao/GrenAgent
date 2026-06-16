export interface SessionInfoLike {
  id: string;
  modified?: Date | string | number;
  firstMessage?: string;
  allMessagesText?: string;
}

export interface SessionHit {
  id: string;
  modified: string;
  score: number;
  snippet: string;
}

function makeSnippet(text: string, lower: string, term: string, n: number): string {
  const i = lower.indexOf(term);
  if (i < 0) return text.slice(0, n).replace(/\s+/g, " ").trim();
  const start = Math.max(0, i - Math.floor(n / 4));
  return (start > 0 ? "…" : "") + text.slice(start, start + n).replace(/\s+/g, " ").trim();
}

/** Rank sessions by keyword occurrence count in their full text; return topK with snippets. */
export function rankSessions(
  infos: SessionInfoLike[],
  query: string,
  topK: number,
  snippetChars: number,
): SessionHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = infos
    .map((info) => {
      const text = info.allMessagesText ?? info.firstMessage ?? "";
      const lower = text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = lower.indexOf(t);
        while (idx >= 0) {
          score++;
          idx = lower.indexOf(t, idx + t.length);
        }
      }
      return { info, text, lower, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => ({
    id: s.info.id,
    modified: s.info.modified ? new Date(s.info.modified).toISOString() : "",
    score: s.score,
    snippet: makeSnippet(s.text, s.lower, terms[0], snippetChars),
  }));
}
