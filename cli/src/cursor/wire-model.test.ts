import assert from "node:assert/strict";
import test from "node:test";
import { cursorRequestResumes } from "./resume.ts";
import { resolveCursorWireModelId } from "./wire-model.ts";

test("下一条用户消息不使用 resume，流中途重试才使用", () => {
  assert.equal(cursorRequestResumes("user-turn"), false);
  assert.equal(cursorRequestResumes("in-stream-retry"), true);
});

test("显式档位覆盖 id 后缀，关闭思考不带 effort", () => {
  const model = {
    id: "gpt-5.4",
    requestModelId: "gpt-5.4",
    thinking: {
      efforts: ["low", "medium", "high", "xhigh"],
      effortRouting: {
        off: "gpt-5.4",
        low: "gpt-5.4-low",
        medium: "gpt-5.4",
        high: "gpt-5.4-high",
        xhigh: "gpt-5.4-xhigh",
      },
    },
  };
  assert.equal(resolveCursorWireModelId(model, "high"), "gpt-5.4-high");
  assert.equal(resolveCursorWireModelId(model, "low", "gpt-5.4-high"), "gpt-5.4-low");
  assert.equal(resolveCursorWireModelId(model, "off"), "gpt-5.4");
});

test("显式 off 覆盖 requestedId 上的 high 后缀", () => {
  const model = {
    id: "gpt-5.4",
    requestModelId: "gpt-5.4",
    thinking: {
      efforts: ["low", "medium", "high", "xhigh"],
      effortRouting: {
        off: "gpt-5.4-no-think",
        low: "gpt-5.4-low",
        high: "gpt-5.4-high",
        xhigh: "gpt-5.4-xhigh",
      },
    },
  };
  assert.equal(resolveCursorWireModelId(model, "off", "gpt-5.4-high"), "gpt-5.4-no-think");
});

test("超出阶梯的档位夹到该模型最高档", () => {
  const model = {
    id: "gpt-5.4",
    requestModelId: "gpt-5.4",
    thinking: {
      efforts: ["low", "medium", "high", "xhigh"],
      effortRouting: { off: "gpt-5.4", high: "gpt-5.4-high", xhigh: "gpt-5.4-xhigh" },
    },
  };
  assert.equal(resolveCursorWireModelId(model, "max"), "gpt-5.4-xhigh");
});
