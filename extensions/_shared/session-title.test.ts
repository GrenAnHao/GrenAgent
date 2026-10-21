import { describe, expect, it } from "vitest";
import { buildCommandBlock } from "../prompt-commands/syntax.js";
import { fallbackSessionTitle, firstUserMessage, parseFirstMessage, titleModelInput } from "./session-title.js";

// 形状照真实会话：pi 1.3.0 的技能展开（agent-session.js `_expandSkillCommand`）、输入框的粘贴块（attachment.ts wrapAttachment）、
// pi 给缩放过的图片补的说明文字。
const SKILL = `<skill name="brainstorming" location="C:\\Users\\me\\.agents\\skills\\brainstorming\\SKILL.md">
References are relative to C:\\Users\\me\\.agents\\skills\\brainstorming.

# 头脑风暴：将想法转化为设计

<HARD-GATE>
在你展示设计方案之前，不要写代码。
</HARD-GATE>
</skill>`;

const PASTED = `<pi:attachment type="text" lines="45" chars="4194">
我们要为客服模块（省心掌柜）的「正式模型通道」规划服务端设计。
## 背景
自家 Rust 服务端接收客户端的模型请求。
</pi:attachment>`;

const FILE = `<pi:attachment type="file" path="docs/pdd-browser-shell-design.md" lines="310">
# 店群软件 · 店铺浏览器壳实现指南
</pi:attachment>`;

const IMAGE_HINT = "[Image: original 2559x1527, displayed at 2000x1193. Multiply coordinates by 1.28 to map to original image.]";

describe("parseFirstMessage", () => {
  it("技能块后面的正文是用户正文，技能名单独记下", () => {
    const parsed = parseFirstMessage(`${SKILL}\n\n现在规划套餐订购页 以模态框的方式展示`);
    expect(parsed.text).toBe("现在规划套餐订购页 以模态框的方式展示");
    expect(parsed.skills).toEqual(["brainstorming"]);
  });

  it("发送前的 /skill: 调用（含带空格的引号名）", () => {
    expect(parseFirstMessage("/skill:brainstorming 规划套餐页")).toMatchObject({ text: "规划套餐页", skills: ["brainstorming"] });
    expect(parseFirstMessage('/skill:"my skill" 做点事')).toMatchObject({ text: "做点事", skills: ["my skill"] });
  });

  it("粘贴块、文件块拆出来，图片说明去掉并计数", () => {
    const parsed = parseFirstMessage(`看看这个\n\n${IMAGE_HINT}\n\n${PASTED}\n\n${FILE}`);
    expect(parsed.text).toBe("看看这个");
    expect(parsed.images).toBe(1);
    expect(parsed.attachments).toEqual([
      { type: "text", content: expect.stringContaining("正式模型通道") },
      { type: "file", path: "docs/pdd-browser-shell-design.md", content: "# 店群软件 · 店铺浏览器壳实现指南" },
    ]);
  });

  it("命令块拆出命令名、参数和模板正文", () => {
    const block = buildCommandBlock("refactor", [{ name: "file", value: "src/a.ts" }], "请把 src/a.ts 重构成函数式风格。");
    const parsed = parseFirstMessage(`${block}\n\n顺便加测试`);
    expect(parsed.text).toBe("顺便加测试");
    expect(parsed.commands).toEqual([
      { name: "refactor", args: [{ name: "file", value: "src/a.ts" }], body: "请把 src/a.ts 重构成函数式风格。" },
    ]);
  });
});

describe("fallbackSessionTitle", () => {
  it("普通消息压成一行", () => {
    expect(fallbackSessionTitle("帮我修一下登录页\n第二行")).toBe("帮我修一下登录页 第二行");
  });

  it("只有粘贴块时用粘贴内容的第一行，不显示 <pi:attachment", () => {
    expect(fallbackSessionTitle(PASTED)).toBe("我们要为客服模块（省心掌柜）的「正式模型通道」规划服务端设计。");
  });

  it("技能展开后显示用户正文，不显示 <skill name=", () => {
    expect(fallbackSessionTitle(`${SKILL}\n\n现在规划套餐订购页`)).toBe("现在规划套餐订购页");
    expect(fallbackSessionTitle(SKILL)).toBe("/skill:brainstorming");
  });

  it("图片说明不进标题；只有图片时写「图片」", () => {
    expect(fallbackSessionTitle(`调整一下订单查询栏\n\n${IMAGE_HINT}`, 1)).toBe("调整一下订单查询栏");
    expect(fallbackSessionTitle("", 1)).toBe("图片");
    expect(fallbackSessionTitle(IMAGE_HINT)).toBe("图片");
  });

  it("只有文件块时用文件名；@ 引用换成文件名", () => {
    expect(fallbackSessionTitle(FILE)).toBe("pdd-browser-shell-design.md");
    expect(fallbackSessionTitle("@.pi/dropped/029253aba802a7cb/HANDOFF.md 看一下")).toBe("HANDOFF.md 看一下");
  });

  it("命令块写成调用加补充正文", () => {
    const block = buildCommandBlock("refactor", [{ name: "file", value: "src/a.ts" }, { name: "style", value: "" }], "正文");
    expect(fallbackSessionTitle(block)).toBe("/refactor src/a.ts");
    expect(fallbackSessionTitle(`${block}\n\n顺便加测试`)).toBe("/refactor src/a.ts 顺便加测试");
  });

  it("按 code point 截断；什么都没有返回 null", () => {
    expect(fallbackSessionTitle("😀".repeat(100))).toBe("😀".repeat(80));
    expect(fallbackSessionTitle("   ")).toBeNull();
  });
});

describe("titleModelInput", () => {
  it("用户正文放 <request>，技能只给名字，不给整份 SKILL.md", () => {
    const input = titleModelInput(`${SKILL}\n\n现在规划套餐订购页`);
    expect(input).toBe("<request>\n现在规划套餐订购页\n</request>\n\n<attachments>\nSkill: brainstorming\n</attachments>");
    expect(input).not.toContain("HARD-GATE");
  });

  it("只有粘贴块时正文写 (empty)，粘贴内容按预算截短", () => {
    const long = `<pi:attachment type="text" lines="1" chars="9000">\n${"很长的内容".repeat(2000)}\n</pi:attachment>`;
    const input = titleModelInput(long, 0, 1000);
    expect(input.startsWith("<request>\n(empty)\n</request>")).toBe(true);
    expect(input).toContain("Pasted text:\n很长的内容");
    expect(input.length).toBeLessThan(1200);
  });

  it("图片计数进附带内容；只有图片、没有文字时返回空串", () => {
    expect(titleModelInput(`你看看这个气泡如何\n\n${IMAGE_HINT}`)).toContain("Images: 1");
    expect(titleModelInput("", 2)).toBe("");
  });
});

describe("firstUserMessage", () => {
  it("取第一条有内容的用户消息，跳过别的条目，图片块计数", () => {
    const entries = [
      { type: "session_info", name: "x" },
      { type: "message", message: { role: "assistant", content: "hi" } },
      { type: "message", message: { role: "user", content: "  " } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "", mimeType: "image/png" }] } },
      { type: "message", message: { role: "user", content: "继续吧" } },
    ];
    expect(firstUserMessage(entries)).toEqual({ text: "看图", images: 1 });
    expect(firstUserMessage([])).toBeNull();
  });
});
