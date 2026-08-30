import type { LocalFileMentionMeta } from './types';

/** MentionNode 未从包根导出，这里用最小结构型签名（只读 label/metadata）。 */
interface MentionLike {
  label: string;
  metadata?: Record<string, unknown>;
}

export function fileMentionMeta(
  path: string,
  name: string,
  isDirectory: boolean,
): LocalFileMentionMeta {
  return { type: 'localFile', name, path, isDirectory };
}

/**
 * 把 MentionNode 序列化成消息文本。文件/目录提及写成 `@相对路径`，
 * 让 agent 能识别并自行 Read（与 messenger 的 `@path` 约定一致）。
 */
export function mentionMarkdownWriter(node: MentionLike): string {
  const meta = node.metadata as Partial<LocalFileMentionMeta> | undefined;
  if (meta?.type === 'localFile' && meta.path) {
    return `@${meta.path}`;
  }
  return `@${node.label}`;
}
