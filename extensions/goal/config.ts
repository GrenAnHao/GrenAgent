import { getConfig } from "../_shared/runtime-config.js";

export function readAutoContinueOnOpen(): boolean {
  return getConfig("goal.autoContinueOnOpen") === "true";
}
