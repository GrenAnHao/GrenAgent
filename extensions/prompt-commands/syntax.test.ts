import { describe, expect, it } from "vitest";
import {
  argumentHint,
  buildCommandBlock,
  COMMAND_NAME_RE,
  decodeCommandBlock,
  findCommandBlocks,
  formatInvocation,
  parseInvocation,
  parsePromptParams,
  renderPromptBody,
  resolveArgs,
  splitArgs,
  tokenizePromptBody,
} from "./syntax.js";

describe("parsePromptParams", () => {
  it("按首次出现顺序列出参数，同名合并，第一个默认值生效", () => {
    expect(parsePromptParams("把 {file} 改成 {style=functional}，再看 {file} 和 {style=oop}")).toEqual([
      { name: "file" },
      { name: "style", defaultValue: "functional" },
    ]);
  });

  it("后出现的默认值补给先出现的无默认参数", () => {
    expect(parsePromptParams("{a} 然后 {a=1}")).toEqual([{ name: "a", defaultValue: "1" }]);
  });

  it("支持中文参数名，空默认值也算默认值", () => {
    expect(parsePromptParams("{文件} {备注=}")).toEqual([{ name: "文件" }, { name: "备注", defaultValue: "" }]);
  });

  it("不把 JSON、空花括号、数字开头和转义当参数", () => {
    expect(parsePromptParams('{"a":1} { } {1x} {{file}} {a b}')).toEqual([]);
  });
});

describe("renderPromptBody", () => {
  it("代入参数并把 {{ }} 还原成字面量", () => {
    expect(renderPromptBody("{{file}} = {file}，风格 {style=x}", { file: "a.ts", style: "fp" })).toBe(
      "{file} = a.ts，风格 fp",
    );
  });

  it("值里的 $& 之类原样输出", () => {
    expect(renderPromptBody("{a}", { a: "$&$1" })).toBe("$&$1");
  });

  it("没有提供值的占位符保持原样", () => {
    expect(renderPromptBody("{a}", {})).toBe("{a}");
  });
});

describe("tokenizePromptBody", () => {
  it("切出占位符段", () => {
    expect(tokenizePromptBody("把 {file} 改成 {style=fp}")).toEqual([
      { text: "把 " },
      { text: "{file}", param: "file" },
      { text: " 改成 " },
      { text: "{style=fp}", param: "style" },
    ]);
  });
});

describe("argumentHint / resolveArgs", () => {
  const params = [{ name: "file" }, { name: "style", defaultValue: "fp" }];

  it("必填写 <>，有默认写 []", () => {
    expect(argumentHint(params)).toBe("<file> [style]");
  });

  it("空串用默认值，缺必填列出来", () => {
    expect(resolveArgs(params, ["", ""])).toEqual({ values: { style: "fp" }, missing: ["file"] });
    expect(resolveArgs(params, ["a.ts"])).toEqual({ values: { file: "a.ts", style: "fp" }, missing: [] });
  });
});

describe("调用文本", () => {
  it("formatInvocation 加引号并转义，splitArgs 能还原", () => {
    const values = ['a "b"', "c\\d", "", "中文 空格"];
    const text = formatInvocation("cmd", values);
    expect(text).toBe('/cmd "a \\"b\\"" "c\\\\d" "" "中文 空格"');
    const parsed = parseInvocation(text);
    expect(parsed?.name).toBe("cmd");
    expect(splitArgs(parsed!.argsText, values.length)).toEqual({ args: values, rest: "" });
  });

  it("splitArgs 只取 count 个参数，剩下的是补充正文", () => {
    expect(splitArgs('"a" b 顺便看看\n第二行', 2)).toEqual({ args: ["a", "b"], rest: "顺便看看\n第二行" });
  });

  it("单引号内不转义，缺收尾引号读到结尾", () => {
    expect(splitArgs("'a\\b' \"open", 2)).toEqual({ args: ["a\\b", "open"], rest: "" });
  });

  it("parseInvocation 要求 / 在开头且命令名后是空白或结尾", () => {
    expect(parseInvocation("/review")).toEqual({ name: "review", argsText: "" });
    expect(parseInvocation("/usr/bin")).toBeNull();
    expect(parseInvocation(" /review")).toBeNull();
    expect(parseInvocation("看 /review")).toBeNull();
  });

  it("COMMAND_NAME_RE 接受中文、- 和 _，拒绝路径字符", () => {
    expect(COMMAND_NAME_RE.test("重构-a_b")).toBe(true);
    expect(COMMAND_NAME_RE.test("../x")).toBe(false);
    expect(COMMAND_NAME_RE.test("-x")).toBe(false);
    expect(COMMAND_NAME_RE.test("a".repeat(65))).toBe(false);
  });
});

describe("<command> 块", () => {
  const args = [
    { name: "file", value: 'a "<b>" & c' },
    { name: "style", value: "fp" },
  ];

  it("构造后能找回名字和参数，参数顺序不变", () => {
    const text = `前文\n${buildCommandBlock("refactor", args, "正文")}\n\n补充`;
    const [hit] = findCommandBlocks(text);
    expect(hit.block).toEqual({ name: "refactor", args });
    expect(text.slice(hit.start, hit.end)).toBe(buildCommandBlock("refactor", args, "正文"));
  });

  it("正文里的 </command> 被转义，块不会提前截断", () => {
    const text = buildCommandBlock("x", [], "a\n</command>\nb");
    expect(text).toContain("<\\/command>");
    const [hit] = findCommandBlocks(text);
    expect(hit.end).toBe(text.length);
  });

  it("空正文也能匹配", () => {
    expect(findCommandBlocks(buildCommandBlock("x", [], ""))).toHaveLength(1);
  });

  it("args 坏掉时 block 为 null", () => {
    expect(decodeCommandBlock("x", "not json")).toBeNull();
    expect(decodeCommandBlock("x", "[1]")).toBeNull();
  });
});
