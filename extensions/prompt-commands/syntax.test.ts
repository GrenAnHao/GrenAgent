import { describe, expect, it } from "vitest";
import {
  argumentHint,
  buildCommandBlock,
  collapseCommandBlocks,
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

  it("参数名叫 __proto__ 时值不会丢", () => {
    const result = resolveArgs([{ name: "__proto__" }], ["v"]);
    expect(result.values.__proto__).toBe("v");
    expect(result.missing).toEqual([]);
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

  it("双引号内只有 \\\" 和 \\\\ 是转义，其它反斜杠原样保留", () => {
    expect(splitArgs('"C:\\path\\to" "a\\nb"', 2)).toEqual({ args: ["C:\\path\\to", "a\\nb"], rest: "" });
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

  it("同一段文本里的两个块各自给出正确的 start/end", () => {
    const first = buildCommandBlock("a", [{ name: "x", value: "1" }], "正文一");
    const second = buildCommandBlock("b", [], "正文二");
    const text = `前${first}中${second}后`;
    const hits = findCommandBlocks(text);
    expect(hits).toHaveLength(2);
    expect(text.slice(hits[0].start, hits[0].end)).toBe(first);
    expect(text.slice(hits[1].start, hits[1].end)).toBe(second);
    expect(hits[0].block?.name).toBe("a");
    expect(hits[1].block?.name).toBe("b");
  });

  it("args 坏掉时 hit 仍有正确的 start/end，block 为 null", () => {
    const bad = '<command name="x" args="not json">\n正文\n</command>';
    const text = `前${bad}后`;
    const [hit] = findCommandBlocks(text);
    expect(hit.block).toBeNull();
    expect(text.slice(hit.start, hit.end)).toBe(bad);
  });

  it("大量未闭合的开头不会拖成二次方", () => {
    const text = '<command name="x" args="{}">\n'.repeat(20000);
    const startedAt = performance.now();
    expect(findCommandBlocks(text)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it("args 坏掉时 block 为 null", () => {
    expect(decodeCommandBlock("x", "not json")).toBeNull();
    expect(decodeCommandBlock("x", "[1]")).toBeNull();
  });
});

describe("collapseCommandBlocks", () => {
  const args = [
    { name: "file", value: "a.ts" },
    { name: "style", value: "fp" },
  ];

  it("命令块还原成调用文本，块后的换行压成一个空格再接补充正文", () => {
    const text = `${buildCommandBlock("refactor", args, "模板正文")}\n\n顺便看看`;
    expect(collapseCommandBlocks(text)).toBe('/refactor "a.ts" "fp" 顺便看看');
  });

  it("块在末尾时不加空格", () => {
    expect(collapseCommandBlocks(buildCommandBlock("refactor", args, "模板正文"))).toBe('/refactor "a.ts" "fp"');
  });

  it("坏块和无块的文本原样保留", () => {
    const bad = '<command name="x" args="not json">\n正文\n</command>\n\n后';
    expect(collapseCommandBlocks(bad)).toBe(bad);
    expect(collapseCommandBlocks("普通文本\n第二行")).toBe("普通文本\n第二行");
  });

  it("参数含引号和反斜杠时，结果经 parseInvocation + splitArgs 往返一致", () => {
    const tricky = [
      { name: "a", value: 'say "hi"' },
      { name: "b", value: "C:\\dir\\x" },
    ];
    const text = `${buildCommandBlock("cmd", tricky, "正文")}\n\n补充`;
    const parsed = parseInvocation(collapseCommandBlocks(text));
    expect(parsed?.name).toBe("cmd");
    expect(splitArgs(parsed!.argsText, 2)).toEqual({ args: ['say "hi"', "C:\\dir\\x"], rest: "补充" });
  });
});
