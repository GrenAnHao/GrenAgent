import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyTodo, closeTodosInContext, emptyTodoState, reconstructFromEntries, type TodoDetails, type TodoState } from "./todo.js";

const TodoParams = Type.Object({
  todos: Type.Array(Type.Object({
    id: Type.Optional(Type.Number({ description: "Existing item id; omit to allocate" })),
    text: Type.String({ description: "Todo text" }),
    status: Type.String({ description: "pending, in_progress, or completed. done is accepted as completed." }),
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
  pi.on("context", async (event) => {
    const messages = closeTodosInContext(event.messages);
    return messages ? { messages } : undefined;
  });

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Replace the entire todo list on each call. Submit the full list every time; mark active work in_progress (multiple allowed for parallel tasks); mark completed as soon as a step finishes. Skip the tool for trivial single-step work.",
    promptSnippet: "Replace the full todo list.",
    promptGuidelines: [
      "Submit the complete todo list on every todo tool call; never partial updates.",
      "Mark the step you are working on as in_progress; you may mark multiple items in_progress when working in parallel.",
      "Use todo to mark a finished step completed immediately; done is accepted as completed. When no item is still pending, mark every in_progress item completed before the final reply. After the list is fully completed, the next user turn starts empty; do not resubmit that finished list.",
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
