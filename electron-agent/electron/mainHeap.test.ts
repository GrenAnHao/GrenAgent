import { describe, expect, it } from "vitest";
import {
  installDevElectronHeapArg,
  MAIN_JS_FLAGS,
  MAIN_OLD_SPACE_MB,
  mainHeapArgPresent,
} from "./mainHeap";

describe("main process heap", () => {
  it("raises the default 1.5GB ceiling to 4GB", () => {
    expect(MAIN_OLD_SPACE_MB).toBe(4096);
    expect(MAIN_JS_FLAGS).toBe("--js-flags=--max-old-space-size=4096");
  });

  it("adds the flag to electron-vite launch args once", () => {
    const env: NodeJS.ProcessEnv = { ELECTRON_CLI_ARGS: JSON.stringify(["--inspect=9229"]) };
    installDevElectronHeapArg(env);
    expect(JSON.parse(env.ELECTRON_CLI_ARGS!)).toEqual(["--inspect=9229", MAIN_JS_FLAGS]);
    installDevElectronHeapArg(env);
    expect(JSON.parse(env.ELECTRON_CLI_ARGS!)).toEqual(["--inspect=9229", MAIN_JS_FLAGS]);
  });

  it("treats an existing max-old-space-size argument as already configured", () => {
    expect(mainHeapArgPresent(["electron.exe", "main.js", MAIN_JS_FLAGS])).toBe(true);
    expect(mainHeapArgPresent(["electron.exe"])).toBe(false);
  });
});
