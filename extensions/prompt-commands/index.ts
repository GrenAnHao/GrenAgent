// prompt-commands：把 `/名 "参数"…` 展开成 <command> 块。只接管正文里写了 {参数} 的模板，
// 其余交回 Pi 原生的 prompt template 展开。气泡靠 <command> 块还原成命令胶囊。
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandInvocation } from "./expand.js";
import { loadTemplate } from "./templates.js";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const result = expandInvocation(event.text, (name) => loadTemplate(getAgentDir(), name));
    if (result.kind === "pass") return { action: "continue" };
    if (result.kind === "missing") {
      ctx.ui.notify(`命令 /${result.name} 缺少参数：${result.missing.join("、")}`, "error");
      return { action: "handled" };
    }
    return { action: "transform", text: result.text, images: event.images };
  });
}
