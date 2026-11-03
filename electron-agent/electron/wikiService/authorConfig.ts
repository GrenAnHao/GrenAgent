export interface AuthorPage { id: string; title: string; prompt: string; template?: string; children: AuthorPage[] }
export interface AuthorConfig { mode: 'auto' | 'pages'; constraints: string[]; notes: Array<{ Text: string; Author?: string }>; pages: AuthorPage[] }
export function normalizeAuthorConfig(input: Record<string, unknown>): AuthorConfig {
  if (input.mode !== undefined && input.mode !== 'auto' && input.mode !== 'pages') throw new Error('INVALID_AUTHOR_MODE');
  const mode = input.mode === 'pages' ? 'pages' : 'auto';
  if (input.constraints !== undefined && typeof input.constraints !== 'string' && (!Array.isArray(input.constraints) || input.constraints.some(value => typeof value !== 'string'))) throw new Error('INVALID_AUTHOR_CONSTRAINTS');
  const constraints = Array.isArray(input.constraints) ? input.constraints as string[] : typeof input.constraints === 'string' ? [input.constraints] : [];
  if (input.notes !== undefined && !Array.isArray(input.notes)) throw new Error('INVALID_AUTHOR_NOTES');
  const notes = Array.isArray(input.notes) ? input.notes.flatMap(value => {
    if (typeof value === 'string') return [{ Text: value }];
    if (!value || typeof value !== 'object') throw new Error('INVALID_AUTHOR_NOTES');
    const note = value as Record<string, unknown>, text = note.Text ?? note.text, author = note.Author ?? note.author;
    if (typeof text !== 'string' || author !== undefined && typeof author !== 'string') throw new Error('INVALID_AUTHOR_NOTES');
    return [{ Text: text, ...(typeof author === 'string' && author ? { Author: author } : {}) }];
  }) : [];
  const ids = new Set<string>();
  function pages(value: unknown): AuthorPage[] {
    if (!Array.isArray(value)) throw new Error('INVALID_AUTHOR_PAGES');
    return value.map(item => {
      if (!item || typeof item !== 'object') throw new Error('INVALID_AUTHOR_PAGE');
      const p = item as Record<string, unknown>;
      if (typeof p.id !== 'string' || !p.id.trim() || ids.has(p.id) || typeof p.title !== 'string' || !p.title.trim() || typeof p.prompt !== 'string' || !p.prompt.trim()) throw new Error('INVALID_AUTHOR_PAGE');
      if (p.template !== undefined && typeof p.template !== 'string') throw new Error('INVALID_AUTHOR_PAGE');
      ids.add(p.id);
      return { id: p.id, title: p.title, prompt: p.prompt, ...(typeof p.template === 'string' ? { template: p.template } : {}), children: p.children === undefined ? [] : pages(p.children) };
    });
  }
  const result = mode === 'pages' ? pages(input.pages) : [];
  if (mode === 'pages' && !result.length) throw new Error('INVALID_AUTHOR_PAGES');
  return { mode, constraints, notes, pages: result };
}
