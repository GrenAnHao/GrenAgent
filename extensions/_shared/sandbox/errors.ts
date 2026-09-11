export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}
