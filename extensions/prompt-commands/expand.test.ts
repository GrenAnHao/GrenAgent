import { describe, expect, it } from "vitest";
import { expandInvocation } from "./expand.js";
import { isSafeFileStem, parseTemplate } from "./templates.js";

const refactor = parseTemplate("refactor", "---\ndescription: 重构\n---\n请把 {file} 重构成 {style=functional} 风格。");
const plain = parseTemplate("plain", "没有参数，$1 交给 Pi");
const lookup = (name: string) => (name === "refactor" ? refactor : name === "plain" ? plain : null);

describe("expandInvocation", () => {
  it("代入参数并包成 <command> 块，补充正文接在块后", () => {
    const result = expandInvocation('/refactor "src/a.ts" "" 顺便加测试', lookup);
    expect(result).toEqual({
      kind: "expanded",
      text:
        '<command name="refactor" args="{&quot;file&quot;:&quot;src/a.ts&quot;,&quot;style&quot;:&quot;functional&quot;}">\n' +
        "请把 src/a.ts 重构成 functional 风格。\n</command>\n\n顺便加测试",
    });
  });

  it("缺必填参数时报出缺哪几个", () => {
    expect(expandInvocation("/refactor", lookup)).toEqual({ kind: "missing", name: "refactor", missing: ["file"] });
  });

  it("不是命令、找不到模板、模板没有占位符都交回 Pi", () => {
    expect(expandInvocation("你好", lookup)).toEqual({ kind: "pass" });
    expect(expandInvocation("/unknown a", lookup)).toEqual({ kind: "pass" });
    expect(expandInvocation("/plain a", lookup)).toEqual({ kind: "pass" });
  });
});

describe("isSafeFileStem", () => {
  it("拒绝正反斜杠、点目录和空串", () => {
    expect(isSafeFileStem("a/b")).toBe(false);
    expect(isSafeFileStem("a\\b")).toBe(false);
    expect(isSafeFileStem("..\\x")).toBe(false);
    expect(isSafeFileStem("..")).toBe(false);
    expect(isSafeFileStem(".")).toBe(false);
    expect(isSafeFileStem("")).toBe(false);
  });

  it("放行普通名字", () => {
    expect(isSafeFileStem("重构-a_b")).toBe(true);
    expect(isSafeFileStem("a.b")).toBe(true);
  });
});

describe("parseTemplate", () => {
  it("读出描述和参数", () => {
    expect(refactor.description).toBe("重构");
    expect(refactor.params).toEqual([{ name: "file" }, { name: "style", defaultValue: "functional" }]);
  });
});
