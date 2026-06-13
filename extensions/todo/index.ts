import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyTodo, emptyTodoState, reconstructFromEntries, type TodoDetails, type TodoState } from "./todo.js";

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

export default function (pi: ExtensionAPI) {
  let state: TodoState = emptyTodoState();

  // getBranch() 返回 SessionEntry[]；reconstructFromEntries 只读取 type/message 子集。
  const reconstruct = (ctx: ExtensionContext) => {
    state = reconstructFromEntries(ctx.sessionManager.getBranch() as never);
  };
  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Manage a todo list. Actions: list, add (text), toggle (id), clear. Use to track multi-step work.",
    promptGuidelines: [
      "Maintain a todo list with the todo tool for multi-step tasks: add steps, toggle them done as you finish.",
    ],
    parameters: TodoParams,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = applyTodo(state, params);
      state = result.state;
      const details: TodoDetails = {
        action: params.action,
        todos: result.state.todos,
        nextId: result.state.nextId,
        error: result.error,
      };
      return { content: [{ type: "text", text: result.message }], details };
    },
  });
}
