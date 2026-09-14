import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyTodo, emptyTodoState, reconstructFromEntries, type TodoDetails, type TodoState } from "./todo.js";

const TodoParams = Type.Object({
  todos: Type.Array(Type.Object({
    id: Type.Optional(Type.Number({ description: "Existing item id; omit to allocate" })),
    text: Type.String({ description: "Todo text" }),
    status: StringEnum(["pending", "in_progress", "completed"] as const),
  })),
});

export default function (pi: ExtensionAPI) {
  let state: TodoState = emptyTodoState();

  // getBranch() 返回 SessionEntry[]；reconstructFromEntries 只读取 type/message 子集。
  const reconstruct = (ctx: ExtensionContext) => {
    state = reconstructFromEntries(ctx.sessionManager.getBranch());
  };
  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Replace the entire todo list on each call. Submit the full list every time; mark active work in_progress (multiple allowed for parallel tasks); mark completed as soon as a step finishes. Skip the tool for trivial single-step work.",
    promptGuidelines: [
      "Submit the complete todo list on every todo tool call; never partial updates.",
      "Mark the step you are working on as in_progress; you may mark multiple items in_progress when working in parallel.",
      "Mark items completed immediately when finished; do not leave stale in_progress entries.",
      "Do not use the todo tool for trivial single-step tasks that need no tracking.",
    ],
    parameters: TodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = applyTodo(state, params);
      if (!result.error) state = result.state;
      const details: TodoDetails = {
        todos: result.state.todos,
        nextId: result.state.nextId,
        error: result.error,
      };
      return {
        content: [{ type: "text", text: result.message }],
        details,
      };
    },
  });
}
