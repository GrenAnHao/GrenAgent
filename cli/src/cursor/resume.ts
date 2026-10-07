export type CursorResumeKind = "user-turn" | "in-stream-retry";

export function cursorRequestResumes(kind: CursorResumeKind): boolean {
  return kind === "in-stream-retry";
}
