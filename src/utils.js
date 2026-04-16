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
 * Given a schedule array (items with a `time` field "HH:MM") and the current
 * time as "HH:MM", return lists of done/remaining items plus the next item.
 */
export function calcProgress(schedule, currentTimeStr) {
  const nowMins = timeToMinutes(currentTimeStr);
  const done = schedule.filter((item) => timeToMinutes(item.time) < nowMins);
  const remaining = schedule.filter((item) => timeToMinutes(item.time) >= nowMins);
  const next = remaining[0] ?? null;
  return { done, remaining, next, nowMins };
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

// ─── LLM simulation ──────────────────────────────────────────────────────────

/**
 * Rule-based response simulator used when no OpenAI key is configured.
 * Handles three scenarios: late start (delay), rain, and cancellation.
 */
export function simulateLLMResponse(userMessage, plan) {
  const msg = userMessage;
  const hourMatch = msg.match(/(\d{1,2})\s*시/);
  const mentionedHour = hourMatch ? parseInt(hourMatch[1], 10) : null;

  const isDelay = /늦잠|늦게|늦어|출발|지각|12시|오후|지연/.test(msg);
  const isRain = /비|우천|날씨|폭우|우산/.test(msg);
  const isCancellation = /취소|못|안|빠질|건너|skip/.test(msg);
  const mentionedSpot = plan.find((item) => msg.includes(item.name));

  if (isDelay && mentionedHour !== null) {
    const cutMins = mentionedHour * 60;
    const remaining = plan.filter((item) => timeToMinutes(item.time) >= cutMins);
    const skipped = plan.filter((item) => timeToMinutes(item.time) < cutMins);
    const skippedNames = skipped.map((i) => i.name).join(", ");
    const modifiedSchedule = remaining.length ? remaining : plan;
    return {
      text: `✅ **상황 분석**: 현재 ${mentionedHour}시 출발로 인해 ${skippedNames ? `**${skippedNames}**` : "일부 오전 일정"}은 시간상 불가능합니다.\n\n📋 **수정 제안**: ${String(mentionedHour).padStart(2, "0")}:00 이후 일정부터 시작합니다. ${remaining.length === 0 ? "남은 일정이 없습니다 — 자유 여행을 즐기세요 😊" : `총 ${remaining.length}개 장소가 유지됩니다.`}`,
      modifiedSchedule,
    };
  }

  if (isRain) {
    const outdoorSpots = plan.filter((item) => !item.indoor);
    const indoorSpots = plan.filter((item) => item.indoor);
    if (outdoorSpots.length === 0) {
      return {
        text: "☔ **날씨 분석**: 현재 일정은 모두 실내 위주입니다. 비가 오더라도 일정 변동 없이 진행 가능합니다!",
        modifiedSchedule: null,
      };
    }
    const outdoorNames = outdoorSpots.map((i) => i.name).join(", ");
    return {
      text: `☔ **날씨 분석**: **${outdoorNames}**는 야외 일정입니다. 비가 올 경우 이동 시 우산 필수이며, 특히 야외 공원·신사는 관람이 불편할 수 있습니다.\n\n💡 **제안**: 실내 일정(${indoorSpots.map((i) => i.name).join(", ")})을 먼저 배치하고, 날씨 호전 시 야외로 이동하는 것을 추천합니다. 일정 순서를 조정할까요?`,
      modifiedSchedule: null,
    };
  }

  if (isCancellation && mentionedSpot) {
    const modified = plan.filter((item) => item.id !== mentionedSpot.id);
    return {
      text: `✅ **${mentionedSpot.name}** 일정을 제거했습니다. 남은 ${modified.length}개 일정으로 여행을 진행합니다. 해당 시간(${mentionedSpot.time})에 주변 장소를 탐방하거나 휴식을 취할 수 있습니다.`,
      modifiedSchedule: modified,
    };
  }

  return {
    text: `🤔 **상황 파악 중**: "${userMessage.slice(0, 40)}..." — 현재 일정(${plan.length}개 장소)을 분석했습니다.\n\n구체적인 상황을 알려주시면 더 정확한 도움을 드릴 수 있습니다.\n\n예: "늦잠 자서 12시에 출발", "비가 와서 야외 일정 변경", "팀랩 예약 취소"`,
    modifiedSchedule: null,
  };
}
