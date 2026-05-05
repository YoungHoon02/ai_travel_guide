/**
 * Schedule (Slot[]) ↔ Plan (nested days/items) adapter.
 *
 * The runtime SSOT is `schedule: Slot[]` (flat, used by Edit View, Co-Pilot,
 * Result page). Persistence uses the multi-level `Plan` schema from
 * `src/store/plans.js` to match a future Supabase normalization.
 *
 * Round-trip property: `planToSchedule(scheduleToPlan(s, meta))` produces a
 * schedule structurally equivalent to `s` (same slot count per day, same
 * times/names/coords). Slot ids are preserved; PlanItem.id is derived from
 * Slot.id via a stable prefix so a second round-trip is idempotent.
 *
 * @typedef {import("./plans.js").Plan} Plan
 * @typedef {import("./plans.js").PlanDay} PlanDay
 * @typedef {import("./plans.js").PlanItem} PlanItem
 */

import { getDayCount, getSlotsForDay, timeToMin, minToTime } from "./schedule.js";

const MEAL_KEYWORDS = ["맛집", "식당", "음식점", "카페", "디저트", "레스토랑", "restaurant", "cafe", "meal"];

/**
 * Map a Slot to a PlanItem.type value.
 * @param {Object} slot
 * @returns {"content" | "meal" | "lodging"}
 */
function inferItemType(slot) {
  if (slot.kind === "lodging") return "lodging";
  const cat = (slot.category ?? "").toLowerCase();
  if (MEAL_KEYWORDS.some((kw) => cat.includes(kw.toLowerCase()))) return "meal";
  return "content";
}

function durationMinutes(slot) {
  if (typeof slot.duration === "number") return slot.duration;
  if (slot.startTime && slot.endTime) {
    const d = timeToMin(slot.endTime) - timeToMin(slot.startTime);
    return d > 0 ? d : 0;
  }
  return 0;
}

/**
 * Convert a flat schedule + plan metadata into a nested Plan.
 *
 * @param {Object[]} schedule
 * @param {Object} [meta]
 * @param {string} [meta.id] — preserve plan id across saves
 * @param {string} [meta.name]
 * @param {{country: string, city: string, latlng: [number, number] | null}} [meta.destination]
 * @param {{start: string | null, end: string | null, nights: number | null, days: number | null}} [meta.dates]
 * @param {string} [meta.rawInput]
 * @param {string[]} [meta.preferences]
 * @param {Plan["status"]} [meta.status]
 * @param {string} [meta.createdAt]
 * @param {string} [meta.updatedAt]
 * @param {string | null} [meta.createdBy]
 * @param {Plan["revisions"]} [meta.revisions]
 * @returns {Plan}
 */
export function scheduleToPlan(schedule, meta = {}) {
  const safeSchedule = Array.isArray(schedule) ? schedule : [];
  const dayCount = getDayCount(safeSchedule);
  const planId = meta.id ?? null;
  const days = [];

  for (let d = 1; d <= dayCount; d += 1) {
    const dayId = `d_${planId ?? "draft"}_${d}`;
    const slots = getSlotsForDay(safeSchedule, d);
    const items = slots.map((slot, idx) => ({
      id: `i_${slot.id}`,
      dayId,
      seq: idx + 1,
      type: inferItemType(slot),
      name: slot.name ?? "",
      startTime: slot.startTime ?? null,
      endTime: slot.endTime ?? null,
      durationMin: durationMinutes(slot) || null,
      latlng: Array.isArray(slot.latlng) ? [slot.latlng[0], slot.latlng[1]] : null,
      meta: {
        slotId: slot.id,
        kind: slot.kind,
        source: slot.source ?? null,
        category: slot.category ?? null,
        area: slot.area ?? null,
        img: slot.img ?? null,
        photoUrl: slot.photoUrl ?? null,
        locked: Boolean(slot.locked),
        indoor: slot.indoor ?? null,
        approximateLatlng: slot.approximateLatlng ?? null,
        visitScore: slot.visitScore ?? null,
        llmStayNote: slot.llmStayNote ?? null,
        notes: slot.notes ?? null,
        anchor: slot.anchor ?? null,
        rating: slot.rating ?? null,
        priceLevel: slot.priceLevel ?? null,
        insights: slot.insights ?? null,
        isCustom: slot.isCustom ?? null,
        checkIn: slot.checkIn ?? null,
        checkOut: slot.checkOut ?? null,
        semanticTag: slot.semanticTag ?? null,
      },
      status: "planned",
      originalItemId: null,
    }));

    days.push({
      id: dayId,
      planId: planId ?? "",
      dayNumber: d,
      date: meta.dates?.start ? addDaysIso(meta.dates.start, d - 1) : null,
      theme: null,
      notes: null,
      items,
    });
  }

  /** @type {Plan} */
  const plan = {
    id: meta.id ?? "",
    name: meta.name ?? "새 여행 플랜",
    destination: meta.destination ?? { country: "", city: "", latlng: null },
    dates: meta.dates ?? { start: null, end: null, nights: null, days: dayCount || null },
    rawInput: meta.rawInput ?? "",
    preferences: Array.isArray(meta.preferences) ? meta.preferences : [],
    status: meta.status ?? "draft",
    createdAt: meta.createdAt ?? new Date().toISOString(),
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
    createdBy: meta.createdBy ?? null,
    days,
    revisions: Array.isArray(meta.revisions) ? meta.revisions : [],
  };
  return plan;
}

