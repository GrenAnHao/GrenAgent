import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { withBashUiDescription } from "./bashUiDescription.js";

describe("withBashUiDescription against the real bash tool", () => {
  it("adds a required description property to createBashToolDefinition", () => {
    const def = withBashUiDescription(createBashToolDefinition("/tmp"));
    const params = def.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(params.properties?.command).toBeTruthy();
    expect(params.properties?.description).toBeTruthy();
    expect(params.required).toEqual(expect.arrayContaining(["command", "description"]));
  });
});
