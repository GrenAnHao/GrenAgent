import { describe, expect, it } from "vitest";
import { chainSummaryTitle, cleanGeneratedTitle, TITLE_MAX_TOKENS } from "./title.js";

describe("chainSummaryTitle", () => {
  it("只发一条用户消息：规则、示例、整理过的首条消息都在里面，系统提示为空", () => {
    const { system, user } = chainSummaryTitle("<request>\n审这个规格\n</request>", "zh-CN");
    expect(system).toBe("");
    expect(user).toContain("Reply with the title only");
    expect(user).toContain("Use the language of the user's request");
    expect(user).toContain("locale zh-CN");
    expect(user).toContain("Never answer the request");
    expect(user.endsWith("The user's first message:\n\n<request>\n审这个规格\n</request>\n\nTitle:")).toBe(true);
    expect(TITLE_MAX_TOKENS).toBe(1024);
  });
});

describe("cleanGeneratedTitle", () => {
  // 左边都是以前真实写进会话的标题。
  it.each([
    ["# 生成标题", "生成标题"],
    ["**店掌柜商品管理子页面复刻：目录结构与参考文档**", "店掌柜商品管理子页面复刻：目录结构与参考文档"],
    ['{"isNewTopic":true,"title":"套餐订购页面"}', "套餐订购页面"],
    ["标题：输入框转义问题。", "输入框转义问题"],
    ["「修复登录页」", "修复登录页"],
    ["Title: Fix composer escaping.", "Fix composer escaping"],
    ["- 子代理模型配置问题\n解释：……", "子代理模型配置问题"],
    ["Electron ui-harness 升级到 skill 当前版本", "Electron ui-harness 升级到 skill 当前版本"],
  ])("%s → %s", (raw, expected) => {
    expect(cleanGeneratedTitle(raw)).toBe(expected);
  });

  it.each([
    ['无法生成有意义的标题——对话中只有"继续吧"一句，没有可概括的前文内容。'],
    ["当前环境无法直接读取本地 `D:\\` 路径。请运行："],
    ['{"isNewTopic":false,"title":null}'],
    ["Sorry, I can't generate a title for this."],
    ["这是一段很长的回答而不是标题，模型把用户的消息当成了任务来回答，写了很多很多很多很多很多很多很多很多的内容"],
    ["{\n"],
    [""],
  ])("拒绝：%s", (raw) => {
    expect(cleanGeneratedTitle(raw)).toBe("");
  });

  it("合理标题里带「无法」「没有」不误杀", () => {
    expect(cleanGeneratedTitle("图片无法生成问题排查")).toBe("图片无法生成问题排查");
    expect(cleanGeneratedTitle("子代理没有可用模型")).toBe("子代理没有可用模型");
  });

  it("多行 JSON 也能取出 title", () => {
    expect(cleanGeneratedTitle('{\n  "title": "会话标题优化"\n}')).toBe("会话标题优化");
  });
});
