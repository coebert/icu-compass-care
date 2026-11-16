/**
 * Structural pre-validation for untrusted input (GHSA-mrhx-c7xc-m3w5).
 *
 * Zod 3 (no patched 3.x release exists) checks EVERY element of an array or
 * record even after a `.max()` limit has already failed, and keeps one issue
 * object per failing element. A small request with a long list therefore turns
 * into a large amount of worker memory. This walker runs BEFORE any Zod schema
 * sees the data and rejects oversized collections in bounded time: list
 * lengths are checked before any element is visited, object keys are counted
 * with an early exit, and the total visit is capped by `maxNodes`.
 *
 * Browser-safe (no server imports) so it can be registered as global
 * function middleware and unit-tested in isolation.
 */

export type InputBounds = {
  /** Longest single array / Set / Map accepted. */
  maxArrayLength: number;
  /** Most own keys accepted on one plain object (covers z.record inputs). */
  maxObjectKeys: number;
  /** Total container children visited across the whole value. */
  maxNodes: number;
  /** Deepest container nesting accepted. */
  maxDepth: number;
};

export type BoundsViolation = "array_too_long" | "too_many_keys" | "too_many_nodes" | "too_deep";

/**
 * Server functions. The largest legitimate lists are 500 ids (handover export,
 * partner sharing); the largest structured payloads (patient form, bed set-up,
 * chart day) are well under 1,000 nodes. Chart photos are strings, which do
 * not count towards these limits.
 */
export const SERVER_FN_INPUT_BOUNDS: InputBounds = {
  maxArrayLength: 1000,
  maxObjectKeys: 500,
  maxNodes: 20_000,
  maxDepth: 32,
};

/** Signed partner write endpoints (one patient or one investigation per call). */
export const BRIDGE_INPUT_BOUNDS: InputBounds = {
  maxArrayLength: 200,
  maxObjectKeys: 300,
  maxNodes: 10_000,
  maxDepth: 16,
};

/** Largest raw body accepted on partner write endpoints, checked before reading. */
export const BRIDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;

export const INPUT_TOO_LARGE_MESSAGE =
  "This request contains too much data to process. Please try again with less.";

const hasOwn = Object.prototype.hasOwnProperty;

export function findBoundsViolation(value: unknown, bounds: InputBounds): BoundsViolation | null {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    // Opaque leaves: Zod does not iterate these.
    if (v instanceof Date || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
    if (depth >= bounds.maxDepth) return "too_deep";

    if (Array.isArray(v)) {
      // Length first: a sparse or huge array is rejected without visiting it.
      if (v.length > bounds.maxArrayLength) return "array_too_long";
      nodes += v.length;
      if (nodes > bounds.maxNodes) return "too_many_nodes";
      for (let i = 0; i < v.length; i++) stack.push([v[i], depth + 1]);
      continue;
    }
    if (v instanceof Set || v instanceof Map) {
      if (v.size > bounds.maxArrayLength) return "array_too_long";
      nodes += v instanceof Map ? v.size * 2 : v.size;
      if (nodes > bounds.maxNodes) return "too_many_nodes";
      if (v instanceof Map) {
        for (const [k, val] of v) stack.push([k, depth + 1], [val, depth + 1]);
      } else {
        for (const item of v) stack.push([item, depth + 1]);
      }
      continue;
    }

    let keys = 0;
    for (const k in v) {
      if (!hasOwn.call(v, k)) continue;
      if (++keys > bounds.maxObjectKeys) return "too_many_keys";
      if (++nodes > bounds.maxNodes) return "too_many_nodes";
      stack.push([(v as Record<string, unknown>)[k], depth + 1]);
    }
  }
  return null;
}

export class InputTooLargeError extends Error {
  readonly violation: BoundsViolation;
  constructor(violation: BoundsViolation) {
    super(INPUT_TOO_LARGE_MESSAGE);
    this.name = "InputTooLargeError";
    this.violation = violation;
  }
}

/** Throws InputTooLargeError when `value` exceeds `bounds`. */
export function assertInputBounds(value: unknown, bounds: InputBounds): void {
  const violation = findBoundsViolation(value, bounds);
  if (violation) throw new InputTooLargeError(violation);
}
