import { describe, expect, it } from "vitest";
import {
  CUSTOM_OPTION_ID,
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

  it("caps questions at 8", () => {
    const raw: RawQuestion[] = Array.from({ length: 11 }, (_, i) => ({
      question: `Q${i + 1}`,
      options: [{ label: "x" }],
    }));
    const out = normalizeQuestions(raw, "q-1");
    expect(out?.questions).toHaveLength(8);
    expect(out?.questions[7].title).toBe("Q8");
  });
});

