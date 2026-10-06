const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_ORDER)[number];

export interface CursorWireModel {
  id: string;
  requestModelId?: string;
  thinking?: {
    efforts?: readonly string[];
    effortRouting?: Partial<Record<Effort | "off", string>>;
  };
}

export function resolveCursorWireModelId(
  model: CursorWireModel,
  effort: Effort | "off",
  requestedId = model.id,
): string {
  const suffix = requestedId.slice(model.id.length);
  const fromSuffix = suffix.startsWith("-") ? suffix.slice(1) : undefined;
  const explicit = effort === "off" ? "off" : effort;
  const chosen = explicit !== "off" ? explicit : fromSuffix === "off" || fromSuffix === undefined ? "off" : fromSuffix;
  const clamped = clampEffort(model, chosen);
  return model.thinking?.effortRouting?.[clamped] ?? model.requestModelId ?? model.id;
}

function clampEffort(model: CursorWireModel, effort: Effort | "off"): Effort | "off" {
  if (effort === "off") return "off";
  const efforts = model.thinking?.efforts ?? [];
  if (efforts.includes(effort)) return effort;
  const index = EFFORT_ORDER.indexOf(effort);
  for (let i = index - 1; i >= 0; i--) {
    const lower = EFFORT_ORDER[i];
    if (lower && efforts.includes(lower)) return lower;
  }
  return "off";
}
