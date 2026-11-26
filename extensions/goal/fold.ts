import {
  DEFAULT_MAX_ROUNDS,
  GOAL_EVENT_KINDS,
  type GoalEvent,
  type GoalEventKind,
  type GoalSnapshot,
  type GoalPauseReason,
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

function parseAt(at: string): number | undefined {
  const value = Date.parse(at);
  return Number.isFinite(value) ? value : undefined;
}

function freezeRun(snapshot: GoalSnapshot, at: string): Pick<GoalSnapshot, "ranMs"> {
  const start = snapshot.runStartedAt ? parseAt(snapshot.runStartedAt) : undefined;
  const end = parseAt(at);
  const extra = start !== undefined && end !== undefined ? Math.max(0, end - start) : 0;
  return { ranMs: (snapshot.ranMs ?? 0) + extra };
}

function pauseReason(payload: Record<string, unknown>): GoalPauseReason {
  const value = payload.pauseReason;
  const reason = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const code = reason.code;
  if (code === "request-error" || code === "runtime-error" || code === "max-rounds" || code === "user") {
    return { code, ...(typeof reason.message === "string" ? { message: reason.message.slice(0, 240) } : {}) };
  }
  // Older pauses were manual and had no structured reason.
  return { code: "user" };
}

function applyEvent(snapshot: GoalSnapshot | undefined, event: GoalEvent): GoalSnapshot | undefined {
  if (event.kind !== "create" && (!snapshot || event.goalId !== snapshot.goalId || event.revision <= snapshot.revision)) return snapshot;
  switch (event.kind) {
    case "create": {
      if (snapshot !== undefined && snapshot.status !== "complete") return snapshot;
      const condition = parseCondition(event.payload.condition);
      if (!condition) return snapshot;
      return {
        goalId: event.goalId,
        revision: event.revision,
        condition,
        status: "active",
        roundsStarted: 0,
        runNumber: 1,
        runRoundsStarted: 0,
        conditionRevision: 1,
        maxRounds: parseMaxRounds(event.payload.maxRounds),
        createdAt: event.at,
        updatedAt: event.at,
        ranMs: 0,
        runStartedAt: event.at,
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
        conditionRevision: snapshot.conditionRevision + (condition === snapshot.condition ? 0 : 1),
        updatedAt: event.at,
      };
    }
    case "pause": {
      if (!snapshot || (snapshot.status !== "active" && snapshot.status !== "paused")) return snapshot;
      if (snapshot.status === "paused") return { ...snapshot, revision: event.revision, updatedAt: event.at };
      const { runStartedAt: _, ...rest } = snapshot;
      return {
        ...rest,
        revision: event.revision,
        status: "paused",
        pauseReason: pauseReason(event.payload),
        updatedAt: event.at,
        ...freezeRun(snapshot, event.at),
      };
    }
    case "resume": {
      if (!snapshot || snapshot.status === "complete") return snapshot;
      if (snapshot.status === "active") return { ...snapshot, revision: event.revision, updatedAt: event.at };
      const { blockedReason: _, pauseReason: _pause, ...rest } = snapshot;
      return {
        ...rest,
        revision: event.revision,
        status: "active",
        updatedAt: event.at,
        ranMs: snapshot.ranMs ?? 0,
        runStartedAt: event.at,
      };
    }
    case "restart": {
      if (!snapshot || snapshot.status === "complete" || snapshot.runRoundsStarted < snapshot.maxRounds) return snapshot;
      if (event.payload.runNumber !== snapshot.runNumber + 1) return snapshot;
      const { blockedReason: _, pauseReason: _pause, ...rest } = snapshot;
      return {
        ...rest,
        revision: event.revision,
        status: "active",
        runNumber: snapshot.runNumber + 1,
        runRoundsStarted: 0,
        updatedAt: event.at,
        ...freezeRun(snapshot, event.at),
        runStartedAt: event.at,
      };
    }
    case "complete": {
      if (!snapshot || snapshot.status !== "active") return snapshot;
      const { runStartedAt: _, ...rest } = snapshot;
      return {
        ...rest,
        revision: event.revision,
        status: "complete",
        updatedAt: event.at,
        ...freezeRun(snapshot, event.at),
      };
    }
    case "blocked": {
      if (!snapshot || snapshot.status !== "active") return snapshot;
      const message = event.payload.message;
      if (typeof message !== "string" || message.trim() === "") return snapshot;
      const { runStartedAt: _, ...rest } = snapshot;
      return {
        ...rest,
        revision: event.revision,
        status: "blocked",
        blockedReason: { code: "model-reported", message },
        updatedAt: event.at,
        ...freezeRun(snapshot, event.at),
      };
    }
    case "clear":
      return undefined;
    case "round": {
      if (!snapshot || snapshot.status !== "active") return snapshot;
      const round = Number(event.payload.round);
      if (!Number.isSafeInteger(round) || round <= snapshot.roundsStarted) return snapshot;
      if (event.payload.runNumber !== undefined && event.payload.runNumber !== snapshot.runNumber) return snapshot;
      // Legacy events store the cumulative round; retain that meaning even if
      // an imported history starts with a later round rather than round one.
      const runRound = snapshot.runRoundsStarted + round - snapshot.roundsStarted;
      if (event.payload.runRound !== undefined && event.payload.runRound !== runRound) return snapshot;
      return {
        ...snapshot,
        revision: event.revision,
        roundsStarted: round,
        runRoundsStarted: runRound,
        updatedAt: event.at,
      };
    }
    default:
      return snapshot;
  }
}

function applyEpoch(epoch: GoalEvent[], seed: GoalSnapshot | undefined): GoalSnapshot | undefined {
  // Per-epoch revision sort only: clear/complete reset the lifecycle so revision may
  // restart at 1; a global sort would mis-order create-after-complete vs complete.
  const sorted = [...epoch].sort((a, b) => a.revision - b.revision);
  let next = seed;
  for (const event of sorted) {
    next = applyEvent(next, event);
  }
  return next;
}

function endsEpoch(event: GoalEvent): boolean {
  return event.kind === "clear" || event.kind === "complete";
}

function foldEpochResults(epochs: GoalEvent[][]): GoalSnapshot | undefined {
  let snapshot: GoalSnapshot | undefined;
  for (const epoch of epochs) {
    const folded = applyEpoch(epoch, snapshot);
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
