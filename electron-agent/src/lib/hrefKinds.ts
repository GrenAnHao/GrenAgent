/**
 * 把 Markdown / HTML 里 `<a href>` 的原始写法分成四类。对话正文和文件预览共用这一份，
 * 各自再决定「路径」怎么落地（对话按会话工作区，文件预览按当前文件所在目录）。
 *
 * 只认 `getAttribute('href')` 的原文：`a.href` 会被浏览器按应用自己的地址补全，相对路径全错。
 */
export type HrefKind =
  | { kind: 'anchor'; id: string }
  | { kind: 'external'; url: string }
  /** path 已解码、统一正斜杠；rooted 表示以 `/` 或盘符开头。query 丢弃，hash 单独给。 */
  | { kind: 'path'; path: string; hash: string; rooted: boolean }
  | { kind: 'unsupported'; reason: string };

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function classifyHref(raw: string): HrefKind {
  const href = raw.trim();
  if (!href) return { kind: 'unsupported', reason: '链接是空的' };
  if (href.startsWith('#')) return { kind: 'anchor', id: safeDecode(href.slice(1)) };
  if (href.startsWith('//')) return externalOrUnsupported(`https:${href}`);

  const scheme = SCHEME.exec(href);
  let driveLetter = false;
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name.length === 1) {
      driveLetter = true;
    } else if (name === 'http' || name === 'https') {
      return externalOrUnsupported(href);
    } else if (name === 'file') {
      return { kind: 'unsupported', reason: '暂不支持 file: 链接' };
    } else {
      return { kind: 'unsupported', reason: `暂不支持 ${name}: 链接` };
    }
  }

  const hashAt = href.indexOf('#');
  const beforeHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? safeDecode(href.slice(hashAt + 1)) : '';
  const queryAt = beforeHash.indexOf('?');
  const pathPart = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const path = safeDecode(pathPart).replace(/\\/g, '/');
  if (!path) return { kind: 'unsupported', reason: '链接没有指向任何文件' };
  return { kind: 'path', path, hash, rooted: driveLetter || path.startsWith('/') };
}

function externalOrUnsupported(url: string): HrefKind {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return { kind: 'unsupported', reason: '网址缺少主机名' };
    return { kind: 'external', url: parsed.href };
  } catch {
    return { kind: 'unsupported', reason: '网址格式不正确' };
  }
}
