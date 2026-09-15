import { describe, expect, it } from "vitest";
import { decodeSpawnChunk } from "./decodeSpawnChunk.js";

describe("decodeSpawnChunk", () => {
  it("passes through UTF-8", () => {
    const data = Buffer.from("hello\n");
    expect(decodeSpawnChunk(data).equals(data)).toBe(true);
  });

  it("decodes WSL CreateInstance UTF-16LE without BOM", () => {
    const text = "拒绝访问。\r\n错误代码: Bash/Service/CreateInstance/E_ACCESSDENIED\r\n";
    const decoded = decodeSpawnChunk(Buffer.from(text, "utf16le"));
    expect(decoded.toString()).toBe(text);
  });

  it("strips UTF-16LE BOM", () => {
    const body = Buffer.from("Access is denied.\n", "utf16le");
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
    expect(decodeSpawnChunk(withBom).toString()).toBe("Access is denied.\n");
  });
});
