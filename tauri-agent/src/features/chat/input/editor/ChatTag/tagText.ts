import type { ChatTagCategory } from './types';

/** 标签序列化成消息文本：文件/目录写 `@路径`，命令写 `/名称`，链接写原始 URL。 */
export function tagToText(category: ChatTagCategory, value: string): string {
  if (category === 'command') return `/${value}`;
  if (category === 'link') return value;
  return `@${value}`;
}
