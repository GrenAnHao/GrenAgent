// loop-guard: 防止 AI 陷入死循环。
//
// 参考 opencode(MiMo-Code) 的 "doom loop" 检测（连续 N 次相同工具调用即打断）。Pi 的
// tool_call hook 可返回 { block, reason } 拦下该次调用，reason 作为工具结果回灌给模型，
// 促其换策略或收尾。本扩展覆盖两类失控：
//   1) 连续多次调用「完全相同的工具(名+参数)」——典型卡死循环；
//   2) 单次用户请求内工具调用「总数」超上限——发散式失控（参数每次微调、永不收敛）。
//
// 阈值可经 runtime 配置覆盖：
//   LOOP_GUARD=0           关闭本扩展
//   LOOP_GUARD_REPEAT=4    连续相同调用阈值（默认 4，>=2）
//   LOOP_GUARD_MAX_CALLS=80 单次请求工具调用总数上限（默认 80，>=10）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";

const enabled = () => (getConfig("LOOP_GUARD") ?? "1") !== "0";
const repeatLimit = () => Math.max(2, Number(getConfig("LOOP_GUARD_REPEAT") ?? "4") || 4);
const maxCalls = () => Math.max(10, Number(getConfig("LOOP_GUARD_MAX_CALLS") ?? "80") || 80);

interface GuardState {
  /** 上一次工具调用签名（名+参数）。 */
  sig: string;
  /** 连续相同签名的次数。 */
  repeat: number;
  /** 本次用户请求内的工具调用总数（before_agent_start 清零）。 */
  calls: number;
}

/** 工具调用签名：名 + 稳定序列化的参数。参数无法序列化时退化为仅按名比较。 */
function signature(toolName: string, input: unknown): string {
  try {
    return `${toolName}\u0000${JSON.stringify(input ?? null)}`;
  } catch {
    return `${toolName}\u0000<unserializable>`;
  }
}

export default function (pi: ExtensionAPI) {
  console.error("[loop-guard] extension loaded");

  // 按 cwd(会话工作目录)隔离状态，避免多会话/子代理互相干扰。
  const byCwd = new Map<string, GuardState>();
  const stateFor = (key: string): GuardState => {
    let s = byCwd.get(key);
    if (!s) {
      s = { sig: "", repeat: 0, calls: 0 };
      byCwd.set(key, s);
    }
    return s;
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled()) return undefined;
    const key = ctx?.cwd ?? "";
    const st = stateFor(key);
    const sig = signature(event.toolName, event.input);

    st.calls += 1;
    st.repeat = st.sig === sig ? st.repeat + 1 : 1;
    st.sig = sig;

    // 1) 连续相同调用达阈值：疑似卡死。拦截后把 repeat 清零——给模型一次换策略的机会，
    //    若它无视提示继续重复，会再次累计到阈值再次被拦，循环始终无法推进、自然收敛。
    const rl = repeatLimit();
    if (st.repeat >= rl) {
      st.repeat = 0;
      return {
        block: true,
        reason:
          `循环保护：检测到连续 ${rl} 次调用完全相同的工具「${event.toolName}」(参数一致)，` +
          `疑似死循环，已拦截本次调用。请勿重复同一调用——改用不同的参数或工具，` +
          `若已无法推进则基于现有信息直接给出结论、结束本轮。`,
      };
    }

    // 2) 单次请求工具调用总数超上限：疑似发散式失控，要求立即收尾。
    const mc = maxCalls();
    if (st.calls > mc) {
      return {
        block: true,
        reason:
          `循环保护：本轮已调用工具 ${st.calls} 次，超过上限 ${mc}，疑似失控。` +
          `请立即停止调用任何工具，基于现有信息直接给出最终结论、结束本轮。`,
      };
    }

    return undefined;
  });

  // 每个用户请求开始时清零计数（连续相同/总数都按「单次请求」统计）。
  pi.on("before_agent_start", async (_event, ctx) => {
    const st = byCwd.get(ctx?.cwd ?? "");
    if (st) {
      st.sig = "";
      st.repeat = 0;
      st.calls = 0;
    }
    return undefined;
  });
}
