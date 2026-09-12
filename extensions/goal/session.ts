import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readAutoContinueOnOpen } from "./config.js";
import { foldGoal } from "./fold.js";
import type { GoalActivation, GoalEvent, GoalSnapshot } from "./types.js";

const activations = new Map<string, GoalActivation>();

type SessionManager = {
  getEntries?: () => unknown[];
  getSessionId?: () => string | undefined;
};

function sessionManager(ctx: ExtensionContext): SessionManager {
  return ctx.sessionManager as SessionManager;
}

export function sessionIdOf(ctx: ExtensionContext): string {
  const sessionId = sessionManager(ctx).getSessionId?.();
  if (!sessionId) throw new Error("SESSION_NOT_BOUND");
  return sessionId;
}

export function readSnapshot(ctx: ExtensionContext): GoalSnapshot | undefined {
  return foldGoal(sessionManager(ctx).getEntries?.() ?? []);
}

export function getActivation(sessionId: string): GoalActivation {
  return activations.get(sessionId) ?? "disarmed";
}

export function setActivation(sessionId: string, activation: GoalActivation): void {
  activations.set(sessionId, activation);
}

export function nextRevision(snapshot: GoalSnapshot | undefined): number {
  return snapshot ? snapshot.revision + 1 : 1;
}

export function newGoalId(): string {
  return crypto.randomUUID();
}

export function writeEvent(pi: ExtensionAPI, ctx: ExtensionContext, event: GoalEvent): GoalSnapshot | undefined {
  pi.appendEntry("goal", event);
  return readSnapshot(ctx);
}

export type StatusSnapshot = (GoalSnapshot & { activation: GoalActivation }) | null;

export function currentStatusSnapshot(ctx: ExtensionContext): StatusSnapshot {
  const snapshot = readSnapshot(ctx);
  if (!snapshot) return null;
  return { ...snapshot, activation: getActivation(sessionIdOf(ctx)) };
}

export function pushStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("goal", JSON.stringify({
    schemaVersion: 1,
    sessionId: sessionIdOf(ctx),
    workspace: ctx.cwd,
    snapshot: currentStatusSnapshot(ctx),
    history: [],
  }));
}

function eventAt(): string {
  return new Date().toISOString();
}

function writeKind(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  kind: GoalEvent["kind"],
  snapshot: GoalSnapshot,
  payload: Record<string, unknown> = {},
): GoalSnapshot | undefined {
  return writeEvent(pi, ctx, {
    kind,
    goalId: snapshot.goalId,
    revision: nextRevision(snapshot),
    at: eventAt(),
    payload,
  });
}

export function createGoal(pi: ExtensionAPI, ctx: ExtensionContext, condition: string): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (current && current.status !== "complete") {
    throw new Error("GOAL_ALREADY_ACTIVE");
  }
  writeEvent(pi, ctx, {
    kind: "create",
    goalId: newGoalId(),
    revision: 1,
    at: eventAt(),
    payload: { condition },
  });
  setActivation(sessionIdOf(ctx), "armed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function editGoal(pi: ExtensionAPI, ctx: ExtensionContext, condition: string): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  writeKind(pi, ctx, "edit", current, { condition });
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function pauseGoal(pi: ExtensionAPI, ctx: ExtensionContext): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  writeKind(pi, ctx, "pause", current);
  setActivation(sessionIdOf(ctx), "disarmed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function resumeGoal(pi: ExtensionAPI, ctx: ExtensionContext): GoalSnapshot {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  if (current.status === "paused" || current.status === "blocked") {
    writeKind(pi, ctx, "resume", current);
  }
  setActivation(sessionIdOf(ctx), "armed");
  const snapshot = readSnapshot(ctx);
  if (!snapshot) throw new Error("GOAL_WRITE_FAILED");
  pushStatus(ctx);
  return snapshot;
}

export function clearGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const current = readSnapshot(ctx);
  if (!current) throw new Error("GOAL_MISSING");
  writeKind(pi, ctx, "clear", current);
  pushStatus(ctx);
}

export function onSessionStart(ctx: ExtensionContext): void {
  const snapshot = readSnapshot(ctx);
  const armed = readAutoContinueOnOpen() && snapshot?.status === "active";
  setActivation(sessionIdOf(ctx), armed ? "armed" : "disarmed");
  pushStatus(ctx);
}
