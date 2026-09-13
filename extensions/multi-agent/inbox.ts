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

  constructor(private readonly session: InboxSession) {}

  get closing(): Promise<void> | undefined {
    return this.closingPromise;
  }

  get hasPending(): boolean {
    return this.session.pendingMessageCount > 0;
  }

  deliver(text: string, delivery: Delivery): void {
    if (this.closingPromise !== undefined) {
      throw new SubagentError("activation is being disposed; the message was not accepted", "ACTIVATION_CLOSING");
    }
    if (delivery === "steer" || this.session.isStreaming) {
      void this.session.prompt(text, { streamingBehavior: delivery === "steer" ? "steer" : "followUp" });
      return;
    }
    void this.session.prompt(text, {});
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
