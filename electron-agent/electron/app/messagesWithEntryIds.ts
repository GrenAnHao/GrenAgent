/**
 * 把 sessionManager.buildSessionProjection() 的条目 id 贴到每条投影消息上，
 * 供 agent_get_messages 返回，作为 truncateTo / 编辑 / 回退的定位键。
 */

export type ProjectedSessionEntryLike = {
  sourceEntry: { id: string };
  messages: Array<Record<string, unknown>>;
};

export type SessionProjectionLike = {
  entries: ProjectedSessionEntryLike[];
};

export function messagesWithEntryIds(
  projection: SessionProjectionLike,
): Array<Record<string, unknown> & { entryId: string }> {
  return projection.entries.flatMap((entry) =>
    entry.messages.map((message) => ({ ...message, entryId: entry.sourceEntry.id })),
  );
}
