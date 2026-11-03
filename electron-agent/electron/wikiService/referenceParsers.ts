import { parse as parseYaml } from 'yaml';
import { REFERENCE_PROFILE } from './referenceProfiles.js';
import { repairSyntax, scanJsonValue, scanJsonEnd } from './reference/qoder-0.5.1/jsonRepair.js';
import { referenceWikiEntries, type ReferenceSection } from './reference/qoder-0.5.1/wikiTools.js';
export type { ReferenceSection } from './reference/qoder-0.5.1/wikiTools.js';
export type ReferenceResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface ReferenceCatalogueNode { title: string; name: string; dependent_file: string[]; prompt: string; has_children: string; children: ReferenceCatalogueNode[]; children_plan: string }
const fail = (error: string): ReferenceResult<never> => ({ ok: false, error });
const bytes = (s: string) => new TextEncoder().encode(s).length;
function tag(text: string, name: string): string | null { const open = `<${name}>`, close = `</${name}>`, a = text.indexOf(open), b = text.lastIndexOf(close); return a < 0 || b < a + open.length ? null : text.slice(a + open.length, b).trim(); }
export function parseReferenceOverview(text: string): ReferenceResult<string> { return !text.trim() ? fail('generated_empty_content') : bytes(text.trim()) < REFERENCE_PROFILE.minContentBytes.overview ? fail('generated_insufficient_content') : { ok: true, value: text }; }
export function parseReferencePlan(text: string): ReferenceResult<string> { const value = tag(text, 'analysis'); return value === null ? fail('could not find <analysis> tag in response') : { ok: true, value }; }
export function parseReferenceCommitAnalysis(text: string): string { return tag(text, 'commit_summary') ?? text.trim(); }
function node(value: unknown): ReferenceResult<ReferenceCatalogueNode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid section shape: expected object');
  const v = value as Record<string, unknown>, result: ReferenceCatalogueNode = { title: '', name: '', dependent_file: [], prompt: '', has_children: '', children: [], children_plan: '' };
  for (const key of ['title', 'name', 'prompt', 'has_children', 'children_plan'] as const) { if (v[key] !== undefined && typeof v[key] !== 'string') return fail('invalid section shape: expected string'); result[key] = (v[key] as string | undefined) ?? ''; }
  if (v.dependent_file !== undefined && (!Array.isArray(v.dependent_file) || v.dependent_file.some(x => typeof x !== 'string'))) return fail('invalid section shape: expected string array');
  result.dependent_file = (v.dependent_file as string[] | undefined) ?? [];
  if (v.children !== undefined && !Array.isArray(v.children)) return fail('invalid section shape: expected array');
  for (const item of (v.children as unknown[] | undefined) ?? []) { const child = node(item); if (!child.ok) return child; result.children.push(child.value); }
  return { ok: true, value: result };
}
function validate(items: ReferenceCatalogueNode[], parent = 'root'): ReferenceResult<true> {
  const names = new Set<string>();
  for (const item of items) {
    if (!item.title.trim()) return fail(`section missing title (name=${item.name})`);
    if (!item.name.trim()) return fail(`section missing name (title=${item.title})`);
    if (!item.prompt.trim()) return fail(`section missing prompt (name=${item.name})`);
    if (names.has(item.name)) return fail(`duplicate sibling section name (parent=${parent}, name=${item.name})`);
    names.add(item.name); const checked = validate(item.children, `${parent}/${item.name}`); if (!checked.ok) return checked;
  }
  return { ok: true, value: true };
}
/** Ed: repair only a complete bounded JSON value; never complete truncated output. */
function repairJson(raw: string): string {
  try { JSON.parse(raw); return raw; } catch { /* try bounded repair */ }
  if (bytes(raw) > 256 * 1024) throw new SyntaxError('model_json_input_limit');
  const trimmed = raw.trim(), scan = scanJsonValue(trimmed, 0, 64);
  if (scan.depthExceeded) throw new SyntaxError('model_json_depth_limit');
  if (scan.end !== trimmed.length) throw new SyntaxError('model_json_incomplete');
  if (scan.unsupported) throw new SyntaxError('model_json_unsupported');
  let repaired: string;
  try { repaired = repairSyntax(raw); JSON.parse(repaired); } catch { throw new SyntaxError('model_json_repair_failed'); }
  if (bytes(repaired) > 256 * 1024) throw new SyntaxError('model_json_output_limit');
  return repaired;
}
/** lTe: last balanced candidate immediately followed by the closing tag wins. */
function taggedJson(text: string): string {
  const open = '<documentation_structure>', close = '</documentation_structure>';
  let index = 0, valid = '', invalid = '';
  while (index < text.length) {
    const start = text.indexOf(open, index); if (start < 0) break;
    const contentStart = start + open.length; let found = false;
    for (let at = contentStart; at < text.length; at++) {
      if (text[at] !== '{' && text[at] !== '[') continue;
      const end = scanJsonEnd(text, at) as number | null; if (end === null) break;
      let after = end; while (/\s/u.test(text[after] ?? '')) after++;
      if (text.startsWith(close, after)) {
        const candidate = text.slice(at, end);
        try { JSON.parse(candidate); valid = candidate; invalid = ''; } catch { invalid = candidate; }
        index = after + close.length; found = true; break;
      }
      at = end - 1;
    }
    if (!found) index = contentStart;
  }
  if (invalid) { try { return repairJson(invalid); } catch { /* fall back to last valid candidate */ } }
  return valid;
}
/**
 * The reference prompt asks for JSON, but a real model sometimes answers with the same data as
 * YAML (usually inside a ```yaml fence) or with equivalent scalar shapes: `dependent_file` as a
 * single path, `children_plan` as a list, `has_children` as a boolean. Those carry the same
 * information, so normalize them instead of failing the whole stage. Nothing is invented: a
 * section still needs its own title, name and prompt, and the sibling-name rules still apply.
 */
