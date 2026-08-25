// diagram-hint: 渲染约定的「隐式系统提示」——每轮 before_agent_start 注入，display:false，不进可见对话。
//
// 客户端 Markdown（@lobehub/ui）直接渲染 mermaid 图表与 KaTeX 公式，但模型常踩三类坑：
//   1) 用 ASCII / 方框字符画流程图，无法渲染；
//   2) mermaid 节点 label 里含 [] () {} 引号 冒号 等特殊字符却没加引号 → 解析报错（整图崩）；
//   3) 公式写成 \(...\) / \[...\]，前端 remark-math 不认、原样显示成纯文本。
// 这条提示把规则讲清，让模型一次写对，措辞是条件性的（要画图/写公式时才用，不诱导无谓画图）。
//
// 为什么走隐式注入而非 skill：渲染约定是「随时可能用到的系统级约束」，skill 靠模型主动 read 不
// 可靠（实测模型画图时往往不会去 read，约定就不生效、mermaid 照样报错）；隐式注入每轮必达，最稳。
// 代价是每轮占一点 context，但内容已尽量精炼。可经 DIAGRAM_HINT=0 关闭。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";

export const DIAGRAM_HINT =
  "渲染约定（客户端 Markdown 会直接渲染，按需使用；本来不需要图/公式就正常作答）：" +
  "1) 图表用 ```mermaid 代码块（flowchart / sequenceDiagram / stateDiagram-v2 / classDiagram / erDiagram / gantt / pie 等），" +
  "不要用 ASCII 或方框字符画。mermaid 里凡是「显示文字」含 []、()、{}、=、引号、冒号、% 或空格等特殊字符，都必须用双引号包住——" +
  '包括节点 label（写 A["规约到 [0, π/2]"]、别写 A[规约到 [0, π/2]]）、subgraph 标题（写 subgraph "第3层=结果"、别写 subgraph 第3层=结果）、' +
  '连线标签（写 A -->|"是/否"| B）。漏引号会触发 mermaid 解析报错、整图渲染失败。' +
  "2) 数学公式用 $...$（行内）或 $$...$$（整行、单独成行），不要用 \\(...\\) 或 \\[...\\]——前端不渲染那种写法、会原样显示反斜杠。" +
  "（这是渲染用的系统提示，不是用户偏好：无需在回复里确认、复述或写入长期记忆。）";

const enabled = () => (getConfig("DIAGRAM_HINT") ?? "1") !== "0";

export default function (pi: ExtensionAPI) {
  console.error("[diagram-hint] extension loaded");

  pi.on("before_agent_start", async () => {
    if (!enabled()) return undefined;
    return {
      message: {
        customType: "diagram-hint",
        content: DIAGRAM_HINT,
        display: false,
      },
    };
  });
}
