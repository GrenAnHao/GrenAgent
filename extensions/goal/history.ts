import { readGoalEvent } from "./fold.js";
import type { GoalEventKind } from "./types.js";

export type GoalHistoryEventItem = {
  source: "event";
  kind: GoalEventKind;
  goalId: string;
  revision: number;
  at: string;
  payload: Record<string, unknown>;
};

export type GoalHistoryRoundItem = {
  source: "round";
  goalId: string;
  revision: number;
  round: number;
  content?: string;
};

export type GoalHistoryItem = GoalHistoryEventItem | GoalHistoryRoundItem;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function firstPositiveInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

function readGoalRoundItem(entry: unknown): GoalHistoryRoundItem | undefined {
  const record = asRecord(entry);
  if (!record || record.customType !== "goal-round") return undefined;
  const data = asRecord(record.data);
  const details = asRecord(record.details);
  const goalId = firstString(details?.goalId, data?.goalId);
  const revision = firstPositiveInt(details?.revision, data?.revision);
  const round = firstPositiveInt(details?.round, data?.round);
  if (!goalId || revision === undefined || round === undefined) return undefined;
  const content = firstString(record.content, data?.content, details?.content);
  return content === undefined
    ? { source: "round", goalId, revision, round }
    : { source: "round", goalId, revision, round, content };
}

export function listGoalHistory(entries: unknown[]): GoalHistoryItem[] {
  const items: GoalHistoryItem[] = [];
  for (const entry of entries) {
    const event = readGoalEvent(entry);
    if (event) {
      items.push({
        source: "event",
        kind: event.kind,
        goalId: event.goalId,
        revision: event.revision,
        at: event.at,
        payload: event.payload,
      });
      continue;
    }
    const round = readGoalRoundItem(entry);
    if (round) items.push(round);
  }
  return items;
}
