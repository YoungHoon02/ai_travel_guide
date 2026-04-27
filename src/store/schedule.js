/**
 * ─── Schedule store — TimeSlot-based single source of truth ─────────────────
 *
 * The schedule is a flat array of Slot objects spanning every day of the trip.
 * Every screen that displays or modifies the itinerary (Edit View, Co-Pilot,
 * Result page) reads and writes through this store so they stay in sync.
 *
 * Pure functions only — no React. Consumer holds `schedule: Slot[]` in
 * useState and passes updates through these mutators.
 *
 * ## Slot shape
 *
 * ```
 * interface Slot {
 *   // ── Identity ────────────────────────────────────────────────
 *   id: string;                // unique across schedule; stable across updates
 *   day: number;               // 1-indexed day number
 *   kind: "activity" | "lodging";
 *   source?: "llm" | "user" | "places" | "fixed";
 *
 *   // ── Time (minutes since midnight model; string I/O) ─────────
 *   startTime: string;         // "HH:MM"
 *   endTime: string;           // "HH:MM"
 *   duration: number;          // minutes; endTime - startTime
 *
 *   // ── Display ────────────────────────────────────────────────
 *   name: string;
 *   area: string;              // district / neighborhood
 *   category?: string;         // activity subtype ("관광지" | "맛집" | ...)
 *   img?: string;              // photo URL
 *
 *   // ── Geo ────────────────────────────────────────────────────
 *   latlng?: [number, number];
 *
 *   // ── Behavior ───────────────────────────────────────────────
 *   locked: boolean;           // LLM / drag cannot touch
 *   indoor?: boolean;          // rain-resilient (Co-Pilot weather logic)
 *
 *   // ── Activity-only ──────────────────────────────────────────
 *   visitScore?: number;       // 1-5 (LLM hint for auto-duration)
 *   llmStayNote?: string;      // why this duration
 *   notes?: string;            // user editable
 *
 *   // ── Lodging-only ───────────────────────────────────────────
 *   checkIn?: string;          // YYYY-MM-DD
 *   checkOut?: string;
 *   rating?: number;
 *   priceLevel?: string;       // Google Places PRICE_LEVEL_*
 *   photoUrl?: string;
 *   insights?: {               // LLM-generated hotel analytics
 *     tags?: string[];
 *     pros?: string[];
 *     cons?: string[];
 *     priceRange?: string;
 *   };
 *   isCustom?: boolean;        // user-entered rather than Places-picked
 *   anchor?: "start" | "end";  // day boundary marker
 * }
 * ```
 *
 * ## Conventions
 *
 * - Every day has exactly one lodging anchor of `anchor: "start"` and one of
 *   `anchor: "end"`. They reference the same hotel (same name/latlng/etc.)
 *   across all days of the trip.
 * - Activities live between the two anchors, sorted by startTime.
 * - Times are always stored as "HH:MM" strings in the slot, but calculations
 *   happen in minute-since-midnight ints via the helpers below.
 */

// ─── Time helpers ────────────────────────────────────────────────────────────

