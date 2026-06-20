import { describe, expect, it } from "vitest";
import {
  type AskUserUi,
  CUSTOM_OPTION_ID,
  collectAnswers,
  makeQuestionsId,
  normalizeQuestions,
  type RawQuestion,
} from "./questions.js";

describe("makeQuestionsId", () => {
  it("formats as q-<base36 timestamp>-<rand>", () => {
    expect(makeQuestionsId(new Date(0), "abcd")).toBe("q-0-abcd");
    expect(makeQuestionsId(new Date(1000), "zzzz")).toBe(`q-${(1000).toString(36)}-zzzz`);
  });
});

describe("normalizeQuestions", () => {
  it("fills ids, trims and coerces string/object options", () => {
    const raw: RawQuestion[] = [
      { question: " 选方案？ ", options: [{ label: "A方案" }, "B方案"], allowMultiple: true },
    ];
    expect(normalizeQuestions(raw, "q-1")).toEqual({
      kind: "questions",
      id: "q-1",
      questions: [
        {
          id: "q1",
          title: "选方案？",
          options: [
            { id: "o1", label: "A方案" },
            { id: "o2", label: "B方案" },
          ],
          allowMultiple: true,
          allowCustom: false,
        },
      ],
    });
  });

  it("keeps explicit option ids", () => {
    const raw: RawQuestion[] = [{ question: "Q", options: [{ id: "yes", label: "是" }] }];
    expect(normalizeQuestions(raw, "q-1")?.questions[0].options).toEqual([{ id: "yes", label: "是" }]);
  });

  it("appends custom option when allowCustom", () => {
    const raw: RawQuestion[] = [{ question: "Q", options: [{ label: "A" }], allowCustom: true, customLabel: "其它" }];
    const out = normalizeQuestions(raw, "q-1");
    expect(out?.questions[0].allowCustom).toBe(true);
    expect(out?.questions[0].options).toEqual([
      { id: "o1", label: "A" },
      { id: CUSTOM_OPTION_ID, label: "其它" },
    ]);
  });

  it("does not duplicate custom option when id is already __custom__", () => {
    const raw: RawQuestion[] = [
      {
        question: "Q",
        allowCustom: true,
        options: [{ id: CUSTOM_OPTION_ID, label: "已有自定义" }],
      },
    ];
    expect(normalizeQuestions(raw, "q-1")?.questions[0].options).toEqual([
      { id: CUSTOM_OPTION_ID, label: "已有自定义" },
    ]);
  });

  it("passes card-level allowExtra flags", () => {
    const raw: RawQuestion[] = [{ question: "Q", options: [{ label: "A" }] }];
    expect(
      normalizeQuestions(raw, "q-1", { allowExtra: true, allowExtraImages: false, extraPlaceholder: "备注" }),
    ).toEqual({
      kind: "questions",
      id: "q-1",
      allowExtra: true,
      allowExtraImages: false,
      extraPlaceholder: "备注",
      questions: [
        { id: "q1", title: "Q", options: [{ id: "o1", label: "A" }], allowMultiple: false, allowCustom: false },
      ],
    });
  });

  it("skips blank questions and blank options", () => {
    const raw: RawQuestion[] = [
      { question: "  ", options: [{ label: "x" }] },
      { question: "有效", options: [{ label: "  " }, { label: "ok" }] },
    ];
    const out = normalizeQuestions(raw, "q-1");
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]).toEqual({
      id: "q1",
      title: "有效",
      options: [{ id: "o1", label: "ok" }],
      allowMultiple: false,
      allowCustom: false,
    });
  });

  it("returns null when there is no valid question", () => {
    expect(normalizeQuestions([{ question: "" }], "q-1")).toBeNull();
    expect(normalizeQuestions([], "q-1")).toBeNull();
  });
});

describe("collectAnswers", () => {
  // 假 ui：select/input 各自从脚本队列依次取值，记录调用。
  function scriptedUi(selects: (string | undefined)[], inputs: (string | undefined)[] = []): AskUserUi {
    let si = 0;
    let ii = 0;
    return {
      select: async () => selects[si++],
      input: async () => inputs[ii++],
    };
  }

  it("returns the chosen label for a single-select question", async () => {
    const data = normalizeQuestions([{ question: "Q", options: [{ label: "A" }, { label: "B" }] }], "q-1")!;
    expect(await collectAnswers(data, scriptedUi(["B"]))).toBe("[我的选择]\n1. Q：B");
  });

  it("records (已跳过) when the user cancels a single-select", async () => {
    const data = normalizeQuestions([{ question: "Q", options: [{ label: "A" }] }], "q-1")!;
    expect(await collectAnswers(data, scriptedUi([undefined]))).toBe("[我的选择]\n1. Q：(已跳过)");
  });

  it("follows the custom option with a free-text input", async () => {
    const data = normalizeQuestions(
      [{ question: "Q", options: [{ label: "A" }], allowCustom: true, customLabel: "其他" }],
      "q-1",
    )!;
    expect(await collectAnswers(data, scriptedUi(["其他"], ["我的方案"]))).toBe("[我的选择]\n1. Q：其他：我的方案");
  });

  it("loops select for multi-select until the done sentinel", async () => {
    const data = normalizeQuestions(
      [{ question: "Q", options: [{ label: "A" }, { label: "B" }, { label: "C" }], allowMultiple: true }],
      "q-1",
    )!;
    expect(await collectAnswers(data, scriptedUi(["A", "C", "✓ 完成选择"]))).toBe("[我的选择]\n1. Q：A、C");
  });

  it("uses free-text input when a question has no options", async () => {
    const data = normalizeQuestions([{ question: "叫什么" }], "q-1")!;
    expect(await collectAnswers(data, scriptedUi([], ["小明"]))).toBe("[我的选择]\n1. 叫什么：小明");
  });

  it("appends the supplementary note when allowExtra", async () => {
    const data = normalizeQuestions([{ question: "Q", options: [{ label: "A" }] }], "q-1", {
      allowExtra: true,
      extraPlaceholder: "备注",
    })!;
    expect(await collectAnswers(data, scriptedUi(["A"], ["看截图"]))).toBe("[我的选择]\n1. Q：A\n补充说明：看截图");
  });
});
