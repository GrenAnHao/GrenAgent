/**
 * 对话列表的贴底跟随意图（参照 DSH ui-chat 的 ScrollFollow / ChatReading）：
 * - 不按输入设备判断读者：记一本「账」——最近一次程序写入或已接受的 scrollTop，
 *   scroll 事件落点偏离账面才算读者移动，滚轮、触控板、拖滚动条、键盘一视同仁；
 * - 读者移动不立刻下结论：等 scrollend（或采样间隔）再看离底距离决定是否继续跟随，
 *   期间内容长高不贴底，小幅上滚不会被流式增长抵消；
 * - 读者正好滚到最底立刻恢复跟随；跟随中的非读者回声（浏览器钳制、virtua 的跳变补偿）直接贴回底部。
 * 只认滚动容器自己的 scroll 事件：内部滚动区（思考块、终端、代码块）滚动不影响外层意图。
 *
 * 与 DSH 的差别：DSH 不虚拟化正文，账本外的位移只有读者。virtua 会自己写 scrollTop——内容缩短时
 * 浏览器先钳制一次、virtua 的跳变补偿再减一次，视图被推到底部上方几十像素，快速输出时频繁发生。
 * 所以跟随中往上的位移还要有读者手势（滚轮、触控、按下指针含拖滚动条、滚动键）在先才算读者。
 */

/** 一次几何读取：当前位置与可滚到的最大位置。 */
export interface ScrollMetrics {
  readonly top: number;
  readonly floor: number;
}

export function scrollMetrics(el: HTMLElement): ScrollMetrics {
  return { top: el.scrollTop, floor: Math.max(0, el.scrollHeight - el.clientHeight) };
}

/** 采样时离底多少像素内算「还在底部」（DSH 同值）。 */
export const FOLLOW_THRESHOLD = 25;
/** 读者移动后最晚多久采样一次（没有 scrollend 时兜底）。 */
export const SAMPLE_INTERVAL_MS = 500;
// 浏览器写 scrollTop 会丢小数，半像素以内视为同一位置。
const EPSILON = 0.5;
// 读者手势之后多久内的位移归读者：覆盖滚轮平滑动画、键盘翻页动画和触控板惯性。
export const INTENT_WINDOW_MS = 1000;

export class TranscriptFollow {
  private following = true;
  private ledger = 0;
  private sampleTimer: ReturnType<typeof setTimeout> | null = null;
  private intentAt = -Infinity;
  private pointerHeld = false;

  /**
   * @param onChange 跟随意图变化（「回到底部」按钮）。
   * @param now 时钟，测试注入。
   */
  constructor(
    private readonly onChange: (following: boolean) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** 内容增长是否应该跟到底部。 */
  get active(): boolean {
    return this.following;
  }

  /** 读者移动还没采样：这段时间不替读者滚动。 */
  get pending(): boolean {
    return this.sampleTimer !== null;
  }

  /** 贴到当前底部并恢复跟随（打开会话、回到底部、发出新消息）。 */
  toBottom(el: HTMLElement): void {
    this.cancelSample();
    this.land(el);
    this.publish(true);
  }

  /** 内容或视口尺寸变了：跟随中且没有待采样的读者移动时，跟到新的底部。 */
  reconcile(el: HTMLElement): void {
    if (this.following && !this.pending) this.land(el);
  }

  /** 程序化阶段（钉底、resize 锚点恢复）产生的滚动回声：记账，不当成读者移动。 */
  acknowledge(el: HTMLElement): void {
    if (!this.pending) this.ledger = el.scrollTop;
  }

  /** 读者手势（滚轮、触控、滚动键、输入框转发的滚动）：之后一小段时间内的位移归读者。 */
  noteIntent(): void {
    this.intentAt = this.now();
  }

  /** 指针按下 / 松开：按住期间（拖滚动条）的位移都归读者。 */
  holdPointer(held: boolean): void {
    this.pointerHeld = held;
    this.intentAt = this.now();
  }

  /** 滚动容器的 scroll 事件。 */
  onScroll(el: HTMLElement): void {
    const m = scrollMetrics(el);
    const base = Math.min(this.ledger, m.floor);
    // 跟随中读者只能往上离开底部，而且得有读者手势在先；往下的位移、没有手势的上移
    // 都是钳制或 virtua 的跳变补偿，不算读者。
    const moved = this.following
      ? m.top < base - EPSILON && this.readerActive()
      : Math.abs(m.top - base) > EPSILON;
    if ((!moved && this.following && !this.pending) || (moved && m.top >= m.floor - EPSILON)) {
      this.toBottom(el);
      return;
    }
    if (moved) this.sampleTimer ??= setTimeout(() => this.sample(el), SAMPLE_INTERVAL_MS);
  }

  /** 原生 scrollend：读者停手，立即采样。 */
  onScrollEnd(el: HTMLElement): void {
    this.sample(el);
  }

  dispose(): void {
    this.cancelSample();
  }

  private readerActive(): boolean {
    return this.pointerHeld || this.now() - this.intentAt < INTENT_WINDOW_MS;
  }

  private sample(el: HTMLElement): void {
    if (!this.pending) return;
    this.cancelSample();
    const m = scrollMetrics(el);
    if (m.floor - m.top <= FOLLOW_THRESHOLD) {
      this.toBottom(el);
      return;
    }
    this.ledger = m.top;
    this.publish(false);
  }

  private land(el: HTMLElement): void {
    const { top, floor } = scrollMetrics(el);
    if (top !== floor) el.scrollTop = floor;
    this.ledger = el.scrollTop;
  }

  private publish(following: boolean): void {
    if (this.following === following) return;
    this.following = following;
    this.onChange(following);
  }

  private cancelSample(): void {
    if (this.sampleTimer !== null) clearTimeout(this.sampleTimer);
    this.sampleTimer = null;
  }
}
