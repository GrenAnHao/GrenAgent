export type WikiLink =
  | { kind: 'page'; pageId: string; path: string; hash?: string }
  | { kind: 'source'; path: string; start?: number; end?: number }
  | { kind: 'anchor'; hash: string }
  | { kind: 'external'; url: string }
  | { kind: 'invalid' };

/** Shared by generated-content validation and the reader; source paths are repository-root relative. */
export function resolveWikiLink(href: string, currentPageId?: string): WikiLink {
  if (/^(?:https?:|mailto:)/i.test(href) || href.startsWith('//')) return {kind:'external',url:href};
  if (href.startsWith('#')) { try { return {kind:'anchor',hash:decodeURIComponent(href.slice(1))}; } catch { return {kind:'invalid'}; } }
  const explicitSource = href.startsWith('source:');
  const target = explicitSource ? href.slice(7) : href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) return {kind:'invalid'};
  const hashIndex=target.indexOf('#'), queryIndex=target.indexOf('?');
  const pathEnd=Math.min(...[hashIndex,queryIndex,target.length].filter(n=>n>=0));
  let path:string, hash:string|undefined;
  try { path=decodeURIComponent(target.slice(0,pathEnd));hash=hashIndex>=0?decodeURIComponent(target.slice(hashIndex+1)):undefined; } catch { return {kind:'invalid'}; }
  if (!path || /[\\\x00-\x1f\x7f]/.test(path) || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return {kind:'invalid'};
  const lines=hash?.match(/^L(\d+)(?:-L?(\d+))?$/);
  if (explicitSource || lines) {
    if(path.split('/').includes('..'))return {kind:'invalid'};
    return {kind:'source',path:path.replace(/^(?:\.\/)+/,''),...(lines?{start:Number(lines[1]),end:Number(lines[2]??lines[1])}:{})};
  }
  const parts=currentPageId?.split('/').slice(0,-1)??[];
  for(const part of path.split('/')){if(part==='.'||part==='')continue;if(part==='..'){if(!parts.length)return {kind:'invalid'};parts.pop();}else parts.push(part);}
  const pageId=parts.join('/').replace(/\.md$/,'');
  return pageId ? {kind:'page',pageId,path,...(hash!==undefined?{hash}:{})} : {kind:'invalid'};
}
