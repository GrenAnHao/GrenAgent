// 请求期投影：把 taste 文本作为 system 段落附在 Pi 的原生前导 system 消息上，
// 并按「最后一条 assistant 之后的新输入 / 已完成协作结果」插入隐藏的 steer 提醒。
//
// 为什么不走 before_agent_start 的自定义消息：那条路会把整段文本写进会话日志，
// 之后每个后台唤醒、goal 续跑都重发一份。这里只在请求上投影，文本不落盘。
// 段名 gpt_with_taste 由 Pi 的 section 规范化（^[a-z][a-z0-9_-]*$），内容自带 XML 标签，
// 便于模型把后续同名段更新和原文对上。
//
// 语义移植自上游 NB-Corp/gpt-with-taste 的 adapters/pi/runtime/projection.mjs（MIT），
// 区别：角色由会话身份推断（子代理会话用 sub），不依赖加载不同的入口文件。
import type { TasteRole, TasteTexts } from "./texts.js";

export const TASTE_SECTION = "gpt_with_taste";
export const TASTE_STEER_TYPE = "gpt-with-taste:steer";

type SteerRoute = "user" | "sub" | "agent";

const STEER_KEY = { user: "userSteer", sub: "subSteer", agent: "agentSteer" } as const;

/** 供 system 段落使用的整块文本。 */
export function tasteBlock(texts: TasteTexts, role: TasteRole): string {
  return `<gpt-with-taste>\n${texts[role].trim()}\n</gpt-with-taste>`;
}

export function steerBlock(texts: TasteTexts, route: SteerRoute): string {
  return `<gpt-with-taste-${route}-steer>\n${texts[STEER_KEY[route]].trim()}\n</gpt-with-taste-${route}-steer>`;
}

/** 只读最小消息形状：这是纯函数，避免把 pi-ai 的完整类型拖进测试。 */
export interface ProjectedMessage {
  role: string;
  customType?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
  timestamp?: number;
  [key: string]: unknown;
}

export interface ProjectOptions {
  role: TasteRole;
  active: boolean;
  steering: boolean;
  /** 视为「协作方已完成」的自定义消息类型；只有 role=main 时才路由 agentSteer。 */
  completedResultTypes: ReadonlySet<string>;
}

/**
 * 返回新的消息数组：
 * 1. 先摘掉上一次投影留下的 steer 消息与系统段（同一个数组被复用时不能叠加）；
 * 2. 不生效时原样返回；
 * 3. 生效时在前导 system 消息上挂 gpt_with_taste 段；
 * 4. 需要 steer 时，在最后一条 assistant 之后的新输入 / 已完成结果后面各插一条隐藏提醒。
 */
export function projectMessages<T extends ProjectedMessage>(
  input: readonly T[],
  texts: TasteTexts,
  options: ProjectOptions,
): T[] {
  const messages = input
    .filter((message) => !(message.role === "custom" && message.customType === TASTE_STEER_TYPE))
    .map((message) => {
      if (message.role !== "system" || !message.sections || !(TASTE_SECTION in message.sections)) {
        return message;
      }
      const sections = { ...message.sections };
      delete sections[TASTE_SECTION];
      return { ...message, sections };
    });

  const { role, active, steering, completedResultTypes } = options;
  if (!active) return messages;
  if (messages[0]?.role !== "system") {
    // Pi 的请求永远带着前导 system 消息；走到这里说明投影时机不对，宁可不动也不要造出第二个 system。
    console.error("[gpt-with-taste] 请求里没有前导 system 消息，跳过投影");
    return messages;
  }

  const head = messages[0];
  messages[0] = { ...head, sections: { ...head.sections, [TASTE_SECTION]: tasteBlock(texts, role) } };

  if (!steering || role === "independent") return messages;

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  const withSteer: T[] = [];
  messages.forEach((message, index) => {
    withSteer.push(message);
    if (index <= lastAssistant) return;
    let route: SteerRoute | undefined;
    if (message.role === "user") route = role === "sub" ? "sub" : "user";
    else if (role === "main" && message.role === "custom" && completedResultTypes.has(message.customType ?? "")) {
      route = "agent";
    }
    if (!route) return;
    withSteer.push({
      role: "custom",
      customType: TASTE_STEER_TYPE,
      content: steerBlock(texts, route),
      display: false,
      details: { route },
      timestamp: message.timestamp,
    } as unknown as T);
  });
  return withSteer;
}
