import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [rootArg, language, taskId, frozenPagesArg] = process.argv.slice(2);
if (!rootArg || !language || !taskId) throw new Error('Usage: node verify-published-files.mjs <project-root> <language> <expected-task-id> [frozen-required-pages.json]');
const root = path.resolve(rootArg);
function fileSlug(value) {
  if (!value || value.split('/').some(x => !x || x === '.' || x === '..' || /[\\\\\x00-\x1f]/.test(x))) throw new Error('INVALID_SLUG');
  return value.split('/').map(x => /^[a-z0-9_-]+$/.test(x) && !x.startsWith('_rw_') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(x) ? x : `_rw_${Buffer.from(x).toString('hex')}`).join('/');
}
const dir = path.join(root, 'docs', 'repo-wiki', fileSlug(language));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const projectFile = path.join(dir, 'project.json');
const first = (await json(projectFile)).last_publication;
if (!first || first.version !== 1 || first.taskId !== taskId || !/^[a-f0-9]{24}$/.test(first.namespace) || !first.publicationId || !first.intentHash || !first.outputSetHash) throw new Error('PUBLICATION_RECEIPT_MISMATCH');
const ns = path.join(dir, 'namespaces', first.namespace);
const state = await json(path.join(ns, 'namespace.json'));
const baseline = state.snapshot?.kernelBaseline;
if (state.schema_version !== 1 || !baseline?.graph || !baseline.sourceSnapshot?.files || !Array.isArray(state.pages)) throw new Error('INVALID_NAMESPACE');
const expected = baseline.graph.nodes.filter(n => n.phase === 'generate').map(n => n.id.replace(/^generate:/, '')).sort();
if (new Set(expected).size !== expected.length) throw new Error('INVALID_REQUIRED_PAGE_SET');
if (frozenPagesArg) {
  const frozen = await json(path.resolve(frozenPagesArg));
  if (!Array.isArray(frozen) || !frozen.length || frozen.some(id => typeof id !== 'string' || !id) || new Set(frozen).size !== frozen.length || JSON.stringify([...frozen].sort()) !== JSON.stringify(expected)) throw new Error('INVALID_REQUIRED_PAGE_SET');
} else if (expected.length !== 16) throw new Error('INVALID_REQUIRED_PAGE_SET');
const actual = [];
async function inventory(base, sub='') { const out=[];for(const ent of await readdir(path.join(base,sub),{withFileTypes:true})){const rel=path.join(sub,ent.name);if(ent.isDirectory())out.push(...await inventory(base,rel));else if(ent.isFile()&&rel.endsWith('.md'))out.push(rel.split(path.sep).join('/'));else throw new Error('INVALID_PAGE_FILE');}return out; }
const files=await inventory(path.join(ns,'pages'));
for (const id of state.pages) {
  const file=fileSlug(id);const meta=await json(path.join(ns,'meta',`${file}.json`));if(meta.id!==id)throw new Error('PAGE_ID_MISMATCH');if(meta.status==='archived')continue;
  const markdown=await readFile(path.join(ns,'pages',`${file}.md`),'utf8');if(!markdown.trim()||!Array.isArray(meta.sources)||!meta.sources.length)throw new Error(`EMPTY_PAGE_OR_SOURCES:${id}`);
  for(const source of meta.sources){const p=source.path;if(typeof p!=='string'||!p||path.isAbsolute(p)||p.split(/[\\\\/]/).some(x=>x==='..'||x==='')||/^[a-z]:/i.test(p))throw new Error(`INVALID_SOURCE:${id}`);const frozen=baseline.sourceSnapshot.files[p];if(!frozen?.hash||baseline.sourceSnapshot.hashes?.[p]!==frozen.hash||!Number.isInteger(source.start_line)||!Number.isInteger(source.end_line)||source.start_line<1||source.end_line<source.start_line||source.end_line>frozen.lines)throw new Error(`INVALID_SOURCE:${id}`);const bytes=await readFile(path.join(root,...p.split('/')));if(createHash('sha256').update(bytes).digest('hex')!==frozen.hash)throw new Error(`SOURCE_CHANGED:${id}`);const text=bytes.toString('utf8');if(!text.split(/\r?\n/).slice(source.start_line-1,source.end_line).join('\n').trim())throw new Error(`EMPTY_SOURCE:${id}`);}
  const warnings=meta.inputManifest?.navigationWarnings??[];if(!Array.isArray(warnings)||warnings.some(w=>w.code!=='UNKNOWN_WIKI_LINK'||w.page!==id||typeof w.target!=='string'||/[?#\\\\\x00-\x1f]/.test(w.target)))throw new Error(`INVALID_WARNING:${id}`);
  actual.push({id,sources:meta.sources.length,warnings});
}
actual.sort((a,b)=>a.id.localeCompare(b.id));if(JSON.stringify(actual.map(p=>p.id).sort())!==JSON.stringify(expected))throw new Error('REQUIRED_PAGE_SET_MISMATCH');
const expectedFiles=state.pages.map(id=>`${fileSlug(id)}.md`).sort();if(JSON.stringify(files.sort())!==JSON.stringify(expectedFiles))throw new Error('MARKDOWN_INVENTORY_MISMATCH');
const last=(await json(projectFile)).last_publication;if(JSON.stringify(first)!==JSON.stringify(last))throw new Error('RECEIPT_CHANGED_DURING_READ');
console.log(JSON.stringify({taskId:first.taskId,namespace:first.namespace,requiredPages:expected.length,markdownFiles:files.length,pages:actual},null,2));
