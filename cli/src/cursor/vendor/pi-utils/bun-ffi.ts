/** Node stand-in for Bun's ffi module. The stderr guard stays inert when libc cannot be opened. */
export const FFIType = { i32: "i32" } as const;

export function dlopen(): never {
	throw new Error("bun:ffi is not available under Node");
}