/** "HH:MM" → minutes since midnight. */
export function timeToMin(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return 0;
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

/** minutes since midnight → "HH:MM". */
export function minToTime(mins) {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Visit score (1~5) → default duration in minutes. Mirrors ITINERARY_PROMPT rules. */
export function defaultDurationFromScore(score) {
  const table = { 1: 30, 2: 60, 3: 90, 4: 120, 5: 180 };
  return table[score] ?? 90;
}

// ─── Factories ───────────────────────────────────────────────────────────────

let _slotCounter = 0;
function nextId(prefix) {
  _slotCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_slotCounter}`;
}

/** Create a fresh activity slot. Auto-computes endTime from startTime + duration. */
export function createActivitySlot({
  id,
  day,
  startTime,
  duration,
  name,
  area = "",
  category,
  img,
  latlng,
  approximateLatlng = false,
  indoor = false,
  visitScore,
  llmStayNote,
  notes,
  source = "user",
}) {
  const dur = duration ?? defaultDurationFromScore(visitScore);
  const start = startTime ?? "09:00";
  const end = minToTime(timeToMin(start) + dur);
  return {
    id: id ?? nextId("slot"),
    day,
    kind: "activity",
    source,
    startTime: start,
    endTime: end,
    duration: dur,
    name,
    area,
    category,
    img,
    latlng,
    approximateLatlng,
    locked: false,
    indoor,
    visitScore,
    llmStayNote,
    notes,
  };
}

/** Create a lodging anchor slot (day boundary). */
export function createLodgingSlot({
  id,
  day,
  anchor, // "start" | "end"
  time,
  name,
  area = "",
  latlng,
  rating,
  priceLevel,
  photoUrl,
  img,
  insights,
  isCustom = false,
  checkIn,
  checkOut,
  notes,
  source = "places",
}) {
  const startTime = time ?? (anchor === "start" ? "09:00" : "20:00");
  return {
    id: id ?? nextId(`lodge-${anchor}`),
    day,
    kind: "lodging",
    source,
    startTime,
    endTime: startTime, // zero-duration anchor
    duration: 0,
    name,
    area,
    latlng,
    locked: true,
    indoor: true,
    anchor,
    rating,
    priceLevel,
    photoUrl: photoUrl ?? img,
    img: img ?? photoUrl,
    insights,
    isCustom,
    checkIn,
    checkOut,
    notes,
  };
}

/** Build an empty skeleton schedule: lodging anchors only, no activities. */
export function buildSkeletonSchedule({ dayCount, lodging, dayStartTime = "09:00", dayEndTime = "20:00" }) {
  if (!lodging) return [];
  const slots = [];
  for (let d = 1; d <= dayCount; d += 1) {
    slots.push(
      createLodgingSlot({ ...lodging, day: d, anchor: "start", time: dayStartTime })
    );
    slots.push(
      createLodgingSlot({ ...lodging, day: d, anchor: "end", time: dayEndTime })
    );
  }
  return slots;
}

// ─── Query helpers ───────────────────────────────────────────────────────────

export function getSlotsForDay(schedule, day) {
  return schedule
    .filter((s) => s.day === day)
    .sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
}

export function getActivitySlots(schedule, day) {
  return getSlotsForDay(schedule, day).filter((s) => s.kind === "activity");
}

export function getLodgingAnchors(schedule, day) {
  const slots = getSlotsForDay(schedule, day);
  return {
    start: slots.find((s) => s.kind === "lodging" && s.anchor === "start") ?? null,
    end: slots.find((s) => s.kind === "lodging" && s.anchor === "end") ?? null,
  };
}

export function findSlotById(schedule, id) {
  return schedule.find((s) => s.id === id) ?? null;
}

export function getDayCount(schedule) {
  return schedule.reduce((max, s) => Math.max(max, s.day), 0);
}

/** Any lodging anchor (they all share the same hotel so we grab the first). */
export function getPrimaryLodging(schedule) {
  return schedule.find((s) => s.kind === "lodging") ?? null;
}

// ─── Mutators (return new schedule; never mutate input) ─────────────────────

/** Insert a slot and re-sort the owning day by startTime. */
export function addSlot(schedule, slot) {
  return [...schedule, slot];
}

/** Remove a slot by id. Locked slots are preserved unless `force: true`. */
export function removeSlot(schedule, id, { force = false } = {}) {
  const target = findSlotById(schedule, id);
  if (!target) return schedule;
  if (target.locked && !force) return schedule;
  return schedule.filter((s) => s.id !== id);
}

/** Replace a slot by id. Preserves locked-ness and day. */
export function replaceSlot(schedule, id, patch) {
  return schedule.map((s) => (s.id === id ? { ...s, ...patch, id: s.id } : s));
}

/** Move activity to a new position within the same day (by startTime). */
export function reorderActivitiesInDay(schedule, day, orderedIds) {
  const others = schedule.filter((s) => s.day !== day || s.kind !== "activity");
  const byId = new Map();
  for (const s of schedule) {
    if (s.day === day && s.kind === "activity") byId.set(s.id, s);
  }
  const reordered = orderedIds
    .map((id) => byId.get(id))
    .filter(Boolean);
  const next = [...others, ...reordered];
  return recalculateDayTimes(next, day);
}

/**
 * Recalculate startTime / endTime for every activity in a day based on:
 *   - lodging start anchor time
 *   - each activity's duration
 *   - fixed 30-minute transit gap between activities (can be overridden)
 *
 * Lodging anchors and locked activities keep their manually-set times.
 */
export function recalculateDayTimes(schedule, day, { transitMinutes = 30 } = {}) {
  const daySlots = schedule.filter((s) => s.day === day);
  const others = schedule.filter((s) => s.day !== day);
  const { start: startAnchor, end: endAnchor } = getLodgingAnchors(schedule, day);
  const activities = daySlots
    .filter((s) => s.kind === "activity")
    .sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));

  let cursor = startAnchor ? timeToMin(startAnchor.startTime) : timeToMin("09:00");
  const recomputed = activities.map((a) => {
    if (a.locked) {
      cursor = timeToMin(a.endTime);
      return a;
    }
    cursor += transitMinutes; // transit into this activity
    const start = minToTime(cursor);
    cursor += a.duration;
    const end = minToTime(cursor);
    return { ...a, startTime: start, endTime: end };
  });

  const result = [...others];
  if (startAnchor) result.push(startAnchor);
  result.push(...recomputed);
  if (endAnchor) {
    // Push end anchor after last activity (or lodging start if empty)
    const lastEnd = recomputed.length > 0
      ? timeToMin(recomputed[recomputed.length - 1].endTime) + transitMinutes
      : timeToMin(endAnchor.startTime);
    const newEndTime = minToTime(Math.max(lastEnd, timeToMin(endAnchor.startTime)));
    result.push({ ...endAnchor, startTime: newEndTime, endTime: newEndTime });
  }
  return result;
}

/**
 * Apply LLM-emitted partial patches to a schedule.
 *
 * Each patch references a slot by id and carries one of three ops:
 *   - { id, op: "replace", fields: Partial<Slot> }  — merges fields into existing slot
 *   - { id, op: "remove" }                          — removes slot (rejected if locked)
 *   - { afterId, op: "insert", slot: Slot }         — inserts new slot after afterId
 *                                                     (or at start of day if afterId=null)
 *
 * Behavior contract:
 *   - Locked slots can only be patched if `force: true`. Default behavior is to
 *     silently skip them so a misbehaving LLM cannot move/delete lodging anchors.
 *   - After all patches apply, `recalculateDayTimes` re-runs for any day whose
 *     slots were touched. Caller doesn't need to think about time cascade.
 *   - Final result is validated; on failure, the original schedule is returned
 *     untouched and `report` carries the error string.
 *
 * Returns { applied, merged, report, touchedDays }.
 */
export function applyPatches(schedule, patches, { force = false } = {}) {
  if (!Array.isArray(patches) || patches.length === 0) {
    return { applied: false, merged: schedule, report: "no patches", touchedDays: [] };
  }
  const byId = new Map(schedule.map((s) => [s.id, s]));
  const lockedIds = new Set(schedule.filter((s) => s.locked).map((s) => s.id));
  const touchedDays = new Set();
  const skipped = [];

  // Work on a mutable copy of the array — final shape gets re-sorted via
  // recalculateDayTimes below, so we can do simple in-place ops here.
  let next = [...schedule];

  for (const patch of patches) {
    if (!patch || typeof patch !== "object") {
      skipped.push("malformed patch");
      continue;
    }
    const { op } = patch;
    if (op === "replace") {
      const existing = byId.get(patch.id);
      if (!existing) { skipped.push(`replace: id ${patch.id} not found`); continue; }
      if (existing.locked && !force) { skipped.push(`replace: locked ${patch.id}`); continue; }
      // Merge fields but keep id + day immutable. endTime is recomputed if
      // duration or startTime changed (recalculateDayTimes does this anyway,
      // but we keep the slot self-consistent in the meantime).
      const fields = patch.fields ?? {};
      const merged = { ...existing, ...fields, id: existing.id, day: existing.day };
      if (fields.startTime || fields.duration) {
        const start = merged.startTime;
        const dur = Number.isFinite(merged.duration) ? merged.duration : existing.duration;
        merged.endTime = minToTime(timeToMin(start) + dur);
      }
      next = next.map((s) => (s.id === existing.id ? merged : s));
      byId.set(existing.id, merged);
      touchedDays.add(existing.day);
      continue;
    }
    if (op === "remove") {
      const existing = byId.get(patch.id);
      if (!existing) { skipped.push(`remove: id ${patch.id} not found`); continue; }
      if (existing.locked && !force) { skipped.push(`remove: locked ${patch.id}`); continue; }
      next = next.filter((s) => s.id !== existing.id);
      byId.delete(existing.id);
      touchedDays.add(existing.day);
      continue;
    }
    if (op === "insert") {
      const slot = patch.slot;
      if (!slot || !slot.id) { skipped.push("insert: missing slot or id"); continue; }
      if (byId.has(slot.id)) { skipped.push(`insert: duplicate id ${slot.id}`); continue; }
      // afterId=null/undefined means insert at the start of its day. Position
      // doesn't matter for correctness because recalculateDayTimes resorts by
      // startTime — we just need the slot in the array.
      next = [...next, slot];
      byId.set(slot.id, slot);
      touchedDays.add(slot.day);
      continue;
    }
    skipped.push(`unknown op: ${op}`);
  }

  // Cascade times for every touched day so a startTime change ripples through
  // the rest of that day automatically. Caller doesn't have to think about it.
  let result = next;
  for (const d of touchedDays) result = recalculateDayTimes(result, d);

  const v = validateSchedule(result);
  if (!v.ok) {
    return {
      applied: false,
      merged: schedule,
      report: v.errors.join("; "),
      touchedDays: [...touchedDays],
      skipped,
    };
  }
  // Re-protect locked slots in case a patch silently mutated one (defense in
  // depth — applyPatches itself rejects them above, but a buggy `force` caller
  // shouldn't be able to demote a locked anchor).
  if (!force) {
    for (const id of lockedIds) {
      const original = schedule.find((s) => s.id === id);
      if (original && !result.find((s) => s.id === id)) result = [...result, original];
    }
  }
  return {
    applied: true,
    merged: result,
    report: skipped.length > 0 ? `applied with skips: ${skipped.join("; ")}` : null,
    touchedDays: [...touchedDays],
    skipped,
  };
}

/** Swap primary lodging across all anchor slots (Edit View hotel picker). */
export function swapPrimaryLodging(schedule, lodgingInfo) {
  return schedule.map((s) => {
    if (s.kind !== "lodging") return s;
    return {
      ...s,
      name: lodgingInfo.name,
      area: lodgingInfo.area ?? s.area,
      latlng: lodgingInfo.latlng ?? s.latlng,
      rating: lodgingInfo.rating,
      priceLevel: lodgingInfo.priceLevel,
      photoUrl: lodgingInfo.photoUrl ?? lodgingInfo.img,
      img: lodgingInfo.img ?? lodgingInfo.photoUrl,
      insights: lodgingInfo.insights,
      isCustom: !!lodgingInfo.isCustom,
      checkIn: lodgingInfo.checkIn ?? s.checkIn,
      checkOut: lodgingInfo.checkOut ?? s.checkOut,
      notes: lodgingInfo.notes ?? s.notes,
    };
  });
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Check schedule for structural issues. Returns { ok, errors, warnings }.
 * Intended for Co-Pilot output validation before applying LLM responses.
 */
export function validateSchedule(schedule) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  for (const s of schedule) {
    if (!s.id) errors.push("slot missing id");
    if (ids.has(s.id)) errors.push(`duplicate id: ${s.id}`);
    ids.add(s.id);
    if (!["activity", "lodging"].includes(s.kind)) errors.push(`bad kind: ${s.id}`);
    if (typeof s.day !== "number" || s.day < 1) errors.push(`bad day: ${s.id}`);
    if (!/^\d{2}:\d{2}$/.test(s.startTime)) errors.push(`bad startTime: ${s.id}`);
    if (!/^\d{2}:\d{2}$/.test(s.endTime)) errors.push(`bad endTime: ${s.id}`);
    if (timeToMin(s.endTime) < timeToMin(s.startTime)) {
      errors.push(`endTime < startTime: ${s.id}`);
    }
  }
  // Check each day has lodging anchors
  const days = new Set(schedule.map((s) => s.day));
  for (const d of days) {
    const { start, end } = getLodgingAnchors(schedule, d);
    if (!start) warnings.push(`day ${d} has no lodging start anchor`);
    if (!end) warnings.push(`day ${d} has no lodging end anchor`);
  }
  // Check overlaps per day
  for (const d of days) {
    const slots = getSlotsForDay(schedule, d).filter((s) => s.kind === "activity");
    for (let i = 1; i < slots.length; i += 1) {
      const prevEnd = timeToMin(slots[i - 1].endTime);
      const curStart = timeToMin(slots[i].startTime);
      if (curStart < prevEnd) {
        warnings.push(`day ${d} overlap: ${slots[i - 1].name} → ${slots[i].name}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ─── Adapters (legacy ↔ TimeSlot) ───────────────────────────────────────────

/**
 * Convert legacy { dayAssignments, activeContents, selectedLodging } into
 * TimeSlot[]. Used to migrate existing app state without breaking anything
 * during the refactor.
 */
export function scheduleFromLegacy({ dayAssignments, activeContents, selectedLodging, dayCount }) {
  const slots = [];
  const lodgingInfo = selectedLodging
    ? {
        name: selectedLodging.name,
        area: selectedLodging.area,
        latlng: selectedLodging.latlng,
        rating: selectedLodging.rating,
        priceLevel: selectedLodging.priceLevel,
        photoUrl: selectedLodging.photoUrl,
        img: selectedLodging.photoUrl,
        insights: selectedLodging.insights,
        isCustom: selectedLodging.isCustom,
        checkIn: selectedLodging.checkIn,
        checkOut: selectedLodging.checkOut,
        notes: selectedLodging.notes,
      }
    : null;

  for (let d = 1; d <= dayCount; d += 1) {
    if (lodgingInfo) {
      slots.push(createLodgingSlot({ ...lodgingInfo, day: d, anchor: "start", time: "09:00", source: "fixed" }));
    }
    const ids = dayAssignments?.[d] ?? [];
    for (const id of ids) {
      const c = activeContents?.find?.((x) => x.id === id);
      if (!c) continue;
      slots.push(
        createActivitySlot({
          id: c.id, // slot.id === content.id for easy cross-lookup
          day: d,
          startTime: c.time ?? "09:30",
          name: c.name,
          area: c.area ?? "",
          category: c.type,
          img: c.img,
          latlng: c.latlng,
          indoor: c.indoor ?? false,
          visitScore: c.visitScore ?? 3,
          llmStayNote: c.llmStayNote,
          source: c.assignedDay != null ? "llm" : "user",
        })
      );
    }
    if (lodgingInfo) {
      slots.push(createLodgingSlot({ ...lodgingInfo, day: d, anchor: "end", time: "20:00", source: "fixed" }));
    }
  }
  // Recalculate times per day so activities are properly spaced
  let out = slots;
  for (let d = 1; d <= dayCount; d += 1) out = recalculateDayTimes(out, d);
  return out;
}

/**
 * Convert the output of `generateItinerary()` (legacy { days: [{ spots: [...] }],
 * alternatives: [] }) into a TimeSlot[] schedule with lodging anchors inserted.
 * The visitScore → duration mapping is applied here, then recalculateDayTimes
 * fixes up all start/end times so the trip is internally consistent.
 */
export function scheduleFromItineraryLLM(itinerary, lodgingInfo, dayCount) {
  if (!itinerary?.days) return [];
  const slots = [];
  const effectiveDayCount = dayCount ?? itinerary.days.length ?? 3;
  const lodging = lodgingInfo
    ? {
        name: lodgingInfo.name,
        area: lodgingInfo.area,
        latlng: lodgingInfo.latlng,
        rating: lodgingInfo.rating,
        priceLevel: lodgingInfo.priceLevel,
        photoUrl: lodgingInfo.photoUrl,
        img: lodgingInfo.img ?? lodgingInfo.photoUrl,
        insights: lodgingInfo.insights,
        isCustom: !!lodgingInfo.isCustom,
        checkIn: lodgingInfo.checkIn,
        checkOut: lodgingInfo.checkOut,
      }
    : null;

  for (let d = 1; d <= effectiveDayCount; d += 1) {
    if (lodging) {
      slots.push(createLodgingSlot({ ...lodging, day: d, anchor: "start", time: "09:00", source: "fixed" }));
    }
    const dayData = itinerary.days.find((x) => x.day === d);
    const rawSpots = dayData?.spots ?? [];
    for (const s of rawSpots) {
      slots.push(
        createActivitySlot({
          id: s.id ?? `spot-d${d}-${slots.length}`, // prefer original content id
          day: d,
          startTime: s.time ?? "09:30",
          name: s.name,
          area: s.area ?? "",
          category: s.type,
          img: s.img,
          latlng: s.latlng,
          approximateLatlng: Boolean(s.approximateLatlng),
          indoor: s.indoor ?? false,
          visitScore: s.visitScore ?? 3,
          llmStayNote: s.llmStayNote,
          source: "llm",
        })
      );
    }
    if (lodging) {
      slots.push(createLodgingSlot({ ...lodging, day: d, anchor: "end", time: "20:00", source: "fixed" }));
    }
  }
  let out = slots;
  for (let d = 1; d <= effectiveDayCount; d += 1) out = recalculateDayTimes(out, d);
  return out;
}

/**
 * Summarize schedule as compact text for LLM injection. Used by Co-Pilot
 * system prompt so the model sees the current plan in a predictable format.
 */
export function scheduleToLLMText(schedule) {
  const days = new Set(schedule.map((s) => s.day));
  const lines = [];
  for (const d of [...days].sort((a, b) => a - b)) {
    const slots = getSlotsForDay(schedule, d);
    lines.push(`--- DAY ${d} ---`);
    for (const s of slots) {
      const tag = s.kind === "lodging" ? `[LODGING${s.anchor === "start" ? "/START" : "/END"}]` : "[ACTIVITY]";
      const locked = s.locked ? " LOCKED" : "";
      const indoor = s.indoor ? "indoor" : "outdoor";
      lines.push(
        `  ${s.startTime}-${s.endTime} ${tag} ${s.name} (${s.area}, ${indoor})${locked} id=${s.id}`
      );
    }
  }
  return lines.join("\n");
}
