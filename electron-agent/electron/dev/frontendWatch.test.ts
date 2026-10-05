import { describe, expect, it } from "vitest";
import { ignoreNonFrontendWatch, isFrontendHmrPath } from "./frontendWatch";

const root = "D:/app/electron-agent";

describe("isFrontendHmrPath", () => {
  it("accepts renderer source and index.html", () => {
    expect(isFrontendHmrPath(`${root}/src/App.tsx`, root)).toBe(true);
    expect(isFrontendHmrPath(`${root}/src/features/chat/ChatView.tsx`, root)).toBe(true);
    expect(isFrontendHmrPath(`${root}/index.html`, root)).toBe(true);
  });

  it("rejects tests, main process, extensions, and build output", () => {
    expect(isFrontendHmrPath(`${root}/src/App.test.tsx`, root)).toBe(false);
    expect(isFrontendHmrPath(`${root}/src/lib/foo.spec.ts`, root)).toBe(false);
    expect(isFrontendHmrPath(`${root}/electron/main.ts`, root)).toBe(false);
    expect(isFrontendHmrPath("D:/app/extensions/todo/index.ts", root)).toBe(false);
    expect(isFrontendHmrPath(`${root}/out/main/index.js`, root)).toBe(false);
    expect(isFrontendHmrPath(`${root}/electron.vite.config.ts`, root)).toBe(false);
  });
});

describe("ignoreNonFrontendWatch", () => {
  it("keeps the root, src directories, frontend files, and the vite config", () => {
    expect(ignoreNonFrontendWatch(root, root)).toBe(false);
    expect(ignoreNonFrontendWatch(`${root}/src`, root)).toBe(false);
    expect(ignoreNonFrontendWatch(`${root}/src/features/chat`, root)).toBe(false);
    expect(ignoreNonFrontendWatch(`${root}/src/App.tsx`, root)).toBe(false);
    expect(ignoreNonFrontendWatch(`${root}/index.html`, root)).toBe(false);
    expect(ignoreNonFrontendWatch(`${root}/electron.vite.config.ts`, root)).toBe(false);
  });

  it("ignores tests and everything outside the frontend tree", () => {
    expect(ignoreNonFrontendWatch(`${root}/src/App.test.tsx`, root)).toBe(true);
    expect(ignoreNonFrontendWatch(`${root}/electron`, root)).toBe(true);
    expect(ignoreNonFrontendWatch(`${root}/electron/main.ts`, root)).toBe(true);
    expect(ignoreNonFrontendWatch(`${root}/out/main/index.js`, root)).toBe(true);
    expect(ignoreNonFrontendWatch("D:/app/extensions/mcp/index.ts", root)).toBe(true);
  });
});
