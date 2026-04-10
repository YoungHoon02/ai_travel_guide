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
function buildSelectableRecommendations(plan, primary = []) {
  const seen = new Set();
  const merged = [...primary, ...plan].filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  const picks = merged.slice(0, 7);
  return picks.slice(0, Math.max(3, Math.min(7, picks.length)));
}

function formatRecommendationLines(recommendations) {
  return recommendations
    .map((item, idx) => `${idx + 1}. ${item.name} (${item.time}${item.area ? `, ${item.area}` : ""})`)
    .join("\n");
}

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
    const recommendations = buildSelectableRecommendations(plan, remaining.length ? remaining : plan);
    return {
      text: `✅ **상황 분석**: 현재 ${mentionedHour}시 출발로 인해 ${skippedNames ? `**${skippedNames}**` : "일부 오전 일정"} 조정이 필요합니다.\n\n❓ **역질문**: 오늘은 어떤 방향이 가장 중요할까요?\n- 이동 동선을 줄이는 쪽\n- 인기 장소를 우선 유지하는 쪽\n- 식사/휴식 시간을 충분히 확보하는 쪽\n\n🧭 **선택 가능한 추천 컨텐츠 (${recommendations.length}개)**\n${formatRecommendationLines(recommendations)}\n\n원하시는 번호(복수 선택 가능)를 알려주시면 그 기준으로 일정을 다시 맞춰드릴게요.`,
      modifiedSchedule: null,
    };
  }

  if (isRain) {
    const outdoorSpots = plan.filter((item) => !item.indoor);
    const indoorSpots = plan.filter((item) => item.indoor);
    const recommendations = buildSelectableRecommendations(plan, [...indoorSpots, ...outdoorSpots]);
    if (outdoorSpots.length === 0) {
      return {
        text: `☔ **날씨 분석**: 현재 일정은 실내 비중이 높아 큰 변동 없이 진행 가능합니다.\n\n❓ **역질문**: 그래도 비 오는 날 기준으로 조용한 장소 위주가 좋을까요, 체험형 장소 위주가 좋을까요?\n\n🧭 **선택 가능한 추천 컨텐츠 (${recommendations.length}개)**\n${formatRecommendationLines(recommendations)}`,
        modifiedSchedule: null,
      };
    }
    const outdoorNames = outdoorSpots.map((i) => i.name).join(", ");
    return {
      text: `☔ **날씨 분석**: **${outdoorNames}**는 야외 일정이라 우천 시 체감 피로가 커질 수 있습니다.\n\n❓ **역질문**: 오늘은 "이동 최소화", "실내 체험 우선", "야외를 짧게라도 유지" 중 어떤 방향이 좋으세요?\n\n🧭 **선택 가능한 추천 컨텐츠 (${recommendations.length}개)**\n${formatRecommendationLines(recommendations)}\n\n원하는 방향과 번호를 알려주시면 그 기준으로 재구성해드릴게요.`,
      modifiedSchedule: null,
    };
  }

  if (isCancellation && mentionedSpot) {
    const recommendations = buildSelectableRecommendations(plan, plan.filter((item) => item.id !== mentionedSpot.id));
    return {
      text: `✅ **상황 분석**: **${mentionedSpot.name}** 취소 상황을 확인했습니다.\n\n❓ **역질문**: 비는 시간(${mentionedSpot.time})은 어떤 식으로 쓰고 싶으세요?\n- 근처 대체 장소로 채우기\n- 식사/카페로 여유 있게 전환\n- 뒤 일정 당겨서 하루를 압축\n\n🧭 **선택 가능한 추천 컨텐츠 (${recommendations.length}개)**\n${formatRecommendationLines(recommendations)}\n\n선호 방향과 번호를 주시면 그 의도에 맞춰 일정을 수정하겠습니다.`,
      modifiedSchedule: null,
    };
  }

  const recommendations = buildSelectableRecommendations(plan, plan);
  return {
    text: `🤔 **상황 파악 중**: "${userMessage.slice(0, 40)}..." — 현재 일정(${plan.length}개 장소)을 분석했습니다.\n\n❓ **역질문**: 지금 가장 중요한 목표가 무엇인지 알려주세요.\n- 이동 최소화\n- 핵심 명소 유지\n- 식사/휴식 중심\n\n🧭 **선택 가능한 추천 컨텐츠 (${recommendations.length}개)**\n${formatRecommendationLines(recommendations)}\n\n예: "2번, 4번 중심으로 짜줘"처럼 답해주시면 바로 반영해드릴게요.`,
    modifiedSchedule: null,
  };
}
