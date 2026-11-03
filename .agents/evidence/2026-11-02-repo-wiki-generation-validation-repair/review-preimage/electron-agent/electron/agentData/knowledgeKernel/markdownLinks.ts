import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, Definition, Link } from 'mdast';

type Node = Root | RootContent;
export interface MarkdownLink { url: string; start?: number; end?: number; linkStart?:number; linkEnd?:number; text?:string }
const parser=unified().use(remarkParse).use(remarkGfm);
/** Only destinations rendered as anchors; definitions count when referenced, never inside code or images. */
export function markdownLinks(markdown:string):MarkdownLink[]{
 const tree=parser.parse(markdown),definitions=new Map<string,Definition>();
 const walk=(node:Node,visit:(node:Node)=>void)=>{visit(node);if('children' in node)for(const child of node.children)walk(child as Node,visit);};
 walk(tree,node=>{if(node.type==='definition'&&!definitions.has(node.identifier))definitions.set(node.identifier,node);});
 const links:MarkdownLink[]=[];
 walk(tree,node=>{const target=node.type==='link'?node:node.type==='linkReference'?definitions.get(node.identifier):undefined;if(!target)return;const ref=node.type==='linkReference'?node:undefined;const text='children' in node?node.children.map(child=>child.type==='text'||child.type==='inlineCode'?child.value:'children' in child?child.children.map(item=>item.type==='text'||item.type==='inlineCode'?item.value:'').join(''):'').join(''):'';links.push({url:target.url,...destination(markdown,target),...(node.position?.start.offset!==undefined&&node.position.end.offset!==undefined?{linkStart:node.position.start.offset,linkEnd:node.position.end.offset,text}:{}),...(ref?{}:{})});});
 return links;
}
function destination(markdown:string,node:Link|Definition):{start?:number;end?:number}{
 const start=node.position?.start.offset,end=node.position?.end.offset;if(start===undefined||end===undefined)return {};
 const text=markdown.slice(start,end);let offset:number;
 if(node.type==='definition'){const marker=text.indexOf(']:');if(marker<0)return {};offset=marker+2;}
 else if(text.startsWith('<')&&text.endsWith('>'))return {start:start+1,end:end-1};
 else {const childEnd=node.children.at(-1)?.position?.end.offset??start;const marker=markdown.indexOf('](',childEnd);if(marker<0||marker>=end)return {};offset=marker-start+2;}
 while(/\s/.test(text[offset]??'')&&offset<text.length)offset++;
 if(text[offset]==='<'){const close=text.indexOf('>',offset+1);return close<0?{}:{start:start+offset+1,end:start+close};}
 const from=offset;let depth=0;
 while(offset<text.length){const char=text[offset];if(char==='\\'){offset+=2;continue;}if(char==='(')depth++;if(char===')'){if(!depth)break;depth--;}if(/\s/.test(char))break;offset++;}
 return {start:start+from,end:start+offset};
}
export function replaceMarkdownLinks(markdown:string,replacements:Array<MarkdownLink & {url:string}>,removed:MarkdownLink[]=[]):string{
 const edits:Array<{start:number;end:number;text:string}>=[];for(const item of replacements)if(item.start!==undefined&&item.end!==undefined)edits.push({start:item.start,end:item.end,text:item.url});for(const item of removed)if(item.linkStart!==undefined&&item.linkEnd!==undefined)edits.push({start:item.linkStart,end:item.linkEnd,text:item.text??''});
 for(const edit of edits.sort((a,b)=>b.start-a.start))markdown=markdown.slice(0,edit.start)+edit.text+markdown.slice(edit.end);
 return markdown;
}
