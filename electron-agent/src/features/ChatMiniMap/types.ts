/** 一条刻度：对应一条用户消息在虚拟列表中的位置，以及悬停气泡要展示的这一轮摘要。 */
export interface MinimapIndicator {
  id: string;
  /** 该消息在虚拟列表中的条目下标，点击刻度即滚到此处。 */
  listIndex: number;
  /** 气泡标题：用户消息的单行摘要。 */
  title: string;
  /** 气泡正文：紧随其后的助手回复摘要；没有回复时为空串。 */
  reply: string;
}

export interface MinimapIndicatorProps {
  id: string;
  listIndex: number;
  /** 本刻度在 rail 中的序号（从 0 起）。 */
  position: number;
  /** 突出程度（0 为默认长度，最高级为悬停中的那条）。 */
  emphasis: number;
  /** 当前视口是否落在这一轮对话上。 */
  isActive: boolean;
  onJump: (listIndex: number) => void;
  onHover: (position: number, element: HTMLElement) => void;
}
