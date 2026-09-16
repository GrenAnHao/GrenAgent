# Lobe Chat Stack Design

**Date:** 2026-06-12
**Scope:** `tauri-agent` chat UI only
**Decision:** Use Lobe UI's chat component stack for the primary chat surface.

## Problem

The current Hermes chat UI depends on `@lobehub/ui`, but the chat surface is assembled from low-level pieces instead of the Lobe UI chat stack. The visible failure is severe: the input placeholder renders vertically because `ChatInputAreaInner` is wrapped in a custom flex/layout structure that collapses the inner input width.

Evidence:

- `tauri-agent/src/features/chat/ChatInput.tsx` manually combines `ChatInputAreaInner`, `ChatSendButton`, `Flexbox`, inline absolute positioning, and an extra `inputWrap`.
- `tauri-agent/src/features/chat/MessageList.tsx` manually maps messages to custom `UserMessage`, `AssistantMessage`, and `ToolExecution` components instead of using `ChatList`.
- `@lobehub/ui@5.15.13` exports `ChatList`, `ChatInputArea`, `ChatHeader`, `BackBottom`, `LoadingDots`, `TokenTag`, and chat message types from `@lobehub/ui/chat`.
- Desktop and narrow viewport screenshots show the composer collapsing, while `pnpm build` still passes. This means the issue is component composition/layout, not TypeScript build failure.

## Goal

Replace the hand-assembled chat core with Lobe UI's standard chat components:

- `ChatList` for the visible message stream.
- `ChatInputArea` for the composer.
- Minimal adapter code between Hermes agent state and Lobe UI `ChatMessage`.

The change should fix the broken input layout and make the UI match the Lobe UI chat model without expanding scope into a full app redesign.

## Non-Goals

- Do not redesign the session sidebar, context panel, or dock panel.
- Do not add new model/settings workflows.
- Do not solve the fixed-width mobile sidebar in this pass, except to verify that the chat composer itself no longer collapses.
- Do not introduce a separate Hermes UI abstraction library.
- Do not refactor Pi agent event handling unless required for the chat adapter.

## Assumptions

- `@lobehub/ui@5.15.13` remains the target version for this pass.
- Hermes' internal `ChatMessage` union in `tauri-agent/src/stores/agentReducer.ts` remains the source of truth.
- Tool execution messages can remain custom rendered, because Lobe UI `ChatMessage.role` is LLM-oriented and does not directly model Hermes tool events.
- The app runs primarily inside Tauri, but browser-based Vite screenshots are acceptable for layout verification.

## Proposed Architecture

### Chat Container

`ChatView.tsx` remains the owner of send/abort behavior. It should render a single full-height chat column:

1. Message stream area.
2. Composer area.

The container should avoid absolute positioning for the composer. Lobe UI `ChatInputArea` should receive normal block/flex layout space so its own sizing logic can work.

### Message Adapter

Create a small adapter function near the chat feature, for example:

```ts
function toLobeMessages(messages: HermesChatMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.kind === 'user' || message.kind === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.kind === 'user' ? 'user' : 'assistant',
      content: message.text,
    }));
}
```

The adapter should stay simple. It should not alter agent state or invent new message semantics.

### Message Rendering

Use `ChatList` with `variant="bubble"` for the main stream.

Assistant thinking can be rendered as message extra content for assistant messages. Tool calls can be rendered below the nearest assistant message only if that mapping already exists; otherwise tool execution blocks can remain in chronological order below the `ChatList` in the same scroll area for this pass.

Recommended first implementation:

- Use `ChatList` for user and assistant text.
- Render Hermes tool messages as `ToolExecution` blocks in the same scroll container after mapping, preserving current chronological order as much as possible.
- Defer advanced grouping until the core layout is stable.

### Composer

Replace the current manual composer with `ChatInputArea`.

The local input state remains in `ChatInput.tsx`. Sending behavior stays the same:

- Trim input.
- Ignore empty input.
- Clear local input on send.
- Call `onSend(text)`.
- If streaming, send button should expose stop behavior through `onStop`.

Use Lobe UI props instead of custom inner wrappers:

```tsx
<ChatInputArea
  value={value}
  loading={isStreaming}
  placeholder="Type a message..."
  onInput={setValue}
  onSend={handleSend}
  bottomAddons={...}
/>
```

If `ChatInputArea` requires height constraints, pass its documented `heights` prop rather than wrapping `ChatInputAreaInner` in a custom absolute card.

### Styles

Move chat layout styles into `antd-style` or colocated component styles, matching the current project pattern in `src/theme/index.ts` and panel components.

Remove only styles made obsolete by this change. Existing unrelated dead CSS should be left alone unless it directly conflicts with the chat layout.

### Theme

Keep the existing top-level `ThemeProvider themeMode="dark"` in `App.tsx`.

Do not add a second nested theme provider inside chat.

If Lobe UI motion behavior breaks during verification, add the minimal provider/configuration required by the installed package after confirming with the local type definitions.

## Files

Expected files to modify during implementation:

- `tauri-agent/src/features/chat/ChatView.tsx`
- `tauri-agent/src/features/chat/ChatInput.tsx`
- `tauri-agent/src/features/chat/MessageList.tsx`
- Optional: `tauri-agent/src/features/chat/messageAdapter.ts`
- Optional tests: `tauri-agent/src/features/chat/messageAdapter.test.ts`

Files not expected to change:

- `tauri-agent/src/stores/agentReducer.ts`
- `tauri-agent/src/lib/pi.ts`
- `tauri-agent/src/features/sessions/SessionList.tsx`
- `tauri-agent/src/features/context/ContextPanel.tsx`
- `tauri-agent/src/features/dock/DockPanel.tsx`

## Validation

Implementation is complete when all of these pass:

1. `pnpm build` succeeds.
2. Desktop screenshot at `1440x900` shows:
   - Composer text flows horizontally.
   - Send/stop control is visible.
   - Message area and composer do not overlap.
3. Narrow screenshot around `390x844` shows:
   - Composer itself does not collapse into vertical text.
   - No incoherent overlap inside the chat composer.
4. Existing agent store/reducer tests still pass if they are run as part of the touched surface.

## Risks

- `ChatList` may not support Hermes tool messages directly. Mitigation: adapt only user/assistant messages to `ChatList` and keep `ToolExecution` custom.
- `ChatInputArea` may include its own panel sizing behavior. Mitigation: pass documented height constraints and avoid external absolute positioning.
- The fixed sidebar remains bad on narrow screens. Mitigation: record it as a separate layout task; do not mix it into the chat stack migration.
- Bundle size warnings may remain after this pass. Mitigation: treat chunk optimization as follow-up because it is not the direct cause of the broken UI.

## Recommended Path

Implement the migration in small steps:

1. Add and test the message adapter.
2. Replace `MessageList` with `ChatList` while preserving custom tool rendering.
3. Replace `ChatInputAreaInner` composition with `ChatInputArea`.
4. Remove only conflicting composer/list styles.
5. Run build and screenshot verification.

