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

  it("strips PowerShell VT / ANSI sequences", () => {
    const raw = Buffer.from(
      "\x1b[31;1mInvalidOperation: Cannot set property. Property setting is supported only on core types in this language mode.\x1b[0m\nhello",
    );
    expect(decodeSpawnChunk(raw).toString()).toBe(
      "InvalidOperation: Cannot set property. Property setting is supported only on core types in this language mode.\nhello",
    );
  });

  it("transcodes GBK 中文 to UTF-8", () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
    expect(decodeSpawnChunk(gbk).toString()).toBe("中文\n");
  });
});
