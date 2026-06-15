// Pure vector math + scoring for long-term-memory recall. No DB / no I/O so it
// is fully unit-testable. cosine = dot / (normA * normB); norms are precomputed
// and cached per memory to avoid recomputing on every recall.

export function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

export function vecNorm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}
