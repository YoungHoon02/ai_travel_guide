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

/**
 * Map a startTime to a coarse semantic tag the LLM can reason over.
 * Bands chosen to match common Korean travel-day phrasing:
 *   06-11 → "morning"   (오전, 아침)
 *   11-13 → "lunch"     (점심)
 *   13-17 → "afternoon" (오후)
 *   17-21 → "dinner"    (저녁)
 *   21+ / pre-06 → "night" (밤, 늦은 시간)
 */
export function semanticTagForTime(startTime) {
  if (!startTime || typeof startTime !== "string") return null;
  const [h] = startTime.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h)) return null;
  if (h < 6) return "night";
  if (h < 11) return "morning";
  if (h < 13) return "lunch";
  if (h < 17) return "afternoon";
  if (h < 21) return "dinner";
  return "night";
}

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
      return { ...a, semanticTag: semanticTagForTime(a.startTime) };
    }
    cursor += transitMinutes; // transit into this activity
    const start = minToTime(cursor);
    cursor += a.duration;
    const end = minToTime(cursor);
    return { ...a, startTime: start, endTime: end, semanticTag: semanticTagForTime(start) };
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
 * Compute a stable hash for the schedule's structural identity. Used as a
 * race-condition guard: when an LLM call takes 5-10s and the user edits a
 * slot in the meantime, we don't want the LLM response to silently overwrite
 * the user's edit. The LLM is asked to echo the same hash; on apply we
 * compare against the current schedule's hash.
 *
 * Hash inputs are id + day + startTime + endTime + name + locked. Insertion
 * order doesn't matter (slots are sorted before hashing). Output is a short
 * base36 string — not cryptographic, just collision-resistant enough for
 * single-user racing windows.
 */
