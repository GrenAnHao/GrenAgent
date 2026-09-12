import {
  DEFAULT_MAX_ROUNDS,
  GOAL_EVENT_KINDS,
  type GoalEvent,
  type GoalEventKind,
  type GoalSnapshot,
} from "./types.js";

export function isGoalEventKind(value: unknown): value is GoalEventKind {
  return typeof value === "string" && (GOAL_EVENT_KINDS as readonly string[]).includes(value);
}

export function readGoalEvent(entry: unknown): GoalEvent | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (record.type !== "custom" || record.customType !== "goal") return undefined;
  const data = record.data;
  if (!data || typeof data !== "object") return undefined;
  const event = data as Record<string, unknown>;
  if (!isGoalEventKind(event.kind)) return undefined;
  if (typeof event.goalId !== "string" || event.goalId === "") return undefined;
  if (typeof event.revision !== "number" || !Number.isInteger(event.revision) || event.revision <= 0) return undefined;
  const payload = event.payload;
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) return undefined;
  return {
    kind: event.kind,
    goalId: event.goalId,
    revision: event.revision,
    at: typeof event.at === "string" ? event.at : "",
    payload: (payload ?? {}) as Record<string, unknown>,
  };
}

function parseMaxRounds(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_ROUNDS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return DEFAULT_MAX_ROUNDS;
  return value;
}

function parseCondition(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 4000) return undefined;
  return trimmed;
}

function applyEvent(snapshot: GoalSnapshot | undefined, event: GoalEvent): GoalSnapshot | undefined {
  switch (event.kind) {
    case "create": {
      if (snapshot !== undefined) return snapshot;
      const condition = parseCondition(event.payload.condition);
      if (!condition) return snapshot;
      return {
        goalId: event.goalId,
        revision: event.revision,
        condition,
        status: "active",
        roundsStarted: 0,
        maxRounds: parseMaxRounds(event.payload.maxRounds),
        createdAt: event.at,
        updatedAt: event.at,
      };
    }
    case "edit": {
      if (!snapshot) return snapshot;
      const condition = parseCondition(event.payload.condition);
      if (!condition) return snapshot;
      return {
        ...snapshot,
        revision: event.revision,
        condition,
        updatedAt: event.at,
      };
    }
    case "pause": {
      if (!snapshot || snapshot.status !== "active") return snapshot;
      return {
        ...snapshot,
        revision: event.revision,
        status: "paused",
        updatedAt: event.at,
      };
    }
    case "resume": {
      if (!snapshot || (snapshot.status !== "paused" && snapshot.status !== "blocked")) return snapshot;
      const { blockedReason: _, ...rest } = snapshot;
      return {
        ...rest,
        revision: event.revision,
        status: "active",
        updatedAt: event.at,
      };
    }
    case "complete": {
      if (!snapshot || snapshot.status !== "active") return snapshot;
      return {
        ...snapshot,
        revision: event.revision,
        status: "complete",
        updatedAt: event.at,
      };
    }
    case "blocked": {
      if (!snapshot || snapshot.status !== "active") return snapshot;
      const message = event.payload.message;
      if (typeof message !== "string" || message.trim() === "") return snapshot;
      return {
        ...snapshot,
        revision: event.revision,
        status: "blocked",
        blockedReason: { code: "model-reported", message },
        updatedAt: event.at,
      };
    }
    case "clear":
      return undefined;
    case "round": {
      if (!snapshot) return snapshot;
      const round = Number(event.payload.round);
      if (!Number.isInteger(round) || round < 1) return snapshot;
      return {
        ...snapshot,
        revision: event.revision,
        roundsStarted: round,
        updatedAt: event.at,
      };
    }
    default:
      return snapshot;
  }
}

function applyEpoch(epoch: GoalEvent[]): GoalSnapshot | undefined {
  // Per-epoch revision sort only: clear/complete reset the lifecycle so revision may
  // restart at 1; a global sort would mis-order create-after-complete vs complete.
  const sorted = [...epoch].sort((a, b) => a.revision - b.revision);
  let next: GoalSnapshot | undefined;
  for (const event of sorted) {
    if (event.kind === "clear") {
      next = undefined;
    } else {
      next = applyEvent(next, event);
    }
  }
  return next;
}

function endsEpoch(event: GoalEvent): boolean {
  return event.kind === "clear" || event.kind === "complete";
}

function foldEpochResults(epochs: GoalEvent[][]): GoalSnapshot | undefined {
  let snapshot: GoalSnapshot | undefined;
  for (const epoch of epochs) {
    const folded = applyEpoch(epoch);
    if (folded !== undefined) {
      snapshot = folded;
      continue;
    }
    if (epoch.some((event) => event.kind === "clear")) {
      snapshot = undefined;
    }
  }
  return snapshot;
}

export function foldGoal(entries: unknown[]): GoalSnapshot | undefined {
  const events: GoalEvent[] = [];
  for (const entry of entries) {
    const event = readGoalEvent(entry);
    if (event) events.push(event);
  }

  const epochs: GoalEvent[][] = [];
  let epoch: GoalEvent[] = [];
  for (const event of events) {
    epoch.push(event);
    if (endsEpoch(event)) {
      epochs.push(epoch);
      epoch = [];
    }
  }
  if (epoch.length > 0) {
    epochs.push(epoch);
  }
  return foldEpochResults(epochs);
}
