/** 输入框内联标签 / 临时附件的共享类型。 */

/**
 * `@` 文件/目录提及节点的 metadata（写入 MentionNode.metadata）。
 * 用 type alias 而非 interface，便于赋给编辑器要求的 `Record<string, unknown>`。
 */
export type LocalFileMentionMeta = {
  type: 'localFile';
  /** 展示用文件名（pill 文本）。 */
  name: string;
  /** 引用路径：工作区内用相对路径（正斜杠），区外用绝对路径。发送时序列化为 `@path`。 */
  path: string;
  isDirectory?: boolean;
};

/** 粘贴的长文本 / 拖入的文件内容：以 chip 形式暂存，发送时展开拼进消息（类 Claude Code）。 */
export interface PastedText {
  id: string;
  text: string;
  lines: number;
  chars: number;
  /** 来源文件的相对路径（拖拽文件读入时设置）；纯文本粘贴时为空。 */
  source?: string;
  /** 仅引用路径、不嵌入内容（大文件拖入）；发送时序列化为 `@path`。 */
  referenceOnly?: boolean;
}