/**
 * Convert a nested Plan back into a flat schedule (Slot[]).
 *
 * Slot fields are restored from PlanItem.meta where possible. Times and
 * names always come from the top-level PlanItem fields (those are the
 * canonical persisted values).
 *
 * @param {Plan} plan
 * @returns {Object[]}
 */
export function planToSchedule(plan) {
  if (!plan || !Array.isArray(plan.days)) return [];
  /** @type {Object[]} */
  const schedule = [];

  for (const day of plan.days) {
    if (!Array.isArray(day.items)) continue;
    for (const item of day.items) {
      const m = item.meta ?? {};
      const startTime = item.startTime ?? "09:00";
      const endTime = item.endTime ?? startTime;
      const duration =
        typeof item.durationMin === "number" && item.durationMin > 0
          ? item.durationMin
          : Math.max(0, timeToMin(endTime) - timeToMin(startTime));

      const base = {
        id: m.slotId ?? item.id,
        day: day.dayNumber,
        kind: m.kind ?? (item.type === "lodging" ? "lodging" : "activity"),
        source: m.source ?? "user",
        startTime,
        endTime,
        duration,
        name: item.name ?? "",
        area: m.area ?? "",
        category: m.category ?? undefined,
        img: m.img ?? undefined,
        latlng: Array.isArray(item.latlng) ? [item.latlng[0], item.latlng[1]] : undefined,
        locked: Boolean(m.locked),
        indoor: m.indoor ?? undefined,
      };

      if (base.kind === "lodging") {
        schedule.push({
          ...base,
          duration: 0,
          endTime: startTime,
          locked: true,
          anchor: m.anchor ?? "start",
          rating: m.rating ?? undefined,
          priceLevel: m.priceLevel ?? undefined,
          photoUrl: m.photoUrl ?? base.img,
          insights: m.insights ?? undefined,
          isCustom: m.isCustom ?? false,
          checkIn: m.checkIn ?? undefined,
          checkOut: m.checkOut ?? undefined,
          notes: m.notes ?? undefined,
        });
      } else {
        schedule.push({
          ...base,
          approximateLatlng: m.approximateLatlng ?? false,
          visitScore: m.visitScore ?? undefined,
          llmStayNote: m.llmStayNote ?? undefined,
          notes: m.notes ?? undefined,
          semanticTag: m.semanticTag ?? undefined,
        });
      }
    }
  }
  return schedule;
}

/** Add `n` days to an ISO YYYY-MM-DD string. Returns null on invalid input. */
function addDaysIso(isoDate, n) {
  if (!isoDate || typeof isoDate !== "string") return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Suggested human-readable plan name from metadata. */
export function suggestPlanName(meta = {}) {
  const city = meta.destination?.city || meta.destination?.country || "여행";
  const nights = meta.dates?.nights;
  const days = meta.dates?.days;
  const trip = nights && days ? `${nights}박${days}일` : days ? `${days}일` : "";
  const dateStr = meta.dates?.start ?? new Date().toISOString().slice(0, 10);
  return [city, trip, `— ${dateStr}`].filter(Boolean).join(" ").replace(/\s+—/, " —");
}

// Re-exported time helpers for downstream callers / tests.
export { timeToMin, minToTime };
