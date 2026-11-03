import { describe, expect, it } from 'vitest';
import { catalogueChildVariables, referenceCatalogueRetryInstruction, renderReferenceExecution } from './referencePrompts.js';
import { parseReferenceCatalogue, parseReferencePage, parseReferencePlan } from './referenceParsers.js';
import { REFERENCE_PROFILE } from './referenceProfiles.js';

describe('fixed Qoder reference contract', () => {
  it('retains source fields and reports the child depth limit', () => {
    const child = catalogueChildVariables({ title: 'T', name: 'n', prompt: 'p', has_children: 'NO', dependent_file: ['a.ts'], children_plan: '', children: [] }, 'root/n', 2);
    expect(child.CatalogLevel).toBe(3); expect(child.LimitInstruction).toContain('too deeply nested'); expect(child.ParentCatalog).toContain('a.ts');
    const execution = renderReferenceExecution('wiki.full.catalogue', { ...child, CodeFiles: 'src/a.ts', AuthorNotes: [{ Text: 'Keep names', Author: 'A' }] }, { child: true, retryInstruction: referenceCatalogueRetryInstruction('bad', 'invalid') });
    expect(execution.prompt).toContain('root/n'); expect(execution.prompt).toContain('Recovery data:'); expect(execution.systemPrompt).toContain('ListDir');
  });
  it('preserves purpose formats and validates page headings without sources JSON', () => {
    expect(parseReferencePlan('<analysis>plan</analysis>')).toEqual({ ok: true, value: 'plan' });
    expect(parseReferencePage(`# Title\n${'text '.repeat(60)}`, 'Title').ok).toBe(true);
    expect(parseReferencePage(`# Title\n<cite>${'text '.repeat(60)}`, 'Title').ok).toBe(false);
    expect(parseReferencePage(`# Title\n<cite>${'text '.repeat(60)}`, 'Title', true).ok).toBe(true);
    const raw = JSON.stringify([{ title: 'Title', name: 'title', prompt: 'Explain', dependent_file: ['src/a.ts'], children: [] }]);
    expect(parseReferenceCatalogue(`<documentation_structure>${raw}</documentation_structure>${' '.repeat(300)}`).ok).toBe(false); // byte count is trimmed
    expect(parseReferenceCatalogue(`<documentation_structure>${raw}</documentation_structure>\n${'x'.repeat(300)}`).ok).toBe(true);
    expect(REFERENCE_PROFILE.contextWindow).toBe(150000);
  });
});

it('renders every purpose and catalogue branch against complete fixed-source golden text', async () => {
  const { readFileSync } = await import('node:fs');
  const fixtures = JSON.parse(readFileSync(new URL('./reference/qoder-0.5.1/render-fixtures.json', import.meta.url), 'utf8')) as { variables: Record<string, unknown>; cases: Array<{ purpose: import('./referencePrompts.js').ReferencePurpose; child: boolean; retryInstruction?: string; systemPrompt: string; prompt: string }> };
  for (const fixture of fixtures.cases) {
    expect(renderReferenceExecution(fixture.purpose, fixtures.variables, { child: fixture.child, retryInstruction: fixture.retryInstruction })).toEqual({ purpose: fixture.purpose, systemPrompt: fixture.systemPrompt, prompt: fixture.prompt });
  }
});
