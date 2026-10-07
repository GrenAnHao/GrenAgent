import { createHash } from "node:crypto";

function digest32(value: string): number {
	return createHash("sha256").update(value).digest().readUInt32BE(0);
}

/** Stable 32-bit digest. The same input always yields the same number. */
export const stableHash = Object.assign(digest32, { wyhash: digest32 });
