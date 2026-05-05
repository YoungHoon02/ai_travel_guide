/**
 * Pure utility functions extracted from App.jsx for testability.
 * These functions have no side effects and no dependencies on browser APIs,
 * React state, or external services.
 */

// ─── Time utilities ───────────────────────────────────────────────────────────

/** Parse "HH:MM" string to total minutes since midnight. */
export function timeToMinutes(hhmm) {
  const [h, m] = (hhmm ?? "00:00").split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Convert total minutes since midnight back to "HH:MM" string. */
export function minutesToTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ─── Schedule progress ────────────────────────────────────────────────────────

/**
 * TimeSlot-native progress calculator for the unified schedule store.
 *
 * Operates on Slot[] (kind: "activity"|"lodging", startTime, day):
 *   - Skips lodging anchors (only activity slots count toward done/remaining)
 *   - Multi-day aware: slots in earlier days are auto-done, later days remaining,
 *     same-day slots compared by startTime against currentTimeStr
 *   - currentDay defaults to 1 (trip start) when caller can't compute it
 */
export function calcSlotProgress(schedule, currentTimeStr, currentDay = 1) {
  const nowMins = timeToMinutes(currentTimeStr);
  const activities = (schedule ?? [])
    .filter((s) => s?.kind === "activity")
    .slice()
    .sort((a, b) => {
      if (a.day !== b.day) return a.day - b.day;
      return timeToMinutes(a.startTime) - timeToMinutes(b.startTime);
    });
  const done = [];
  const remaining = [];
  for (const s of activities) {
    if (s.day < currentDay) { done.push(s); continue; }
    if (s.day > currentDay) { remaining.push(s); continue; }
    if (timeToMinutes(s.startTime) < nowMins) done.push(s);
    else remaining.push(s);
  }
  return { done, remaining, next: remaining[0] ?? null, nowMins };
}

// ─── HTML escape ─────────────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ─── Env / rendering helpers ────────────────────────────────────────────────

const TRUTHY_ENV_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSY_ENV_VALUES = new Set(["false", "0", "no", "off", ""]);

/** Parse common truthy/falsey environment strings to boolean. */
export function parseBooleanEnv(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (TRUTHY_ENV_VALUES.has(normalized)) return true;
  if (FALSY_ENV_VALUES.has(normalized)) return false;
  return defaultValue;
}

/**
 * Replace WebGLRenderer.forceContextLoss with a quiet disposer so unmounts
 * don't spam "Context Lost" logs in dev/StrictMode while still releasing GL.
 */
export function softenContextLoss(gl) {
  if (!gl || typeof gl.forceContextLoss !== "function") return;
  const dispose = typeof gl.dispose === "function" ? gl.dispose.bind(gl) : null;
  gl.forceContextLoss = () => { if (dispose) dispose(); };
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Squared Euclidean distance between two [lat, lng] pairs. */
export function distSq(a, b) {
  const dy = a[0] - b[0];
  const dx = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** Haversine distance in metres between two [lat, lng] pairs. */
export function haversineM(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) *
      Math.cos((b[0] * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Find the nearest activity slot for the given day and user position.
 *
 * @param {Object[]} schedule  Slot[]
 * @param {{lat: number, lng: number}} userLatLng
 * @param {number} currentDay
 * @returns {{ slot: Object|null, distM: number, proximity: "arrived"|"nearby"|"away"|"unknown" }}
 */
export function nearestSlot(schedule, userLatLng, currentDay) {
  if (!userLatLng || !Array.isArray(schedule)) {
    return { slot: null, distM: Infinity, proximity: "unknown" };
  }
  const userPos = [userLatLng.lat, userLatLng.lng];
  const candidates = schedule.filter(
    (s) => s.kind === "activity" && s.day === currentDay && Array.isArray(s.latlng)
  );
  if (candidates.length === 0) return { slot: null, distM: Infinity, proximity: "unknown" };

  let best = null;
  let bestDist = Infinity;
  for (const s of candidates) {
    const d = haversineM(userPos, s.latlng);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  const proximity =
    bestDist <= 200 ? "arrived" :
    bestDist <= 2000 ? "nearby" : "away";
  return { slot: best, distM: Math.round(bestDist), proximity };
}

/**
 * Nearest-neighbour ordering: start from `originLatLng`, always pick the
 * closest remaining spot.
 */
export function orderNearestNeighborFrom(spots, originLatLng) {
  if (spots.length === 0) return [];
  const remaining = [...spots];
  const ordered = [];
  let cur = originLatLng;
  while (remaining.length) {
    let bestI = 0;
    let bestD = Infinity;
    remaining.forEach((p, i) => {
      const d = distSq(cur, p.latlng);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    const next = remaining.splice(bestI, 1)[0];
    ordered.push(next);
    cur = next.latlng;
  }
  return ordered;
}

/**
 * Build a visually offset polyline path between a list of lat/lng points so
 * that routes for different travel modes look distinct on the map.
 */
export function buildTransitLikeRoute(points, moveId) {
  if (points.length < 2) return points;
  const route = [];
  const bendScale = moveId === "taxi" ? 0.0035 : moveId === "car" ? 0.0052 : 0.0045;

  for (let i = 0; i < points.length - 1; i += 1) {
    const [lat1, lng1] = points[i];
    const [lat2, lng2] = points[i + 1];
    const midLat = (lat1 + lat2) / 2;
    const midLng = (lng1 + lng2) / 2;
    const bend = bendScale * (i + 1);
    const phase = moveId === "car" ? 0.35 : 0.2;

    route.push(
      [lat1, lng1],
      [lat1, midLng - bend],
      [midLat + bend * phase, midLng - bend * (1 + phase)],
      [midLat + bend * 0.5, lng2 + bend * 0.25],
      [lat2, lng2]
    );
  }
  return route;
}

// ─── Score helpers ────────────────────────────────────────────────────────────

/**
 * Sum the `visitScore` values for a list of spot IDs, using the provided
 * CONTENTS lookup array.
 */
export function sumVisitScores(ids, contents) {
  return ids.reduce((s, id) => s + (contents.find((c) => c.id === id)?.visitScore ?? 0), 0);
}

/**
 * Assign spot IDs to 3 days using nearest-neighbour ordering from the lodging,
 * splitting when the cumulative visitScore for a day reaches the per-day target.
 */
export function assignOptimalDays(ids, lodgingLatLng, contents) {
  const spots = ids.map((id) => contents.find((c) => c.id === id)).filter(Boolean);
  if (spots.length === 0) return { 1: [], 2: [], 3: [] };
  const ordered = orderNearestNeighborFrom(spots, lodgingLatLng);
  const totalScore = ordered.reduce((s, p) => s + (p.visitScore ?? 3), 0);
  const targetPerDay = totalScore / 3;
  const buckets = { 1: [], 2: [], 3: [] };
  let day = 1;
  let daySum = 0;
  for (const p of ordered) {
    const sc = p.visitScore ?? 3;
    if (day < 3 && daySum >= targetPerDay && buckets[day].length > 0) {
      day += 1;
      daySum = 0;
    }
    buckets[day].push(p.id);
    daySum += sc;
  }
  return buckets;
}

