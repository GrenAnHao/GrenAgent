/**
 * WSL bash.exe writes CreateInstance errors as UTF-16LE without a BOM.
 * Node's default Buffer.toString() is UTF-8, which is the mojibake in the UI.
 *
 * Windows PowerShell under a pipe often emits GBK/cp936 (when Constrained
 * Language Mode blocks [Console]::OutputEncoding) and VT/ANSI from $PSStyle.
 */
const VT =
  /\u001B\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|\u009B[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g;

export function stripVt(text: string): string {
  return text.replace(VT, "");
}

function looksLikeUtf16Le(data: Buffer): boolean {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return true;
  const n = Math.min(data.length, 96);
  if (n < 8) return false;
  let oddNul = 0;
  for (let i = 1; i < n; i += 2) {
    if (data[i] === 0) oddNul++;
  }
  return oddNul / Math.floor(n / 2) >= 0.5;
}

function isValidUtf8(data: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

function transcodeLegacyChinese(data: Buffer): Buffer | null {
  for (const label of ["gb18030", "gbk"] as const) {
    try {
      return Buffer.from(new TextDecoder(label).decode(data), "utf8");
    } catch {
      // encoding missing from ICU, or bytes not valid in this mapping
    }
  }
  return null;
}

export function decodeSpawnChunk(data: Buffer): Buffer {
  let buf = data;
  if (looksLikeUtf16Le(data)) {
    const start = data.length >= 2 && data[0] === 0xff && data[1] === 0xfe ? 2 : 0;
    buf = Buffer.from(data.subarray(start).toString("utf16le"), "utf8");
  } else if (!isValidUtf8(data)) {
    buf = transcodeLegacyChinese(data) ?? data;
  }
  return Buffer.from(stripVt(buf.toString("utf8")), "utf8");
}
