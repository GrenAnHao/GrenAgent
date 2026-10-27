import { relativeSegments } from './treeModel';

export type PathMode = 'relative' | 'absolute';

/** 路径在界面上写成什么样：相对项目根（用 `/` 连接，项目根自己是 `.`），或原样的绝对路径。不在项目根下的一律给绝对路径。 */
export function displayPath(root: string | null, path: string, mode: PathMode): string {
  if (mode === 'absolute' || !root) return path;
  const segments = relativeSegments(root, path);
  if (segments) return segments.join('/') || '.';
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === rootNorm ? '.' : path;
}

/** 窄栏里省略号只吃目录部分，文件名始终完整可见。dir 带结尾的分隔符。 */
export function splitPathForDisplay(text: string): { dir: string; name: string } {
  const trimmed = text.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (at < 0) return { dir: '', name: text };
  return { dir: text.slice(0, at + 1), name: text.slice(at + 1) };
}

const TOOLTIP_LIMIT = 10;

export interface PathSummary {
  /** 栏里显示的一行。 */
  text: string;
  /** 悬停显示的完整值：多项时逐行列出。 */
  full: string;
  /** 「复制」写进剪贴板的内容：多项时一行一个。 */
  copy: string;
  count: number;
}

/** 当前要展示的路径：0 项为空，1 项是路径本身，多项写成「已选 N 项」，复制仍给全部路径。 */
export function summarizePaths(root: string | null, paths: readonly string[], mode: PathMode): PathSummary {
  const shown = paths.map((path) => displayPath(root, path, mode));
  if (shown.length === 0) return { text: '', full: '', copy: '', count: 0 };
  if (shown.length === 1) return { text: shown[0], full: shown[0], copy: shown[0], count: 1 };
  const listed = shown.slice(0, TOOLTIP_LIMIT);
  const more = shown.length - listed.length;
  return {
    text: `已选 ${shown.length} 项`,
    full: [...listed, ...(more > 0 ? [`… 另有 ${more} 项`] : [])].join('\n'),
    copy: shown.join('\n'),
    count: shown.length,
  };
}