export function scheduleHash(schedule) {
  if (!Array.isArray(schedule) || schedule.length === 0) return "0";
  const sorted = [...schedule].sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    const ta = timeToMin(a.startTime ?? "00:00");
    const tb = timeToMin(b.startTime ?? "00:00");
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
  // Fast non-crypto string hash (djb2 variant).
  let h = 5381;
  for (const s of sorted) {
    const key = `${s.id}|${s.day}|${s.startTime}|${s.endTime}|${s.name ?? ""}|${s.locked ? 1 : 0}`;
    for (let i = 0; i < key.length; i += 1) {
      h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    }
  }
  return (h >>> 0).toString(36);
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
export function applyPatches(schedule, patches, { force = false, expectedHash = null, allowedDays = null } = {}) {
  if (!Array.isArray(patches) || patches.length === 0) {
    return { applied: false, merged: schedule, report: "no patches", touchedDays: [] };
  }
  // Race-condition guard: if caller passes the hash the LLM was responding to
  // and the schedule has since changed, reject the patch entirely so the
  // user's intervening edits aren't overwritten.
  if (expectedHash != null) {
    const currentHash = scheduleHash(schedule);
    if (currentHash !== expectedHash) {
      return {
        applied: false,
        merged: schedule,
        report: `schedule changed during LLM call (hash ${expectedHash} → ${currentHash})`,
        touchedDays: [],
        staleHash: true,
      };
    }
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
      if (allowedDays && !allowedDays.has(existing.day)) { skipped.push(`replace: day ${existing.day} outside scope`); continue; }
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
      if (allowedDays && !allowedDays.has(existing.day)) { skipped.push(`remove: day ${existing.day} outside scope`); continue; }
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
      if (allowedDays && !allowedDays.has(slot.day)) { skipped.push(`insert: day ${slot.day} outside scope`); continue; }
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
 *
 * Optional filters reduce token cost when only part of the trip is relevant:
 *   - days?: number[] — restrict to these day numbers (e.g. [2] for "today")
 *   - slotIds?: Set<string>|string[] — restrict to these slots
 *   - includeLodgingAnchors?: boolean (default true) — include the locked
 *     anchors of any included day so LLM has the day's bounds
 *
 * When both filters are passed, slot-id wins for activity slots and lodging
 * anchors are pulled from the included slots' days.
 */
export function scheduleToLLMText(schedule, opts = {}) {
  const { days: daysFilter, slotIds, includeLodgingAnchors = true } = opts;
  const slotIdSet = slotIds instanceof Set ? slotIds : (Array.isArray(slotIds) ? new Set(slotIds) : null);

  let included = schedule;
  if (slotIdSet) {
    const matched = schedule.filter((s) => slotIdSet.has(s.id));
    if (includeLodgingAnchors) {
      const matchedDays = new Set(matched.map((s) => s.day));
      const anchors = schedule.filter((s) => s.kind === "lodging" && matchedDays.has(s.day));
      const merged = new Map();
      for (const s of [...matched, ...anchors]) merged.set(s.id, s);
      included = [...merged.values()];
    } else {
      included = matched;
    }
  } else if (Array.isArray(daysFilter) && daysFilter.length > 0) {
    const dset = new Set(daysFilter);
    included = schedule.filter((s) => dset.has(s.day));
  }

  const days = new Set(included.map((s) => s.day));
  const lines = [];
  for (const d of [...days].sort((a, b) => a - b)) {
    // Filter to only the included slots for this day, then sort like getSlotsForDay
    const slots = included
      .filter((s) => s.day === d)
      .sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
    lines.push(`--- DAY ${d} ---`);
    for (const s of slots) {
      const tag = s.kind === "lodging" ? `[LODGING${s.anchor === "start" ? "/START" : "/END"}]` : "[ACTIVITY]";
      const locked = s.locked ? " LOCKED" : "";
      const indoor = s.indoor ? "indoor" : "outdoor";
      // semanticTag derived in recalculateDayTimes — fall back to live compute
      // for slots that pre-date Phase 5 (still in store from older builds).
      const sem = s.semanticTag ?? semanticTagForTime(s.startTime);
      const semStr = s.kind === "activity" && sem ? ` [${sem}]` : "";
      lines.push(
        `  ${s.startTime}-${s.endTime} ${tag}${semStr} ${s.name} (${s.area}, ${indoor})${locked} id=${s.id}`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Heuristic scope detector for Co-Pilot — analyzes user message to decide
 * which days are relevant, so we can pass a smaller schedule to the LLM.
 *
 * Returns { days?: number[], reason: string }. Caller forwards days to
 * scheduleToLLMText when present, or uses the full schedule when absent.
 *
 * Detection (Korean):
 *   - "오늘", "지금" → today's day (if currentDay provided)
 *   - "내일" → today + 1
 *   - "DAY 3" / "3일차" / "3일째" → that specific day
 *   - "전체", "모든 일정" / no temporal cue → null (= full schedule)
 */
export function detectScopeFromMessage(message, { currentDay = null, dayCount = null } = {}) {
  const text = String(message ?? "");
  if (!text) return { days: null, reason: "empty" };
  if (/전체|모든 일정|trip|whole|all/i.test(text)) return { days: null, reason: "explicit-all" };

  // Explicit day: "DAY N", "N일차", "N일째"
  const dayMatch = text.match(/(?:DAY\s*|\b)(\d{1,2})\s*(?:일차|일째)?/i);
  if (dayMatch) {
    const n = parseInt(dayMatch[1], 10);
    if (Number.isFinite(n) && n >= 1 && (dayCount == null || n <= dayCount)) {
      return { days: [n], reason: `explicit-day-${n}` };
    }
  }

  if (currentDay) {
    if (/오늘|지금|now|today/i.test(text)) return { days: [currentDay], reason: "today" };
    if (/내일|tomorrow/i.test(text) && (dayCount == null || currentDay + 1 <= dayCount)) {
      return { days: [currentDay + 1], reason: "tomorrow" };
    }
    // Early-end / rest intent without explicit day reference → current day only.
    // Treats "일찍 쉬고 싶다" as a single-day event, not a multi-day policy.
    if (/일찍|조기|쉬고|마무리|끝내|그만|퇴근|호텔로|숙소로|종료/.test(text)) {
      return { days: [currentDay], reason: "early-end-today" };
    }
  }
  return { days: null, reason: "no-temporal-cue" };
}
