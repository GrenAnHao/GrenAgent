import { describe, expect, it } from "vitest";
import {
  CUSTOM_OPTION_ID,
  countValidQuestions,
  decodeAskUserAnswer,
  MAX_QUESTIONS,
  makeQuestionsId,
  normalizeQuestions,
  truncationNotice,
  type RawQuestion,
} from "./questions.ts";

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
            { id: CUSTOM_OPTION_ID, label: "其他（自定义）" },
          ],
          allowMultiple: true,
          allowCustom: true,
        },
      ],
    });
  });

  it("keeps explicit option ids", () => {
    const raw: RawQuestion[] = [{ question: "Q", options: [{ id: "yes", label: "是" }] }];
    expect(normalizeQuestions(raw, "q-1")?.questions[0].options).toEqual([
      { id: "yes", label: "是" },
      { id: CUSTOM_OPTION_ID, label: "其他（自定义）" },
    ]);
  });

  it("keeps a truly closed question without a custom choice", () => {
    const question = normalizeQuestions([{ question: "批准？", options: [{ id: "yes", label: "通过" }], allowCustom: false }], "q-1")?.questions[0];
    expect(question?.allowCustom).toBe(false);
    expect(question?.options).toEqual([{ id: "yes", label: "通过" }]);
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

  it("prepends a closed visual review with stable outcome IDs and no preselection", () => {
    const out = normalizeQuestions([{ question: "方案？", options: [{ id: "a", label: "A" }] }], "q-1", {
      visualReview: { previewId: "preview-1" }, allowExtra: true,
    });
    expect(out?.visualReview).toEqual({ previewId: "preview-1" });
    expect(out?.questions[0]).toEqual({ id: "visual-review", title: "这版视觉产出是否通过评审？", options: [
      { id: "approve", label: "通过" }, { id: "redo", label: "打回重做" },
    ], allowMultiple: false, allowCustom: false });
    expect(out?.questions[1].options).toContainEqual({ id: CUSTOM_OPTION_ID, label: "其他（自定义）" });
    expect(out?.allowExtra).toBe(true);
    expect(out).not.toHaveProperty("selected");
  });

  it("always offers a review supplement even when the caller explicitly disables it", () => {
    const out = normalizeQuestions([], "q-review", { visualReview: { previewId: "preview-review" }, allowExtra: false });
    expect(out).toMatchObject({ allowExtra: true, allowExtraImages: true });
    expect(out?.questions[0].allowCustom).toBe(false);
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
        { id: "q1", title: "Q", options: [{ id: "o1", label: "A" }, { id: CUSTOM_OPTION_ID, label: "其他（自定义）" }], allowMultiple: false, allowCustom: true },
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
      options: [{ id: "o1", label: "ok" }, { id: CUSTOM_OPTION_ID, label: "其他（自定义）" }],
      allowMultiple: false,
      allowCustom: true,
    });
  });

  it("returns null when there is no valid question", () => {
    expect(normalizeQuestions([{ question: "" }], "q-1")).toBeNull();
    expect(normalizeQuestions([], "q-1")).toBeNull();
  });

  it("keeps 11 questions (regression: used to cut at 8 silently)", () => {
    const raw: RawQuestion[] = Array.from({ length: 11 }, (_, i) => ({
      question: `Q${i + 1}`,
      options: [{ label: "x" }],
    }));
    const out = normalizeQuestions(raw, "q-1");
    expect(out?.questions).toHaveLength(11);
    expect(out?.questions[10].title).toBe("Q11");
    expect(truncationNotice(countValidQuestions(raw))).toBeUndefined();
  });

  it("caps at MAX_QUESTIONS and says which questions were dropped", () => {
    const raw: RawQuestion[] = Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({
      question: `Q${i + 1}`,
      options: [{ label: "x" }],
    }));
    const out = normalizeQuestions(raw, "q-1");
    expect(out?.questions).toHaveLength(MAX_QUESTIONS);
    const notice = truncationNotice(countValidQuestions(raw));
    expect(notice).toContain(`第 ${MAX_QUESTIONS + 1}–${MAX_QUESTIONS + 3} 题`);
    expect(notice).toContain("ask_user");
  });

  it("counts only non-blank questions toward the cap", () => {
    expect(countValidQuestions([{ question: "a" }, { question: "  " }, {}])).toBe(1);
  });
});

describe("decodeAskUserAnswer", () => {
  it("keeps plain [我的选择] text", () => {
    expect(decodeAskUserAnswer("[我的选择]\n1. T：乙")).toEqual({
      text: "[我的选择]\n1. T：乙",
      images: [],
    });
  });

  it("unpacks the vision envelope into image content parts", () => {
    expect(
      decodeAskUserAnswer(
        JSON.stringify({
          __askUserAnswer: 1,
          text: "[我的选择]\n1. T：乙\n补充说明：看图",
          images: [{ mimeType: "image/png", data: "abc" }],
        }),
      ),
    ).toEqual({
      text: "[我的选择]\n1. T：乙\n补充说明：看图",
      images: [{ type: "image", mimeType: "image/png", data: "abc" }],
    });
  });
});

