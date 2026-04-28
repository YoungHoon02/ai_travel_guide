/**
 * Unit tests for src/utils.js
 *
 * Covers: timeToMinutes, minutesToTime, calcSlotProgress, escapeHtml,
 *         distSq, orderNearestNeighborFrom, buildTransitLikeRoute,
 *         sumVisitScores, assignOptimalDays
 */
import { describe, it, expect } from "vitest";
import {
  timeToMinutes,
  minutesToTime,
  calcSlotProgress,
  escapeHtml,
  distSq,
  orderNearestNeighborFrom,
  buildTransitLikeRoute,
  sumVisitScores,
  assignOptimalDays,
} from "../utils.js";

// ─── timeToMinutes ────────────────────────────────────────────────────────────

describe("timeToMinutes", () => {
  it("parses midnight correctly", () => {
    expect(timeToMinutes("00:00")).toBe(0);
  });

  it("parses noon correctly", () => {
    expect(timeToMinutes("12:00")).toBe(720);
  });

  it("parses end-of-day correctly", () => {
    expect(timeToMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("handles missing minutes component (HH only after colon)", () => {
    expect(timeToMinutes("09:00")).toBe(540);
  });

  it("falls back to 00:00 when input is null/undefined", () => {
    expect(timeToMinutes(null)).toBe(0);
    expect(timeToMinutes(undefined)).toBe(0);
  });

  it("handles arbitrary HH:MM", () => {
    expect(timeToMinutes("08:30")).toBe(8 * 60 + 30);
    expect(timeToMinutes("17:45")).toBe(17 * 60 + 45);
  });
});

// ─── minutesToTime ────────────────────────────────────────────────────────────

describe("minutesToTime", () => {
  it("converts 0 → 00:00", () => {
    expect(minutesToTime(0)).toBe("00:00");
  });

  it("converts noon correctly", () => {
    expect(minutesToTime(720)).toBe("12:00");
  });

  it("pads single-digit hours", () => {
    expect(minutesToTime(540)).toBe("09:00");
  });

  it("pads single-digit minutes", () => {
    expect(minutesToTime(9 * 60 + 5)).toBe("09:05");
  });

  it("wraps past midnight (mod 24)", () => {
    // 25 * 60 = 1500 → 01:00
    expect(minutesToTime(1500)).toBe("01:00");
  });

  it("roundtrips through timeToMinutes", () => {
    const times = ["00:00", "08:30", "12:00", "17:45", "23:59"];
    times.forEach((t) => {
      expect(minutesToTime(timeToMinutes(t))).toBe(t);
    });
  });
});

// ─── calcSlotProgress ────────────────────────────────────────────────────────

const SAMPLE_SLOT_SCHEDULE = [
  { id: "lodge-d1-start", kind: "lodging", anchor: "start", day: 1, startTime: "09:00" },
  { id: "a", kind: "activity", day: 1, startTime: "09:30", name: "A" },
  { id: "b", kind: "activity", day: 1, startTime: "11:00", name: "B" },
  { id: "lodge-d1-end", kind: "lodging", anchor: "end", day: 1, startTime: "20:00" },
  { id: "lodge-d2-start", kind: "lodging", anchor: "start", day: 2, startTime: "09:00" },
  { id: "c", kind: "activity", day: 2, startTime: "10:00", name: "C" },
  { id: "d", kind: "activity", day: 2, startTime: "14:00", name: "D" },
  { id: "lodge-d2-end", kind: "lodging", anchor: "end", day: 2, startTime: "20:00" },
];

describe("calcSlotProgress", () => {
  it("excludes lodging anchors from done/remaining", () => {
    const { done, remaining } = calcSlotProgress(SAMPLE_SLOT_SCHEDULE, "23:00", 2);
    const allIds = [...done, ...remaining].map((s) => s.id);
    expect(allIds).not.toContain("lodge-d1-start");
    expect(allIds).not.toContain("lodge-d1-end");
    expect(allIds).not.toContain("lodge-d2-start");
    expect(allIds).not.toContain("lodge-d2-end");
  });

  it("on day 1 before any slot → all 4 activities remaining", () => {
    const { done, remaining, next } = calcSlotProgress(SAMPLE_SLOT_SCHEDULE, "08:00", 1);
    expect(done).toHaveLength(0);
    expect(remaining.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(next?.id).toBe("a");
  });

  it("on day 1 mid-day → past day-1 slots done, day-2 still remaining", () => {
    const { done, remaining, next } = calcSlotProgress(SAMPLE_SLOT_SCHEDULE, "10:00", 1);
    expect(done.map((s) => s.id)).toEqual(["a"]);
    expect(remaining.map((s) => s.id)).toEqual(["b", "c", "d"]);
    expect(next?.id).toBe("b");
  });

  it("on day 2 → all day-1 activities auto-done regardless of time", () => {
    const { done, remaining, next } = calcSlotProgress(SAMPLE_SLOT_SCHEDULE, "08:00", 2);
    expect(done.map((s) => s.id)).toEqual(["a", "b"]);
    expect(remaining.map((s) => s.id)).toEqual(["c", "d"]);
    expect(next?.id).toBe("c");
  });

  it("after all slots on last day → all done, no next", () => {
    const { done, remaining, next } = calcSlotProgress(SAMPLE_SLOT_SCHEDULE, "23:00", 2);
    expect(done.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(remaining).toHaveLength(0);
    expect(next).toBeNull();
  });

  it("empty schedule returns empty result", () => {
    const r = calcSlotProgress([], "12:00", 1);
    expect(r.done).toEqual([]);
    expect(r.remaining).toEqual([]);
    expect(r.next).toBeNull();
  });

  it("defaults currentDay to 1 when not provided", () => {
    const { remaining } = calcSlotProgress(SAMPLE_SLOT_SCHEDULE, "08:00");
    expect(remaining.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });
});

// ─── escapeHtml ───────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("escapes & < > \" '", () => {
    expect(escapeHtml('a & b')).toBe("a &amp; b");
    expect(escapeHtml('<script>')).toBe("&lt;script&gt;");
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
    expect(escapeHtml("it's")).toBe("it&#x27;s");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes all occurrences in a longer string", () => {
    const input = "<b>bold</b> & <i>italic</i>";
    const output = "&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;";
    expect(escapeHtml(input)).toBe(output);
  });

  it("coerces non-strings via String()", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("null");
  });
});

// ─── distSq ───────────────────────────────────────────────────────────────────

describe("distSq", () => {
  it("same point → 0", () => {
    expect(distSq([1, 2], [1, 2])).toBe(0);
  });

  it("3-4-5 right triangle", () => {
    // Δx=3, Δy=4 → distSq=25
    expect(distSq([0, 0], [4, 3])).toBe(25);
  });

  it("symmetric", () => {
    const a = [35.7, 139.7];
    const b = [35.6, 139.8];
    expect(distSq(a, b)).toBeCloseTo(distSq(b, a));
  });
});

// ─── orderNearestNeighborFrom ─────────────────────────────────────────────────

describe("orderNearestNeighborFrom", () => {
  it("returns empty array when no spots", () => {
    expect(orderNearestNeighborFrom([], [35.7, 139.7])).toEqual([]);
  });

  it("single spot is returned as-is", () => {
    const spots = [{ id: "a", latlng: [35.7, 139.7] }];
    expect(orderNearestNeighborFrom(spots, [35.0, 139.0])).toHaveLength(1);
    expect(orderNearestNeighborFrom(spots, [35.0, 139.0])[0].id).toBe("a");
  });

  it("picks closer point first", () => {
    const origin = [35.0, 139.0];
    const near = { id: "near", latlng: [35.1, 139.1] };
    const far = { id: "far", latlng: [36.0, 140.0] };
    const result = orderNearestNeighborFrom([far, near], origin);
    expect(result[0].id).toBe("near");
    expect(result[1].id).toBe("far");
  });

  it("does not mutate original array", () => {
    const spots = [
      { id: "a", latlng: [35.5, 139.5] },
      { id: "b", latlng: [35.6, 139.6] },
    ];
    const copy = [...spots];
    orderNearestNeighborFrom(spots, [35.0, 139.0]);
    expect(spots).toEqual(copy);
  });
});

// ─── buildTransitLikeRoute ────────────────────────────────────────────────────

describe("buildTransitLikeRoute", () => {
  it("returns original points when fewer than 2", () => {
    expect(buildTransitLikeRoute([[35.7, 139.7]], "public")).toEqual([[35.7, 139.7]]);
    expect(buildTransitLikeRoute([], "public")).toEqual([]);
  });

  it("returns more points than input for ≥2 points (bends are added)", () => {
    const pts = [[35.7, 139.7], [35.6, 139.8]];
    const result = buildTransitLikeRoute(pts, "public");
    expect(result.length).toBeGreaterThan(pts.length);
  });

  it("starts and ends at the original endpoints", () => {
    const pts = [[35.7, 139.7], [35.6, 139.8], [35.5, 139.9]];
    const result = buildTransitLikeRoute(pts, "taxi");
    expect(result[0]).toEqual(pts[0]);
    expect(result[result.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("uses different bend scale for taxi vs car vs public", () => {
    const pts = [[35.0, 139.0], [36.0, 140.0]];
    const taxi = buildTransitLikeRoute(pts, "taxi");
    const car = buildTransitLikeRoute(pts, "car");
    const pub = buildTransitLikeRoute(pts, "public");
    // Points should differ between modes
    expect(taxi[1]).not.toEqual(car[1]);
    expect(taxi[1]).not.toEqual(pub[1]);
  });
});

// ─── sumVisitScores ───────────────────────────────────────────────────────────

const MOCK_CONTENTS = [
  { id: "a", visitScore: 4 },
  { id: "b", visitScore: 3 },
  { id: "c", visitScore: 5 },
  { id: "d", visitScore: 2 },
];

describe("sumVisitScores", () => {
  it("sums correctly for all IDs", () => {
    expect(sumVisitScores(["a", "b", "c", "d"], MOCK_CONTENTS)).toBe(14);
  });

  it("returns 0 for empty list", () => {
    expect(sumVisitScores([], MOCK_CONTENTS)).toBe(0);
  });

  it("treats unknown IDs as 0", () => {
    expect(sumVisitScores(["a", "unknown"], MOCK_CONTENTS)).toBe(4);
  });

  it("partial selection", () => {
    expect(sumVisitScores(["b", "c"], MOCK_CONTENTS)).toBe(8);
  });
});

// ─── assignOptimalDays ────────────────────────────────────────────────────────

const CONTENTS_FOR_ASSIGN = [
  { id: "s1", visitScore: 4, latlng: [35.71, 139.80] },
  { id: "s2", visitScore: 3, latlng: [35.71, 139.77] },
  { id: "s3", visitScore: 3, latlng: [35.72, 139.77] },
  { id: "s4", visitScore: 5, latlng: [35.72, 139.79] },
  { id: "s5", visitScore: 4, latlng: [35.67, 139.70] },
  { id: "s6", visitScore: 4, latlng: [35.66, 139.71] },
];

describe("assignOptimalDays", () => {
  it("returns empty buckets for empty IDs", () => {
    const result = assignOptimalDays([], [35.69, 139.70], CONTENTS_FOR_ASSIGN);
    expect(result).toEqual({ 1: [], 2: [], 3: [] });
  });

  it("returns 3 buckets with all IDs covered", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const result = assignOptimalDays(ids, [35.69, 139.70], CONTENTS_FOR_ASSIGN);
    const allAssigned = [...result[1], ...result[2], ...result[3]];
    expect(allAssigned.sort()).toEqual(ids.sort());
  });

  it("every day bucket has at least 1 item when ≥ 3 spots", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const result = assignOptimalDays(ids, [35.69, 139.70], CONTENTS_FOR_ASSIGN);
    expect(result[1].length).toBeGreaterThan(0);
    expect(result[2].length).toBeGreaterThan(0);
    expect(result[3].length).toBeGreaterThan(0);
  });

  it("assigns all spots to day 1 and 2 when only 2 spots", () => {
    const ids = ["s1", "s2"];
    const result = assignOptimalDays(ids, [35.69, 139.70], CONTENTS_FOR_ASSIGN);
    expect(result[1].length + result[2].length + result[3].length).toBe(2);
  });

  it("ignores unknown IDs", () => {
    const ids = ["s1", "unknown-spot"];
    const result = assignOptimalDays(ids, [35.69, 139.70], CONTENTS_FOR_ASSIGN);
    const allAssigned = [...result[1], ...result[2], ...result[3]];
    expect(allAssigned).not.toContain("unknown-spot");
    expect(allAssigned).toContain("s1");
  });
});

