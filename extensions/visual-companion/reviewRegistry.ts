import { randomUUID } from "node:crypto";

export type ReviewOutcome = "pending" | "approved" | "redo" | "cancelled" | "superseded";
export interface VisualReviewRecord {
  previewId: string;
  owner: string;
  outcome: ReviewOutcome;
  requestId?: string;
}

const REGISTRY = Symbol.for("gren.visual-review.registry.v1");
const globalRegistry = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, VisualReviewRecord> };
const records = globalRegistry[REGISTRY] ??= new Map<string, VisualReviewRecord>();
const pendingDismissals = new Map<string, () => void>();

export function visualReviewOwner(ctx: { sessionManager: { getSessionFile?: () => string | undefined; getSessionId?: () => string | undefined } }): string {
  return ctx.sessionManager.getSessionFile?.() || ctx.sessionManager.getSessionId?.() || "";
}

export function publishVisualReview(owner: string, previewId: string = randomUUID()): VisualReviewRecord {
  if (!owner) throw new Error("VISUAL_REVIEW_OWNER: 当前会话没有可验证的身份");
  for (const record of records.values()) {
    if (record.owner === owner && record.outcome === "pending") {
      record.outcome = "superseded";
      pendingDismissals.get(record.previewId)?.();
      pendingDismissals.delete(record.previewId);
    }
  }
  const record: VisualReviewRecord = { previewId, owner, outcome: "pending" };
  records.set(previewId, record);
  return record;
}

export function getVisualReview(previewId: string): VisualReviewRecord | undefined {
  return records.get(previewId);
}

/** Only the bound request may settle this preview; a new publication supersedes old requests. */
export function settleVisualReview(owner: string, previewId: string, requestId: string, outcome: "approved" | "redo" | "cancelled"): VisualReviewRecord {
  const record = records.get(previewId);
  if (!record || record.owner !== owner || record.outcome === "superseded") throw new Error("VISUAL_REVIEW_STALE: 产出已被替换或不属于本会话");
  if (record.requestId && record.requestId !== requestId) throw new Error("VISUAL_REVIEW_STALE: 评审请求已失效");
  if (record.outcome !== "pending") return record;
  record.requestId = requestId;
  record.outcome = outcome;
  pendingDismissals.delete(previewId);
  return record;
}

export function onVisualReviewSuperseded(previewId: string, dismiss: () => void): () => void {
  if (records.get(previewId)?.outcome === "superseded") dismiss();
  else pendingDismissals.set(previewId, dismiss);
  return () => { if (pendingDismissals.get(previewId) === dismiss) pendingDismissals.delete(previewId); };
}

export function bindVisualReview(owner: string, previewId: string, requestId: string): VisualReviewRecord {
  const record = records.get(previewId);
  if (!record || record.owner !== owner || (record.outcome !== "pending" && record.outcome !== "cancelled") || (record.outcome === "pending" && record.requestId && record.requestId !== requestId)) {
    throw new Error("VISUAL_REVIEW_STALE: 当前产出不存在、已结算或已被替换");
  }
  record.outcome = "pending";
  record.requestId = requestId;
  return record;
}

export function restoreVisualReviews(owner: string, results: Iterable<{ toolName: string; details?: unknown }>): void {
  // Only hydrate a cold owner. Replaying older show_visual results over a live registry
  // would publish an old preview again and falsely supersede the current pending review.
  if ([...records.values()].some((record) => record.owner === owner)) return;
  for (const result of results) {
    const detail = result.details as { previewId?: unknown; review?: { previewId?: unknown; outcome?: unknown; requestId?: unknown } } | undefined;
    if (result.toolName === "show_visual" && typeof detail?.previewId === "string") publishVisualReview(owner, detail.previewId);
    if (result.toolName === "ask_user" && typeof detail?.review?.previewId === "string" && typeof detail.review.requestId === "string") {
      const outcome = detail.review.outcome;
      if (outcome === "approved" || outcome === "redo" || outcome === "cancelled") {
        try {
          bindVisualReview(owner, detail.review.previewId, detail.review.requestId);
          settleVisualReview(owner, detail.review.previewId, detail.review.requestId, outcome);
        } catch { /* superseded historical cards remain stale */ }
      }
    }
  }
}
