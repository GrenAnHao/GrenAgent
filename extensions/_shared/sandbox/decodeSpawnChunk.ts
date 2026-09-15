/**
 * WSL bash.exe writes CreateInstance errors as UTF-16LE without a BOM.
 * Node's default Buffer.toString() is UTF-8, which is the mojibake in the UI.
 */
export function decodeSpawnChunk(data: Buffer): Buffer {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return Buffer.from(data.subarray(2).toString("utf16le"));
  }
  const n = Math.min(data.length, 96);
  if (n < 8) return data;
  let oddNul = 0;
  for (let i = 1; i < n; i += 2) {
    if (data[i] === 0) oddNul++;
  }
  if (oddNul / Math.floor(n / 2) < 0.5) return data;
  return Buffer.from(data.toString("utf16le"));
}
