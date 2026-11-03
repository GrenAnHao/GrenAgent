export interface ReferenceSection { id: string; parentId: string; ordinal: number; sectionName: string; title: string; prompt: string; dependentFiles: string[]; meta: Record<string, unknown> }
export interface ReferencePriorPage { sectionId: string; content: string }
export interface ReferenceWikiEntry { ref: string; sectionId: string; title: string; slug: string; breadcrumb: string }
/** Wnnn references are assigned to the frozen snapshot in depth-first ordinal/id order. */
export function referenceWikiEntries(sections: readonly ReferenceSection[]): ReferenceWikiEntry[] {
  const children = new Map<string, ReferenceSection[]>();
  for (const section of sections) { const bucket = children.get(section.parentId) ?? []; bucket.push(section); children.set(section.parentId, bucket); }
  for (const bucket of children.values()) bucket.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const out: ReferenceWikiEntry[] = [];
  const visit = (parent: string, breadcrumb: string) => { for (const section of children.get(parent) ?? []) { const path = breadcrumb ? `${breadcrumb} / ${section.sectionName}` : section.sectionName; out.push({ ref: `W${String(out.length + 1).padStart(3, '0')}`, sectionId: section.id, title: section.sectionName, slug: section.title, breadcrumb: path }); visit(section.id, path); } };
  visit('', ''); return out;
}
/** Pure descriptions and handlers: the host must bind these only to the confirmed run snapshot. */
export function referenceWikiTools(sections: readonly ReferenceSection[], pages: readonly ReferencePriorPage[]) {
  const entries = referenceWikiEntries(sections), contents = new Map(pages.map(page => [page.sectionId, page.content]));
  return [
    { name: 'SearchWiki' as const, description: 'Search published Wiki titles, paths, slugs, and content. Returns exact Wiki references.', access: 'read' as const,
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, description: 'Words to search for.' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } }, required: ['query'], additionalProperties: false },
      execute: ({ query, limit = 8 }: { query: string; limit?: number }) => { const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean); return { ok: true as const, value: { query, matches: entries.filter(entry => { const content = contents.get(entry.sectionId); return content !== undefined && terms.every(term => `${entry.title}\n${entry.slug}\n${entry.breadcrumb}\n${content}`.toLocaleLowerCase().includes(term)); }).slice(0, limit).map(entry => ({ ref: entry.ref, title: entry.title, path: entry.breadcrumb, snippet: contents.get(entry.sectionId)!.replace(/\s+/gu, ' ').slice(0, 500) })) } }; } },
    { name: 'ReadWiki' as const, description: 'Read one published Wiki page by the exact reference shown in the tree or SearchWiki.', access: 'read' as const,
      inputSchema: { type: 'object', properties: { ref: { type: 'string', minLength: 4, description: 'Exact Wiki reference such as W001.', ...(entries.length ? { enum: entries.map(entry => entry.ref) } : {}) } }, required: ['ref'], additionalProperties: false },
      execute: ({ ref }: { ref: string }) => { const entry = entries.find(item => item.ref === ref); const content = entry && contents.get(entry.sectionId); return { ok: true as const, value: !entry || content === undefined ? { ref, found: false as const } : { ref, found: true as const, title: entry.title, path: entry.breadcrumb, content } }; } },
  ] as const;
}
/** Bkt: exact tree display and run-scoped selectors for incremental catalogue analysis. */
export function referenceCatalogueTree(sections: readonly ReferenceSection[]): string {
  const entries = new Map(referenceWikiEntries(sections).map(entry => [entry.sectionId, entry]));
  const children = new Map<string, ReferenceSection[]>();
  for (const section of sections) { const group = children.get(section.parentId) ?? []; group.push(section); children.set(section.parentId, group); }
  for (const group of children.values()) group.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const lines: string[] = [];
  const visit = (parent: string, prefix: string) => {
    const group = children.get(parent) ?? [];
    group.forEach((section, index) => {
      const last = index === group.length - 1;
      const entry = entries.get(section.id);
      if (!entry) throw new Error(`catalogue reference is missing: ${section.id}`);
      lines.push(`${prefix}${last ? '└── ' : '├── '}[${entry.ref}] ${entry.title}`);
      visit(section.id, prefix + (last ? '    ' : '│   '));
    });
  };
  visit('', '');
  return lines.join('\n');
}
