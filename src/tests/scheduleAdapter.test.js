import { describe, it, expect } from "vitest";
import {
  scheduleToPlan,
  planToSchedule,
  suggestPlanName,
} from "../store/scheduleAdapter.js";
import {
  buildSkeletonSchedule,
  createActivitySlot,
  addSlot,
  recalculateDayTimes,
  validateSchedule,
} from "../store/schedule.js";

const lodging = {
  name: "Hotel Sample",
  area: "Shinjuku",
  latlng: [35.6938, 139.7034],
  rating: 4.2,
  priceLevel: "PRICE_LEVEL_MODERATE",
  photoUrl: "https://example.com/h.jpg",
};

function buildSampleSchedule() {
  let s = buildSkeletonSchedule({ dayCount: 2, lodging });
  s = addSlot(
    s,
    createActivitySlot({
      day: 1,
      startTime: "10:00",
      duration: 90,
      name: "센소지",
      area: "아사쿠사",
      category: "관광지",
      latlng: [35.7148, 139.7967],
      visitScore: 4,
      source: "llm",
    })
  );
  s = addSlot(
    s,
    createActivitySlot({
      day: 1,
      startTime: "12:30",
      duration: 60,
      name: "스시 다이",
      area: "츠키지",
      category: "맛집",
      latlng: [35.6655, 139.7707],
      source: "user",
    })
  );
  s = addSlot(
    s,
    createActivitySlot({
      day: 2,
      startTime: "10:00",
      duration: 120,
      name: "도쿄 스카이트리",
      area: "오시아게",
      category: "관광지",
      latlng: [35.7101, 139.8107],
      visitScore: 5,
      source: "llm",
    })
  );
  s = recalculateDayTimes(s, 1);
  s = recalculateDayTimes(s, 2);
  return s;
}

const meta = {
  id: "p_test_1",
  name: "도쿄 1박2일",
  destination: { country: "Japan", city: "도쿄", latlng: [35.68, 139.76] },
  dates: { start: "2026-05-10", end: "2026-05-11", nights: 1, days: 2 },
  rawInput: "도쿄 1박2일 힐링",
  preferences: ["힐링", "미식"],
  createdAt: "2026-05-05T00:00:00.000Z",
  updatedAt: "2026-05-05T00:00:00.000Z",
};

describe("scheduleAdapter", () => {
  it("scheduleToPlan produces well-formed Plan with correct day grouping", () => {
    const schedule = buildSampleSchedule();
    const plan = scheduleToPlan(schedule, meta);

    expect(plan.id).toBe("p_test_1");
    expect(plan.days).toHaveLength(2);
    expect(plan.days[0].dayNumber).toBe(1);
    expect(plan.days[1].dayNumber).toBe(2);

    // Day 1 has 2 lodging anchors + 2 activities = 4 items
    expect(plan.days[0].items).toHaveLength(4);
    // Day 2 has 2 lodging anchors + 1 activity = 3 items
    expect(plan.days[1].items).toHaveLength(3);

    // Items sorted by startTime via getSlotsForDay
    const times = plan.days[0].items.map((i) => i.startTime);
    expect(times).toEqual([...times].sort());
  });

  it("scheduleToPlan infers item.type correctly", () => {
    const schedule = buildSampleSchedule();
    const plan = scheduleToPlan(schedule, meta);
    const day1 = plan.days[0];
    const types = day1.items.map((i) => i.type);
    // Order: lodging start, activity (관광지=content), activity (맛집=meal), lodging end
    expect(types).toContain("lodging");
    expect(types).toContain("content");
    expect(types).toContain("meal");
    expect(types.filter((t) => t === "lodging")).toHaveLength(2);
  });

  it("scheduleToPlan derives per-day dates from meta.dates.start", () => {
    const schedule = buildSampleSchedule();
    const plan = scheduleToPlan(schedule, meta);
    expect(plan.days[0].date).toBe("2026-05-10");
    expect(plan.days[1].date).toBe("2026-05-11");
  });

  it("scheduleToPlan handles missing meta gracefully", () => {
    const schedule = buildSampleSchedule();
    const plan = scheduleToPlan(schedule, {});
    expect(plan.id).toBe("");
    expect(plan.days).toHaveLength(2);
    expect(plan.days[0].date).toBeNull();
  });

  it("planToSchedule recovers a structurally equivalent schedule (round-trip)", () => {
    const original = buildSampleSchedule();
    const plan = scheduleToPlan(original, meta);
    const restored = planToSchedule(plan);

    expect(restored).toHaveLength(original.length);
    // validateSchedule on restored should pass
    const validation = validateSchedule(restored);
    expect(validation.valid ?? validation.ok ?? true).not.toBe(false);

    // Compare per-slot canonical fields
    for (const orig of original) {
      const match = restored.find((r) => r.id === orig.id);
      expect(match).toBeDefined();
      expect(match.day).toBe(orig.day);
      expect(match.kind).toBe(orig.kind);
      expect(match.startTime).toBe(orig.startTime);
      expect(match.endTime).toBe(orig.endTime);
      expect(match.name).toBe(orig.name);
      if (orig.latlng) expect(match.latlng).toEqual(orig.latlng);
      if (orig.kind === "activity") {
        expect(match.category).toBe(orig.category);
      }
    }
  });

  it("round-trip is idempotent (twice = once)", () => {
    const original = buildSampleSchedule();
    const once = planToSchedule(scheduleToPlan(original, meta));
    const twice = planToSchedule(scheduleToPlan(once, meta));
    expect(twice).toEqual(once);
  });

  it("planToSchedule handles null/empty plans", () => {
    expect(planToSchedule(null)).toEqual([]);
    expect(planToSchedule({})).toEqual([]);
    expect(planToSchedule({ days: [] })).toEqual([]);
  });

  it("lodging slots restore with locked=true and zero duration", () => {
    const schedule = buildSampleSchedule();
    const restored = planToSchedule(scheduleToPlan(schedule, meta));
    const lodgings = restored.filter((s) => s.kind === "lodging");
    expect(lodgings.length).toBeGreaterThan(0);
    for (const l of lodgings) {
      expect(l.locked).toBe(true);
      expect(l.duration).toBe(0);
      expect(l.startTime).toBe(l.endTime);
      expect(["start", "end"]).toContain(l.anchor);
    }
  });

  it("suggestPlanName builds a sensible default", () => {
    const name = suggestPlanName(meta);
    expect(name).toContain("도쿄");
    expect(name).toContain("1박2일");
    expect(name).toContain("2026-05-10");
  });

  it("suggestPlanName falls back when fields are missing", () => {
    const name = suggestPlanName({});
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
});
