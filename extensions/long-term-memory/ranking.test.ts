import { describe, expect, it } from "vitest";
import { dot, vecNorm } from "./ranking.js";

describe("vecNorm", () => {
  it("computes L2 norm", () => {
    expect(vecNorm(Float32Array.from([3, 4]))).toBeCloseTo(5);
  });
  it("zero vector → 0", () => {
    expect(vecNorm(Float32Array.from([0, 0]))).toBe(0);
  });
});

describe("dot", () => {
  it("computes dot product over min length", () => {
    expect(dot(Float32Array.from([1, 2, 3]), Float32Array.from([4, 5, 6]))).toBeCloseTo(32);
  });
  it("tolerates length mismatch (uses min length)", () => {
    expect(dot(Float32Array.from([1, 2]), Float32Array.from([3, 4, 5]))).toBeCloseTo(11);
  });
});
