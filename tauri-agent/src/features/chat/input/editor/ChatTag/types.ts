import type { CommandApiSource } from '../../commandTypes';

/** 行内彩色标签的类别。 */
export type ChatTagCategory = 'file' | 'directory' | 'command' | 'link';

/** 命令标签的类目（与 slash 菜单分组一致）：用于按类目给 chip 着色。 */
export type ChatTagCommandGroup = CommandApiSource | 'frontend';

/** 插入标签所需数据（INSERT_CHAT_TAG_COMMAND 的 payload）。 */
export interface ChatTagData {
  category: ChatTagCategory;
  /** pill 上展示的短文本（文件名 / 命令名）。 */
  label: string;
  /** 序列化值：文件/目录用相对路径，命令用命令名。 */
  value: string;
  /** 命令类目（仅 category==='command' 有意义），用于工具命令等按类目着色。 */
  commandGroup?: ChatTagCommandGroup;
  /**
   * 插入标签后紧跟着写入的纯文本（不进标签节点）。
   * 用于「粘贴 `/cmd 参数`」场景：标签后接上参数文本，等价于手动选命令后再打字。
   */
  trailingText?: string;
}
