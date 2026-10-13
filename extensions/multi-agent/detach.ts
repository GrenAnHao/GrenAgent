// 前台 run 转后台：父会话阻塞在 spawn_agent run 里时来了一条引导消息（steer），run 不再等还没完成的子代理，
// 把它们交到后台继续跑（delivery 从 caller 换成 parent），父会话立刻回去处理这条消息。
// 转后台的子代理和后台 spawn 一样：登记为在跑（wait_agent 等得到），结束时发 subagent-settled 通知，
// 父会话这一轮被打断也不再连带取消它们。codemode 脚本里的调用和 chain 不转后台：它们要的就是结果本身。

import { markChildRunning } from "./child-runs.js";
import { settleOneShot, type SubagentResult } from "./manager.js";
import type { SettlementNotice } from "./settlement-notice.js";

const POLL_MS = 200;

/**
 * 这一轮里到达的引导消息。只认 steer：它的意思是「现在就处理」；followUp 是「做完再说」，不该打断 run。
 * 排在这一轮开始之前的 steer 已经在这一轮开头交给了模型，所以每轮开始清零。
 * ctx.hasPendingMessages() 把 followUp 也算在内，单用它会让一条早就排着的跟进把每次 run 都转到后台。
 */
export class SteerWatch {
  private count = 0;

  /** 收到一条用户输入（pi 的 input 事件；父代理经 send_message 发给忙着的子代理的也走这里）。 */
  noteInput(event: { streamingBehavior?: string }): void {
    if (event.streamingBehavior === "steer") this.count += 1;
  }

  /** 新一轮开始，或这次运行结束。 */
  reset(): void {
    this.count = 0;
  }

  get arrived(): boolean {
    return this.count > 0;
  }
}

/**
 * 等 work 完成；enabled 时每 POLL_MS 问一次 hasPendingInput（调用方传「这一轮来了 steer、而且还排着」），
 * 有就不再等，返回 detached。work 本身照常继续，由调用方交到后台。
 */
export function waitOrDetach<T>(
  work: Promise<T>,
  opts: { enabled: boolean; hasPendingInput: () => boolean; pollMs?: number },
): Promise<{ detached: false; value: T } | { detached: true }> {
  const finished = work.then((value) => ({ detached: false as const, value }));
  if (!opts.enabled) return finished;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const check = (): boolean => {
      let pending = false;
      try {
        pending = opts.hasPendingInput();
      } catch {
        pending = false;
      }
      if (!pending) return false;
      stop();
      resolve({ detached: true });
      return true;
    };
    finished.then(
      (done) => {
        stop();
        resolve(done);
      },
      (error) => {
        stop();
        reject(error);
      },
    );
    if (check()) return;
    timer = setInterval(check, opts.pollMs ?? POLL_MS);
  });
}

/**
 * 一次前台 run 里的子代理：转后台之前只记谁在跑；转后台之后，在跑的登记给 wait_agent，
 * 每个结束时各发一条结算通知。detach 时断开父会话这一轮的取消信号（Esc 不再取消它们）。
 */
export class ForegroundRun {
  private detachedFlag = false;
  private readonly running = new Set<string>();

  constructor(
    private readonly opts: {
      parentSessionId: string;
      deliver: (notice: SettlementNotice) => void;
      /** 断开「父会话这一轮被打断 → 取消子代理」的联动。 */
      unlinkAbort: () => void;
    },
  ) {}

  get detached(): boolean {
    return this.detachedFlag;
  }

  /** 子代理开始跑（拿到 id 时）。已经转后台的话，直接登记为在跑。 */
  started(agentId: string): void {
    this.running.add(agentId);
    if (this.detachedFlag) markChildRunning(agentId, this.opts.parentSessionId);
  }

  /** 子代理结束（记账之后）。转后台之后结束的，发结算通知。 */
  finished(agentId: string, result: Pick<SubagentResult, "stopReason" | "output" | "sessionPath" | "diagnostic">): void {
    this.running.delete(agentId);
    if (!this.detachedFlag) return;
    settleOneShot(agentId, result, { parentSessionId: this.opts.parentSessionId, deliver: this.opts.deliver });
  }

  /** 转后台：还在跑的登记给 wait_agent，之后结束的各发通知。只做一次。 */
  detach(): void {
    if (this.detachedFlag) return;
    this.detachedFlag = true;
    this.opts.unlinkAbort();
    for (const agentId of this.running) markChildRunning(agentId, this.opts.parentSessionId);
  }

  isRunning(agentId: string | undefined): boolean {
    return agentId !== undefined && this.running.has(agentId);
  }
}

/** 父会话这一轮的取消信号转给子代理用的信号；转后台时断开，之后这一轮被打断不再连带取消。 */
export function detachableSignal(outer: AbortSignal | null | undefined): { signal: AbortSignal; unlink: () => void } {
  const controller = new AbortController();
  if (!outer) return { signal: controller.signal, unlink: () => {} };
  if (outer.aborted) {
    controller.abort();
    return { signal: controller.signal, unlink: () => {} };
  }
  const forward = () => controller.abort();
  outer.addEventListener("abort", forward, { once: true });
  return { signal: controller.signal, unlink: () => outer.removeEventListener("abort", forward) };
}
