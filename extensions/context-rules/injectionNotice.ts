export const RULE_INJECTION_ENTRY = "context-rule-injection";

export interface InjectedRule {
  id: string;
  title: string;
  scope: "global" | "project";
}

export function ruleInjectionMessage(entry: unknown) {
  if (!entry || typeof entry !== "object") return;
  const { type, customType, id, timestamp, data } = entry as Record<string, unknown>;
  if (type !== "custom" || customType !== RULE_INJECTION_ENTRY || typeof id !== "string" || !id) return;
  const rules = readInjectedRules(data);
  if (!rules.length) return;
  return {
    role: "custom", customType, display: true, entryId: id,
    timestamp: typeof timestamp === "string" ? Date.parse(timestamp) : undefined,
    content: "已注入规则",
    details: { rules },
  };
}

export function readInjectedRules(data: unknown): InjectedRule[] {
  if (!data || typeof data !== "object" || !("rules" in data) || !Array.isArray(data.rules)) return [];
  return data.rules.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { id, title, scope } = item as Record<string, unknown>;
    return typeof id === "string" && typeof title === "string" && (scope === "global" || scope === "project")
      ? [{ id, title, scope }]
      : [];
  });
}
