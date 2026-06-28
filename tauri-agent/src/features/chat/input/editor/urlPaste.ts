import type { ChatTagData } from './ChatTag/types';

const SINGLE_URL = /^https?:\/\/\S+$/;

/** 整条文本是否就是单个 http(s) URL（无内部空白）。 */
export function isSingleUrl(text: string): boolean {
  return SINGLE_URL.test(text.trim());
}

/**
 * chip 上展示的精简 URL：host（去 www）+ 路径。
 * 根路径只显示 host；单段显示 host/段；多段折叠为 host/.../末段。完整 URL 存 value。
 */
export function formatUrlLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim();
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return host;
  if (segs.length === 1) return `${host}/${segs[0]}`;
  return `${host}/.../${segs[segs.length - 1]}`;
}

/** 把粘贴文本解析成链接标签数据；非单条 URL 返回 null（由调用方放行默认粘贴）。 */
export function resolveUrlTag(text: string): ChatTagData | null {
  if (!isSingleUrl(text)) return null;
  const url = text.trim();
  return { category: 'link', label: formatUrlLabel(url), value: url };
}
