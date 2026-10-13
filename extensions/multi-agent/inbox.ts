export type Delivery = "followUp" | "steer";

export class SubagentError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
  }
}

export interface InboxSession {
  isStreaming: boolean;
  pendingMessageCount: number;
  prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<unknown> | unknown;
}

export class SubagentInbox {
  private closingPromise: Promise<void> | undefined;

  constructor(
    private readonly session: InboxSession,
    /** session.prompt 被拒（worker 已经退出、会话状态不对）：消息没送到。不等结果的 promise 都要接住。 */
    private readonly onDeliveryError: (error: unknown) => void = () => {},
  ) {}

  get closing(): Promise<void> | undefined {
    return this.closingPromise;
  }

  get hasPending(): boolean {
    return this.session.pendingMessageCount > 0;
  }

  /** 发出去、还没有结果的 prompt 数：会话这时可能还在 preflight，没忙起来。 */
  get inFlight(): number {
    return this.sending;
  }

  private sending = 0;

  deliver(text: string, delivery: Delivery): void {
    if (this.closingPromise !== undefined) {
      throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
    }
    // 一律带 streamingBehavior，SDK 只在会话正在跑时用它。空闲时不带的话，连发两条，第二条要等
    // 第一条的 preflight（输入钩子、before_agent_start）走完、开始跑之后才走到那道检查，会报「Agent is already processing」。
    this.send(text, { streamingBehavior: delivery === "steer" ? "steer" : "followUp" });
  }

  private send(text: string, opts: { streamingBehavior: "steer" | "followUp" }): void {
    const pending = Promise.resolve(this.session.prompt(text, opts));
    this.sending += 1;
    void pending
      .then(undefined, (error: unknown) => {
        try {
          this.onDeliveryError(error);
        } catch {
          /* 回调自己出错不能变成漏网的 rejection */
        }
      })
      .finally(() => {
        this.sending -= 1;
      });
  }

  close(release: () => Promise<void>): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.closingPromise = promise;
    void release().then(resolve, reject);
    return this.closingPromise;
  }
}
