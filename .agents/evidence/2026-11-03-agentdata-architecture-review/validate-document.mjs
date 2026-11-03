import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root=process.cwd();
const file=resolve(root,'.agents/notes/proposed/architecture/2026-11-03-agentdata-lightweight-decoupling-review.md');
const content=readFileSync(file,'utf8');
const failures=[];
const links=[...content.matchAll(/\]\(([^)]+)\)/g)].map(x=>x[1]).filter(x=>!/^https?:/.test(x));
for(const link of links) if(!existsSync(resolve(dirname(file),link.split('#')[0]))) failures.push(`Missing link: ${link}`);
const anchors=[...content.matchAll(/`((?:electron-agent|extensions|docs)\/[^`]+\.(?:ts|tsx|md))(?::([0-9]+)[^`]*)?`/g)];
for(const [,path,line] of anchors) {
  const source=resolve(root,path);
  if(!existsSync(source)) failures.push(`Missing source: ${path}`);
  else if(line && Number(line)>readFileSync(source,'utf8').split('\n').length) failures.push(`Line out of range: ${path}:${line}`);
}
const requireApp=createRequire(resolve(root,'electron-agent/package.json'));
const {JSDOM}=requireApp('jsdom');
const dom=new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window=dom.window; globalThis.document=dom.window.document;
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
const {default:mermaid}=await import(pathToFileURL(requireApp.resolve('mermaid')).href);
mermaid.initialize({startOnLoad:false,securityLevel:'strict'});
const diagrams=[...content.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)];
for(let i=0;i<diagrams.length;i++) { try { await mermaid.parse(diagrams[i][1]); } catch(e) { failures.push(`Mermaid ${i+1}: ${e.message}`); } }
const headings=['## Problem','## Proposal','## Alternatives considered','## Acceptance criteria','## Risks','## 验证'];
for(const h of headings) if(!content.includes(h)) failures.push(`Missing heading: ${h}`);
console.log(JSON.stringify({file,bytes:statSync(file).size,lines:content.split('\n').length,relativeLinks:links.length,sourceAnchors:anchors.length,mermaidDiagrams:diagrams.length,failures},null,2));
dom.window.close();
if(failures.length) process.exitCode=1;
