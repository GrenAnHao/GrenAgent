const ACCEPTED = new Set(["handled", "queued", "started"]);

export function promptWasAccepted(disposition: unknown): boolean {
  return typeof disposition === "string" && ACCEPTED.has(disposition);
}
