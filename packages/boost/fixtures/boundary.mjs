// Intentional regression used ONLY by the smoke harness, never installed.
export const clamp = (n, max) => n < 0 ? n : Math.min(max, n);
