import { describe, it, expect } from 'vitest';
import { parseReferenceCatalogue, parseReferenceIncrementalCatalogue, parseReferencePage } from './referenceParsers.js';
import { referenceWikiEntries, referenceWikiTools, type ReferenceSection } from './reference/qoder-0.5.1/wikiTools.js';
const sections: ReferenceSection[] = [
  { id: 'a', parentId: '', ordinal: 0, sectionName: 'Alpha', title: 'alpha', prompt: 'alpha prompt', dependentFiles: ['a.ts'], meta: {} },
  { id: 'b', parentId: 'a', ordinal: 0, sectionName: 'Beta', title: 'beta', prompt: 'beta prompt', dependentFiles: [], meta: {} },
];
const wrap = (value: string) => `<documentation_structure>${value}</documentation_structure>`;
describe('reference catalogue', () => {
  it('chooses final balanced tag and repairs syntax without accepting truncation', () => {
    const first = JSON.stringify([{ title: 'Old', name: 'old', prompt: 'x' }]);
    const second = "[{title:'New', name:'new', prompt:'explain', dependent_file:['src/a.ts'],}]";
    const result = parseReferenceCatalogue(`${wrap(first)}\n${wrap(second)}\n${' '.repeat(300)}x`);
    expect(result.ok && result.value.items[0].name).toBe('new');
    expect(parseReferenceCatalogue(`${wrap(first.slice(0, -1))}\n${'x'.repeat(300)}`).ok).toBe(false);
  });
  it('keeps full/update/add distinct and allows citation closure only on final full attempt', () => {
    const text = `<docs><cite>${'x'.repeat(300)}</docs>`;
    expect(parseReferencePage(text, 'ignored', false, 'full').ok).toBe(false);
    expect(parseReferencePage(text, 'ignored', true, 'full').ok).toBe(true);
    expect(parseReferencePage('<docs>short</docs>', 'ignored', false, 'add').ok).toBe(true);
    expect(parseReferencePage('<docs>short</docs>', 'ignored', false, 'update').ok).toBe(false);
  });
  it('resolves references, merges update sources, and rejects operations below deleted parents', () => {
    expect(referenceWikiEntries(sections).map(x => x.ref)).toEqual(['W001', 'W002']);
    const input = wrap(JSON.stringify([{ action: 'update', target_ref: 'W001', dependent_file: ['b.ts'] }, { action: 'add', name: 'New', slug: 'new', parent_ref: 'W001', change_reason: 'new code' }]));
    const plan = parseReferenceIncrementalCatalogue(input, sections, () => 'new-id');
    expect(plan.ok && plan.value.update[0].section.dependentFiles).toEqual(['a.ts', 'b.ts']);
    expect(plan.ok && plan.value.add[0].section.parentId).toBe('a');
    const conflict = wrap(JSON.stringify([{ action: 'delete', target_ref: 'W001' }, { action: 'update', target_ref: 'W002' }]));
    expect(parseReferenceIncrementalCatalogue(conflict, sections, () => 'new-id')).toEqual({ ok: false, error: 'section cannot be both updated and deleted: b' });
    expect(parseReferenceIncrementalCatalogue(wrap('[]'), sections, () => 'x').ok).toBe(false);
    expect(parseReferenceIncrementalCatalogue(wrap('[]'), sections, () => 'x', true).ok).toBe(true);
  });
  it('accepts the same catalogue expressed as YAML or with equivalent scalar shapes', () => {
    // A real model answered the reference JSON request with YAML in a ```yaml fence and with
    // singular scalars; both carry the same sections and must not fail the stage.
    const yaml = `<documentation_structure>\n\n\`\`\`yaml\n- title: 包概览\n  name: overview\n  dependent_file: README.md\n  prompt: 说明这个包是什么。\n  children_plan:\n    - 包结构表\n    - 许可来源\n  has_children: true\n- title: 安装\n  name: install\n  dependent_file: install.mjs\n  prompt: 说明安装流程。\n  children_plan: 无需拆分。\n  has_children: false\n\`\`\`\n\n</documentation_structure>${' '.repeat(200)}`;
    const parsed = parseReferenceCatalogue(yaml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.items.map(item => [item.name, item.has_children, item.dependent_file])).toEqual([
      ['overview', 'YES', ['README.md']],
      ['install', 'NO', ['install.mjs']],
    ]);
    expect(parsed.value.items[0].children_plan).toBe('包结构表\n许可来源');
  });
  it('still rejects a truncated YAML catalogue instead of publishing a short tree', () => {
    // The closing fence never arrives: a complete document was not delivered.
    const truncated = `<documentation_structure>\n\`\`\`yaml\n- title: 包概览\n  name: overview\n  dependent_file: README.md\n  prompt: 说明这个包是什么。\n  children_plan:\n    - 包结构表\n    - 许可\n</documentation_structure>${' '.repeat(200)}`;
    expect(parseReferenceCatalogue(truncated).ok).toBe(false);
  });
  it('rejects YAML sections that are missing required identity fields', () => {
    // Padding must live inside the document: the parser trims surrounding whitespace before the
    // minimum-size check, so trailing spaces cannot be used to reach the real validation branch.
    const missing = `<documentation_structure>\n\`\`\`yaml\n- title: 只有标题\n  name: only-title\n  dependent_file: []\n  children_plan: 无需拆分，这里只是把文档补到最小长度以上，以便真正走到字段校验而不是长度提前失败；再多写一点中文以保证字节数超过目录最小长度限制。\n  has_children: false\n\`\`\`\n</documentation_structure>`;
    const parsed = parseReferenceCatalogue(missing);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toContain('section missing prompt');
  });
  it('parses the recorded real-model catalogue responses that used to fail the stage', () => {
    // Both files are verbatim model output from the failed operation
    // 0e480941-57e5-4d45-8035-593a0aad1ca7 (note-pocock-flow, zh). Attempt 1 answered YAML inside
    // a fence; attempt 2 answered JSON with scalar/list field shapes. They describe the same tree.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
    const yaml = parseReferenceCatalogue(read('catalogue-yaml-fence.txt'));
    const json = parseReferenceCatalogue(read('catalogue-scalar-shapes.txt'));
    expect(yaml.ok).toBe(true); expect(json.ok).toBe(true);
    if (!yaml.ok || !json.ok) return;
    expect(yaml.value.items.map(item => item.name)).toEqual(json.value.items.map(item => item.name));
    expect(yaml.value.items.length).toBe(8);
    for (const item of [...yaml.value.items, ...json.value.items]) {
      expect(item.title.trim()).not.toBe(''); expect(item.prompt.trim()).not.toBe('');
      expect(item.dependent_file.length).toBeGreaterThan(0);
      expect(['YES', 'NO']).toContain(item.has_children);
    }
  });
  it('only exposes references and content from the supplied snapshot', () => {    const [search, read] = referenceWikiTools(sections, [{ sectionId: 'a', content: 'Frozen Alpha content' }]);
    expect(search.execute({ query: 'alpha frozen' }).value.matches[0].ref).toBe('W001');
    expect(read.execute({ ref: 'W002' }).value).toEqual({ ref: 'W002', found: false });
    expect(read.execute({ ref: 'W001' }).value).toMatchObject({ found: true, content: 'Frozen Alpha content' });
  });
});

it('formats incremental catalogue as the reference tree rather than JSON', async () => {
  const { referenceCatalogueTree } = await import('./reference/qoder-0.5.1/wikiTools.js');
  expect(referenceCatalogueTree(sections)).toBe('└── [W001] Alpha\n    └── [W002] Beta');
  expect(referenceCatalogueTree([])).toBe('');
});