function normalizeSections(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const v = item as Record<string, unknown>, out: Record<string, unknown> = { ...v };
    if (typeof out.dependent_file === 'string') out.dependent_file = out.dependent_file.trim() ? [out.dependent_file.trim()] : [];
    if (Array.isArray(out.children_plan)) out.children_plan = (out.children_plan as unknown[]).filter(x => typeof x === 'string').join('\n');
    else if (out.children_plan === undefined || out.children_plan === null) out.children_plan = '';
    else if (typeof out.children_plan !== 'string') out.children_plan = String(out.children_plan);
    if (typeof out.has_children === 'boolean') out.has_children = out.has_children ? 'YES' : 'NO';
    else if (typeof out.has_children === 'string') out.has_children = /^\s*(?:yes|true)\s*$/i.test(out.has_children) ? 'YES' : /^\s*(?:no|false)\s*$/i.test(out.has_children) ? 'NO' : out.has_children;
    if (Array.isArray(out.children)) out.children = normalizeSections(out.children) ?? out.children;
    return out;
  });
}
/** A complete YAML document inside the tag or a ```yaml fence; truncated input must not parse as a short catalogue. */
function parseYamlCatalogue(text: string): { items: unknown[]; rawJson: string } | undefined {
  if (bytes(text) > 256 * 1024) return undefined;
  const tagged = tag(text, 'documentation_structure');
  const fenced = /```ya?ml\s*\n([\s\S]*?)\n```/iu.exec(text)?.[1];
  for (const candidate of [tagged, fenced]) {
    if (!candidate) continue;
    const body = candidate.replace(/^\s*```(?:ya?ml)?\s*\n?/iu, '').replace(/\n?```\s*$/u, '').trim();
    if (!body) continue;
    let data: unknown;
    // Duplicate keys stay an error: a YAML document that defines the same field twice is ambiguous,
    // and failing it triggers the normal retry instead of silently keeping one of the values.
    try { data = parseYaml(body, { maxAliasCount: 100 }); } catch { continue; }
    const items = normalizeSections(Array.isArray(data) ? data : (data && typeof data === 'object' ? (data as { items?: unknown }).items : undefined));
    if (!items || !items.length) continue;
    return { items, rawJson: JSON.stringify(items) };
  }
  return undefined;
}
export function parseReferenceCatalogue(text: string): ReferenceResult<{ items: ReferenceCatalogueNode[]; rawJson: string }> {
  if (bytes(text.trim()) < REFERENCE_PROFILE.minContentBytes.catalogue) return fail('generated_insufficient_content');
  // Two accepted serializations of the same document: JSON (the requested shape, including
  // inside a ```json fence) and YAML. A malformed JSON candidate is reported with its own error
  // rather than silently degrading into a YAML attempt, so truncation stays visible.
  let items: unknown[] | undefined, rawJson = '';
  let raw = taggedJson(text) || text.match(/```json\s*\n([\s\S]*?)\n```/)?.[1]?.trim() || '';
  if (raw) {
    let data: unknown;
    try { raw = repairJson(raw); data = JSON.parse(raw); }
    catch (error) { return fail(`failed to parse JSON structure: ${String(error).slice(0, 200)}`); }
    items = normalizeSections(Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items);
    if (!items) return fail('failed to parse JSON structure: no items array');
    rawJson = raw;
  } else {
    const yaml = parseYamlCatalogue(text);
    if (!yaml) return fail(text.includes('<documentation_structure>') ? 'no valid JSON found in documentation_structure tag' : 'could not find documentation structure in response');
    items = yaml.items; rawJson = yaml.rawJson;
  }
  const parsed: ReferenceCatalogueNode[] = [];
  for (const item of items) { const result = node(item); if (!result.ok) return result; parsed.push(result.value); }
  const checked = validate(parsed); return checked.ok ? { ok: true, value: { items: parsed, rawJson } } : checked;
}
export function parseReferencePage(text: string, title: string, finalAttempt = false, purpose: 'full' | 'update' | 'add' = 'full'): ReferenceResult<string> {
  const trimmed = text.trim();
  if (!trimmed) return fail('generated_empty_content');
  if (purpose !== 'add' && bytes(trimmed) < REFERENCE_PROFILE.minContentBytes.page) return fail('generated_insufficient_content');
  if (purpose === 'full' && !finalAttempt && text.split('<cite>').length > text.split('</cite>').length && text.includes('<cite>')) return fail('cite_tag_unclosed');
  const content = tag(text, 'docs') ?? tag(text, 'content');
  if (content !== null) return content ? { ok: true, value: content } : fail('generated_empty_document_body');
  const normalize = (s: string) => s.replace(/\s+/gu, ' ').trim();
  const lines = text.split('\n'), index = lines.findIndex(line => { const match = /^#\s+(.+?)\s*$/u.exec(line); return match && normalize(match[1]) === normalize(title); });
  if (index < 0) return fail('document_heading_missing');
  let body = lines.slice(index).join('\n').trim(); for (const close of ['</docs>', '</content>']) { const at = body.indexOf(close); if (at !== -1) body = body.slice(0, at); }
  body = body.trim(); return body.split('\n').slice(1).join('\n').trim() ? { ok: true, value: body } : fail('generated_empty_document_body');
}

export interface ReferenceIncrementalPlan {
  update: Array<{ section: ReferenceSection; changeReason: string }>;
  add: Array<{ proposalId: string; section: ReferenceSection; changeReason: string }>;
  delete: Array<{ sectionId: string; changeReason: string }>;
}
type Operation = { action: 'update' | 'delete'; target_ref: string; change_reason: string; dependent_file: string[] } | { action: 'add'; name: string; slug: string; parent_ref?: string; change_reason: string; dependent_file: string[] };
function parseOperations(raw: unknown): ReferenceResult<Operation[]> {
  if (!Array.isArray(raw)) return fail('documentation_structure is not an array');
  const result: Operation[] = [];
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`invalid documentation operation at ${index}: expected object`);
    const v = value as Record<string, unknown>, action = v.action;
    if (action !== 'update' && action !== 'add' && action !== 'delete') return fail(`invalid documentation operation at ${index}.action: invalid discriminator`);
    const fields = action === 'add' ? ['action', 'name', 'slug', 'parent_ref', 'change_reason', 'dependent_file'] : action === 'update' ? ['action', 'target_ref', 'change_reason', 'dependent_file'] : ['action', 'target_ref', 'change_reason'];
    if (Object.keys(v).some(key => !fields.includes(key))) return fail(`invalid documentation operation at ${index}: unrecognized key`);
    const ref = (value: unknown) => typeof value === 'string' && /^W\d{3,}$/u.test(value);
    if (action !== 'add' && !ref(v.target_ref)) return fail(`invalid documentation operation at ${index}.target_ref: must be a Wiki reference such as W001`);
    if (action === 'add' && v.parent_ref !== undefined && !ref(v.parent_ref)) return fail(`invalid documentation operation at ${index}.parent_ref: must be a Wiki reference such as W001`);
    if (action === 'add' && (typeof v.name !== 'string' || !v.name.trim() || typeof v.slug !== 'string' || !v.slug.trim())) return fail(`invalid documentation operation at ${index}: name and slug must be non-empty`);
    if (v.change_reason !== undefined && typeof v.change_reason !== 'string') return fail(`invalid documentation operation at ${index}.change_reason: expected string`);
    if (action !== 'delete' && v.dependent_file !== undefined && (!Array.isArray(v.dependent_file) || v.dependent_file.some(item => typeof item !== 'string' || !item.trim()))) return fail(`invalid documentation operation at ${index}.dependent_file: expected non-empty strings`);
    const change_reason = ((v.change_reason as string | undefined) ?? '').trim();
    const dependent_file = ((v.dependent_file as string[] | undefined) ?? []).map(item => item.trim());
    if (action === 'add') result.push({ action, name: (v.name as string).trim(), slug: (v.slug as string).trim(), ...(v.parent_ref === undefined ? {} : { parent_ref: v.parent_ref as string }), change_reason, dependent_file });
    else result.push({ action, target_ref: v.target_ref as string, change_reason, dependent_file });
  }
  return { ok: true, value: result };
}
export function parseReferenceIncrementalCatalogue(text: string, priorSections: readonly ReferenceSection[], idFactory: () => string, finalAttempt = false): ReferenceResult<ReferenceIncrementalPlan> {
  const raw = taggedJson(text);
  if (!raw) {
    const content = tag(text, 'documentation_structure');
    if (content === null) return fail('no documentation_structure tag found');
    try { JSON.parse(content); } catch (error) { return fail(`documentation_structure JSON parse error: ${String(error).slice(0, 200)}`); }
    return fail('no documentation_structure tag found');
  }
  let data: unknown; try { data = JSON.parse(raw); } catch (error) { return fail(`documentation_structure JSON parse error: ${String(error).slice(0, 200)}`); }
  const parsed = parseOperations(data); if (!parsed.ok) return parsed;
  if (!parsed.value.length && !finalAttempt) return fail('No documentation operations were proposed. Recheck the changed code before returning [].');
  const refs = new Map(referenceWikiEntries(priorSections).map(entry => [entry.ref, entry.sectionId]));
  const sections = new Map(priorSections.map(section => [section.id, section]));
  const updates = new Map<string, { section: ReferenceSection; changeReason: string }>();
  const deletes = new Map<string, { sectionId: string; changeReason: string }>();
  const adds = new Map<string, { proposalId: string; parentId: string; name: string; slug: string; changeReason: string; dependentFiles: string[] }>();
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  for (const op of parsed.value) {
    if (op.action === 'add') {
      const parentId = op.parent_ref ? refs.get(op.parent_ref) : '';
      if (parentId === undefined) return fail(`unknown parent_ref: ${op.parent_ref}`);
      const key = `${parentId}\0${op.slug}`, previous = adds.get(key);
      if (previous) { if (previous.name !== op.name) return fail(`add slug has conflicting names: ${op.slug}`); previous.dependentFiles = union(previous.dependentFiles, op.dependent_file); }
      else adds.set(key, { proposalId: op.slug, parentId, name: op.name, slug: op.slug, changeReason: op.change_reason, dependentFiles: op.dependent_file });
      continue;
    }
    const id = refs.get(op.target_ref); if (id === undefined) return fail(`unknown target_ref: ${op.target_ref}`);
    const section = sections.get(id); if (!section) return fail(`missing section for target_ref: ${op.target_ref}`);
    if (op.action === 'delete') { if (!deletes.has(id)) deletes.set(id, { sectionId: id, changeReason: op.change_reason || 'Removed due to history divergence' }); }
    else { const previous = updates.get(id); if (previous) previous.section.dependentFiles = union(previous.section.dependentFiles, op.dependent_file); else updates.set(id, { section: { ...section, dependentFiles: union(section.dependentFiles, op.dependent_file) }, changeReason: op.change_reason }); }
  }
  const removed = new Set(deletes.keys()); let changed = true;
  while (changed) { changed = false; for (const item of priorSections) if (removed.has(item.parentId) && !removed.has(item.id)) { removed.add(item.id); changed = true; } }
  for (const id of updates.keys()) if (removed.has(id)) return fail(`section cannot be both updated and deleted: ${id}`);
  for (const add of adds.values()) if (add.parentId && removed.has(add.parentId)) return fail(`cannot add section under deleted parent: ${add.parentId}`);
  const names = new Set(priorSections.filter(section => !removed.has(section.id)).map(section => `${section.parentId}\0${section.sectionName}`));
  for (const add of adds.values()) { const key = `${add.parentId}\0${add.name}`; if (names.has(key)) return fail(`duplicate sibling section name: ${add.name}`); names.add(key); }
  const nextOrdinal = new Map<string, number>(); for (const section of priorSections) nextOrdinal.set(section.parentId, Math.max(nextOrdinal.get(section.parentId) ?? 0, section.ordinal + 1));
  const ids = new Set(priorSections.map(section => section.id)), result: ReferenceIncrementalPlan['add'] = [];
  for (const add of adds.values()) { const id = idFactory(); if (ids.has(id)) return fail(`id factory produced duplicate section id: ${id}`); ids.add(id); const ordinal = nextOrdinal.get(add.parentId) ?? 0; nextOrdinal.set(add.parentId, ordinal + 1); result.push({ proposalId: add.proposalId, section: { id, parentId: add.parentId, ordinal, sectionName: add.name, title: add.slug, prompt: '', dependentFiles: add.dependentFiles, meta: {} }, changeReason: add.changeReason }); }
  return { ok: true, value: { update: [...updates.values()], add: result, delete: [...deletes.values()] } };
}
