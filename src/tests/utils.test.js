/**
 * Unit tests for src/utils.js
 *
 * Covers: timeToMinutes, minutesToTime, calcProgress, escapeHtml,
 *         distSq, orderNearestNeighborFrom, buildTransitLikeRoute,
 *         sumVisitScores, assignOptimalDays, simulateLLMResponse
 */
import { describe, it, expect } from "vitest";
import {
  timeToMinutes,
  minutesToTime,
  calcProgress,
  escapeHtml,
  distSq,
  orderNearestNeighborFrom,
  buildTransitLikeRoute,
  sumVisitScores,
  assignOptimalDays,
  simulateLLMResponse,
  parseDayCount,
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

// ─── parseDayCount ───────────────────────────────────────────────────────────

describe("parseDayCount", () => {
  it("extracts nights and days from 박/일 format", () => {
    expect(parseDayCount("2박 3일")).toEqual({ days: 3, nights: 2 });
    expect(parseDayCount("1박2일")).toEqual({ days: 2, nights: 1 });
  });

  it("derives nights when only days are present", () => {
    expect(parseDayCount("3일")).toEqual({ days: 3, nights: 2 });
  });

  it("adds a day when only nights are present", () => {
    expect(parseDayCount("2박")).toEqual({ days: 3, nights: 2 });
  });

  it("corrects nights greater than days by extending days", () => {
    expect(parseDayCount("5박3일")).toEqual({ days: 6, nights: 5 });
  });

  it("falls back to defaults when unparseable", () => {
    expect(parseDayCount("무계획", { fallbackDays: 4 })).toEqual({ days: 4, nights: 3 });
  });

  it("enforces minimum day count for zero/negative input", () => {
    expect(parseDayCount("0일", { minDays: 2 })).toEqual({ days: 2, nights: 1 });
  });
});

// ─── calcProgress ─────────────────────────────────────────────────────────────

const SAMPLE_SCHEDULE = [
  { id: "a", name: "A", time: "09:00", indoor: true },
  { id: "b", name: "B", time: "11:00", indoor: false },
  { id: "c", name: "C", time: "14:00", indoor: true },
  { id: "d", name: "D", time: "18:00", indoor: false },
];

describe("calcProgress", () => {
  it("before any slot → all items remaining, none done", () => {
    const { done, remaining, next } = calcProgress(SAMPLE_SCHEDULE, "07:00");
    expect(done).toHaveLength(0);
    expect(remaining).toHaveLength(4);
    expect(next?.id).toBe("a");
  });

  it("between first and second slot", () => {
    const { done, remaining, next } = calcProgress(SAMPLE_SCHEDULE, "10:00");
    expect(done.map((i) => i.id)).toEqual(["a"]);
    expect(remaining.map((i) => i.id)).toEqual(["b", "c", "d"]);
    expect(next?.id).toBe("b");
  });

  it("after all slots → all done, none remaining", () => {
    const { done, remaining, next } = calcProgress(SAMPLE_SCHEDULE, "22:00");
    expect(done).toHaveLength(4);
    expect(remaining).toHaveLength(0);
    expect(next).toBeNull();
  });

  it("exactly on a slot boundary treats it as remaining (>=)", () => {
    const { done, remaining } = calcProgress(SAMPLE_SCHEDULE, "14:00");
    expect(done.map((i) => i.id)).toEqual(["a", "b"]);
    expect(remaining.map((i) => i.id)).toEqual(["c", "d"]);
  });

  it("returns correct nowMins value", () => {
    const { nowMins } = calcProgress(SAMPLE_SCHEDULE, "13:30");
    expect(nowMins).toBe(13 * 60 + 30);
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

// ─── simulateLLMResponse ──────────────────────────────────────────────────────

const FULL_PLAN = [
  { id: "a", name: "오모테산도", time: "10:00", indoor: true },
  { id: "b", name: "메이지 신궁", time: "11:30", indoor: false },
  { id: "c", name: "우에노 공원", time: "14:00", indoor: false },
  { id: "d", name: "아키하바라", time: "16:00", indoor: true },
  { id: "e", name: "신주쿠 골든가이", time: "20:00", indoor: false },
];

describe("simulateLLMResponse — delay scenario", () => {
  it("filters out spots before the mentioned hour", () => {
    const res = simulateLLMResponse("늦잠 자서 13시에 출발해요", FULL_PLAN);
    // 10:00 and 11:30 are before 13:00 → should be skipped
    expect(res.modifiedSchedule).not.toBeNull();
    expect(res.modifiedSchedule.every((i) => timeToMinutes(i.time) >= 13 * 60)).toBe(true);
  });

  it("response text mentions the mentioned hour", () => {
    const res = simulateLLMResponse("12시에 출발", FULL_PLAN);
    expect(res.text).toContain("12시");
  });

  it("keeps all spots when none are before the mentioned hour", () => {
    const res = simulateLLMResponse("늦잠 자서 8시에 출발", FULL_PLAN);
    // All spots are at 10:00+ so none should be skipped
    expect(res.modifiedSchedule).toEqual(FULL_PLAN);
  });

  it("returns full plan (fallback) when remaining would be empty", () => {
    const res = simulateLLMResponse("늦잠 자서 23시에 출발합니다", FULL_PLAN);
    // All spots are before 23:00 → remaining is empty → returns plan
    expect(res.modifiedSchedule).toHaveLength(FULL_PLAN.length);
  });
});

describe("simulateLLMResponse — rain scenario", () => {
  it("identifies outdoor and indoor spots correctly", () => {
    const res = simulateLLMResponse("비가 와서 어떻게 해야 하나요?", FULL_PLAN);
    expect(res.text).toContain("메이지 신궁");
    expect(res.text).toContain("우에노 공원");
    expect(res.text).toContain("신주쿠 골든가이");
    // Indoor spots should be in the "recommendation" part
    expect(res.text).toContain("오모테산도");
    expect(res.text).toContain("아키하바라");
  });

  it("modifiedSchedule is null for rain (advice only)", () => {
    const res = simulateLLMResponse("오늘 비가 오는데요", FULL_PLAN);
    expect(res.modifiedSchedule).toBeNull();
  });

  it("when all spots are indoor, replies with all-indoor message", () => {
    const allIndoor = FULL_PLAN.map((s) => ({ ...s, indoor: true }));
    const res = simulateLLMResponse("비가 오네요", allIndoor);
    expect(res.text).toContain("실내 위주");
    expect(res.modifiedSchedule).toBeNull();
  });
});

describe("simulateLLMResponse — cancellation scenario", () => {
  it("removes the mentioned spot from the plan", () => {
    const res = simulateLLMResponse("아키하바라 취소됐어요", FULL_PLAN);
    expect(res.modifiedSchedule).not.toBeNull();
    expect(res.modifiedSchedule.some((i) => i.id === "d")).toBe(false);
    expect(res.modifiedSchedule).toHaveLength(FULL_PLAN.length - 1);
  });

  it("response text mentions the cancelled spot", () => {
    const res = simulateLLMResponse("신주쿠 골든가이 취소", FULL_PLAN);
    expect(res.text).toContain("신주쿠 골든가이");
  });
});

describe("simulateLLMResponse — unknown scenario (fallback)", () => {
  it("returns null modifiedSchedule", () => {
    const res = simulateLLMResponse("오늘 날씨가 좋네요", FULL_PLAN);
    expect(res.modifiedSchedule).toBeNull();
  });

  it("response text contains plan length", () => {
    const res = simulateLLMResponse("무엇을 추천하세요?", FULL_PLAN);
    expect(res.text).toContain(`${FULL_PLAN.length}`);
  });
});
