import {readFileSync} from 'node:fs';
import {markdownLinks} from '../../../electron-agent/electron/agentData/knowledgeKernel/markdownLinks';
import {resolveWikiLink} from '../../../electron-agent/shared/wikiLinks';
const x=JSON.parse(readFileSync(new URL('./live-third-failure.json',import.meta.url),'utf8'));const item=x.items.find((i:any)=>i.item_id==='generate:overview');const p=JSON.parse(item.payload);const links=markdownLinks(p.markdown);const invalid=links.filter(l=>resolveWikiLink(l.url,'overview').kind==='invalid');console.log(JSON.stringify({total:links.length,invalid:invalid.map(l=>l.url),evidence:JSON.parse(item.evidence),sources:p.sources},null,2));
