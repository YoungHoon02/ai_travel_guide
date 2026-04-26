import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchGoogleDirections } from "../api.js";

// Wait this long after the last edit to a day's stop sequence before kicking
// off the leg chain fetch. Drag/toggle bursts collapse into a single fetch.
const ROUTE_FETCH_DEBOUNCE_MS = 500;

// Per-leg travel mode choices shown in the timeline transport block.
// Exported so the timeline UI can render the same option set the hook accepts.
export const LEG_MODE_OPTIONS = [
  { value: "TRANSIT", label: "대중교통", icon: "🚇" },
  { value: "DRIVING", label: "차량", icon: "🚗" },
  { value: "WALKING", label: "도보", icon: "🚶" },
];

export function defaultLegTravelMode(moveId) {
  switch (moveId) {
    case "walking": return "WALKING";
    case "car":
    case "taxi": return "DRIVING";
    case "bicycle": return "BICYCLING";
    case "public": return "TRANSIT";
    default: return "TRANSIT";
  }
}

export function transportLabelForMode(mode) {
  const m = String(mode ?? "").toUpperCase();
  if (m === "WALKING") return { icon: "🚶", label: "도보" };
  if (m === "BICYCLING") return { icon: "🚲", label: "자전거" };
  if (m === "DRIVING") return { icon: "🚗", label: "차량" };
  if (m === "TRANSIT") return { icon: "🚇", label: "대중교통" };
  return { icon: "·", label: m || "이동" };
}

export function calculateStayDurationMinutes(activity) {
  if (!activity) return 30;
  const score = Number(activity.visitScore);
  const base = Number.isFinite(score) ? score * 30 : 90;
  return Math.max(30, Math.round(base));
}

function legColorByMode(mode) {
  const m = String(mode ?? "").toUpperCase();
  if (m === "WALKING") return "#5ecfcf";
  if (m === "BICYCLING") return "#a3e635";
  if (m === "DRIVING") return "#e8a020";
  if (m === "TRANSIT") return "#ffd23f";
  return "#5ecfcf";
}

// Detect whether a Google Directions result actually contains a transit step.
// Transit data coverage outside major metros is sparse — Routes API may return
// a result whose travelModeUsed silently degrades to WALK, which we treat as
// "no transit available" so the caller can fall back.
function hasTransitStep(dir) {
  if (!dir) return false;
  if (String(dir.travelModeUsed ?? "").toUpperCase() === "TRANSIT") return true;
  return (dir.steps ?? []).some((s) => String(s.travelMode ?? "").toUpperCase() === "TRANSIT");
}

// Per-leg fetch with TRANSIT → DRIVING → WALKING cascade.
//
// The Edit View's per-leg fetcher used to hit fetchGoogleDirections once and
// surface "경로를 찾지 못했습니다" whenever Google had no transit data — common
// in regions like Okinawa where Routes API transit coverage is patchy. This
// helper mirrors the cascade already used by fetchScheduleDirections for the
// "public" move profile, but at the per-leg granularity the timeline expects.
//
// Non-TRANSIT modes pass through unchanged so user-selected DRIVING/WALKING
// stays explicit and never gets silently substituted.
async function fetchLegDirectionsWithFallback(fromLatLng, toLatLng, travelMode, opts) {
  if (travelMode !== "TRANSIT") {
    return fetchGoogleDirections(fromLatLng, toLatLng, travelMode, opts);
  }
  const transitDir = await fetchGoogleDirections(fromLatLng, toLatLng, "TRANSIT", opts);
  if (hasTransitStep(transitDir)) return transitDir;

  const drivingDir = await fetchGoogleDirections(fromLatLng, toLatLng, "DRIVING", opts);
  if (drivingDir) {
    return {
      ...drivingDir,
      isApproximate: Boolean(drivingDir.isApproximate),
      fallbackNotice: "대중교통 경로를 찾지 못해 도로 경로로 대체했습니다.",
      routePolicy: { requestedMode: "TRANSIT", resolvedMode: "DRIVING", fallback: true },
    };
  }
  const walkingDir = await fetchGoogleDirections(fromLatLng, toLatLng, "WALKING", opts);
  if (walkingDir) {
    return {
      ...walkingDir,
      isApproximate: Boolean(walkingDir.isApproximate),
      fallbackNotice: "대중교통 경로를 찾지 못해 도보 경로로 대체했습니다.",
      routePolicy: { requestedMode: "TRANSIT", resolvedMode: "WALKING", fallback: true },
    };
  }
  return transitDir ?? null;
}

// Sum of leg durations + intermediate stays for legs[0..targetIndex-1].
// Returns the absolute departure time (ms epoch) for legs[targetIndex].
function computeLegDepartureMs(legs, targetIndex, tripBaseMs, activeDay) {
  const dayOffsetMs = (Math.max(1, activeDay) - 1) * 24 * 60 * 60 * 1000;
  let cursorMs = (tripBaseMs ?? Date.now()) + dayOffsetMs;
  for (let i = 0; i < targetIndex; i++) {
    const leg = legs[i];
    const durSecs = leg?.routeData?.durationSecs;
    if (Number.isFinite(durSecs)) cursorMs += durSecs * 1000;
    const stayMin = leg?.stayDurationMin ?? 0;
    if (Number.isFinite(stayMin)) cursorMs += stayMin * 60 * 1000;
  }
  return cursorMs;
}

function asValidLatLng(latlng) {
  if (!Array.isArray(latlng) || latlng.length !== 2) return null;
  const lat = Number(latlng[0]);
  const lng = Number(latlng[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

/**
 * Edit View per-day routing state machine.
 *
 * Owns: leg skeleton derivation from editDayStops, debounced chain fetch,
 * per-leg travel-mode handling, polyline derivation for the map, and the
 * chain-id guard that drops stale responses.
 *
 * Returned `resetEditDayLegs()` is intended to be called from any caller-side
 * "throw away this trip" reset (e.g. when generating a new plan).
 */
export function useEditDayRouting({
  step,
  gmapsReady,
  editDayStops,
  editDayStopsKey,
  move,
  selectedLodgingLatLng,
  tripStartDate,
  activeDay,
}) {
  // Shape: [{ legIndex, fromId, toId, fromName, toName, fromLatLng, toLatLng,
  //           stayDurationMin, travelMode, routeData, isLoading, error, real }]
  const [editDayLegs, setEditDayLegs] = useState([]);
  const editDayLegsRef = useRef([]);
  useEffect(() => { editDayLegsRef.current = editDayLegs; }, [editDayLegs]);

  // Bumped whenever a new fetch supersedes a previous one so stale responses
  // are dropped without aborting the underlying network request.
  const chainIdRef = useRef(0);
  const fetchDebounceTimerRef = useRef(null);
  const lastMoveRef = useRef(null);

  // Anchor for departure-time chain calculation. Uses the parsed start date
  // at 09:00 local when available, otherwise today at 09:00. activeDay is
  // applied as a 24h offset inside computeLegDepartureMs.
  const tripBaseDateMs = useMemo(() => {
    if (tripStartDate) {
      const parsed = Date.parse(`${tripStartDate}T09:00:00`);
      if (!Number.isNaN(parsed)) return parsed;
    }
    const base = new Date();
    base.setHours(9, 0, 0, 0);
    return base.getTime();
  }, [tripStartDate]);

  // Fetch the chain of legs starting at startLegIndex through to the end of
  // the day. Each leg's departure time is computed from the previous leg's
  // duration plus the stop's stay duration. A monotonically-increasing chain
  // id guards against late responses overwriting newer state — if a newer
  // chain was started during the await, we abandon updates without touching
  // the in-flight network request (caching in api.js makes that mostly free).
  const fetchLegChainFrom = useCallback(async (startLegIndex, legsOverride) => {
    const myChainId = ++chainIdRef.current;
    const initial = legsOverride ?? editDayLegsRef.current;
    if (!Array.isArray(initial) || startLegIndex >= initial.length) return;

    let working = initial.map((leg, i) =>
      i >= startLegIndex
        ? { ...leg, isLoading: true, error: null, routeData: leg.routeData ?? null }
        : { ...leg }
    );
    setEditDayLegs(working);

    for (let i = startLegIndex; i < working.length; i++) {
      if (myChainId !== chainIdRef.current) return;
      const leg = working[i];
      if (!leg.fromLatLng || !leg.toLatLng) {
        working = working.map((l, idx) =>
          idx === i ? { ...l, isLoading: false, error: "좌표 없음", real: false } : l
        );
        if (myChainId === chainIdRef.current) setEditDayLegs(working);
        continue;
      }
      const departureMs = computeLegDepartureMs(working, i, tripBaseDateMs, activeDay);
      const departureTime = Number.isFinite(departureMs)
        ? new Date(departureMs).toISOString()
        : null;
      let routeData = null;
      let error = null;
      try {
        routeData = await fetchLegDirectionsWithFallback(
          leg.fromLatLng,
          leg.toLatLng,
          leg.travelMode,
          departureTime ? { departureTime } : {}
        );
        if (!routeData) error = "경로를 찾지 못했습니다";
      } catch (e) {
        error = e?.message ?? "경로 조회 오류";
      }
      if (myChainId !== chainIdRef.current) return;
      working = working.map((l, idx) =>
        idx === i
          ? { ...l, routeData, isLoading: false, error, real: Boolean(routeData) }
          : l
      );
      setEditDayLegs(working);
    }
  }, [tripBaseDateMs, activeDay]);

  // Debounced trigger for the leg chain fetch. While editDayStops is changing
  // (drag, toggle, day switch) the effect rebuilds the leg skeleton (so the
  // timeline UI tracks the activity sequence immediately), then waits
  // ROUTE_FETCH_DEBOUNCE_MS of quiet before kicking off the chain fetch.
  // Per-leg user mode selections survive across rebuilds when the from→to
  // pair is unchanged AND the overall move style hasn't switched.
  useEffect(() => {
    if (step !== 2 || !gmapsReady) {
      chainIdRef.current += 1;
      if (fetchDebounceTimerRef.current) {
        clearTimeout(fetchDebounceTimerRef.current);
        fetchDebounceTimerRef.current = null;
      }
      setEditDayLegs([]);
      lastMoveRef.current = move;
      return;
    }
    const valid = editDayStops
      .map((s) => {
        const latlng = asValidLatLng(s.latlng) ?? selectedLodgingLatLng;
        return latlng ? { ...s, latlng } : null;
      })
      .filter(Boolean);
    if (valid.length < 2) {
      chainIdRef.current += 1;
      if (fetchDebounceTimerRef.current) {
        clearTimeout(fetchDebounceTimerRef.current);
        fetchDebounceTimerRef.current = null;
      }
      setEditDayLegs([]);
      lastMoveRef.current = move;
      return;
    }

    const moveChanged = lastMoveRef.current !== null && lastMoveRef.current !== move;
    lastMoveRef.current = move;
    const prevLegs = editDayLegsRef.current;

    const skeleton = [];
    for (let i = 0; i < valid.length - 1; i++) {
      const from = valid[i];
      const to = valid[i + 1];
      const stayActivity = to.kind === "activity" ? to.activity : null;
      const stayDurationMin = stayActivity ? calculateStayDurationMinutes(stayActivity) : 0;
      const prev = !moveChanged
        ? prevLegs.find((l) => l.fromId === from.id && l.toId === to.id)
        : null;
      const sameCoords = prev
        && prev.fromLatLng?.[0] === from.latlng[0]
        && prev.fromLatLng?.[1] === from.latlng[1]
        && prev.toLatLng?.[0] === to.latlng[0]
        && prev.toLatLng?.[1] === to.latlng[1];
      skeleton.push({
        legIndex: i,
        fromId: from.id,
        toId: to.id,
        fromName: from.name,
        toName: to.name,
        fromLatLng: from.latlng,
        toLatLng: to.latlng,
        stayDurationMin,
        travelMode: prev?.travelMode ?? defaultLegTravelMode(move),
        routeData: sameCoords ? prev.routeData : null,
        isLoading: false,
        error: null,
        real: sameCoords ? Boolean(prev.real) : false,
      });
    }
    setEditDayLegs(skeleton);

    if (fetchDebounceTimerRef.current) clearTimeout(fetchDebounceTimerRef.current);
    fetchDebounceTimerRef.current = setTimeout(() => {
      fetchDebounceTimerRef.current = null;
      fetchLegChainFrom(0, skeleton);
    }, ROUTE_FETCH_DEBOUNCE_MS);

    return () => {
      if (fetchDebounceTimerRef.current) {
        clearTimeout(fetchDebounceTimerRef.current);
        fetchDebounceTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, editDayStopsKey, move, selectedLodgingLatLng, gmapsReady, fetchLegChainFrom]);

  // User-explicit per-leg mode change: skip debounce, refetch from this leg.
  const handleLegModeChange = useCallback((legIndex, nextMode) => {
    const current = editDayLegsRef.current;
    if (!Array.isArray(current) || legIndex < 0 || legIndex >= current.length) return;
    if (current[legIndex]?.travelMode === nextMode) return;
    const next = current.map((leg, i) =>
      i === legIndex ? { ...leg, travelMode: nextMode, routeData: null, real: false, error: null } : leg
    );
    setEditDayLegs(next);
    fetchLegChainFrom(legIndex, next);
  }, [fetchLegChainFrom]);

  // Manual retry trigger — used by transport block keyboard / click on a
  // failed leg to retry the chain from there without changing mode.
  const retryLegChainFrom = useCallback((legIndex) => {
    const current = editDayLegsRef.current;
    if (!Array.isArray(current) || legIndex < 0 || legIndex >= current.length) return;
    fetchLegChainFrom(legIndex, current);
  }, [fetchLegChainFrom]);

  // External "throw away this trip" reset — bumps chain id, clears timer,
  // empties the leg list. Stable identity so consumers can list it as a dep.
  const resetEditDayLegs = useCallback(() => {
    setEditDayLegs([]);
    chainIdRef.current += 1;
    if (fetchDebounceTimerRef.current) {
      clearTimeout(fetchDebounceTimerRef.current);
      fetchDebounceTimerRef.current = null;
    }
    lastMoveRef.current = null;
  }, []);

  const editDayLegsLoading = useMemo(
    () => editDayLegs.some((l) => l.isLoading),
    [editDayLegs]
  );

  // Per-leg polylines for the Edit View map. Each leg renders as its own
  // segment (mode-colored solid line when real, dashed straight-line fallback
  // otherwise). Legs without route data fall back to the from→to straight
  // line so the map still shows visual continuity during the debounce window
  // and on fetch failures.
  const legPolylines = useMemo(() => {
    const segments = [];
    for (const leg of editDayLegs) {
      const baseColor = legColorByMode(leg.travelMode);
      const route = leg.routeData;
      const path = Array.isArray(route?.polylinePath) ? route.polylinePath : null;
      if (route && path && path.length >= 2 && !route.isApproximate) {
        const traffic = Array.isArray(route.trafficSegments) ? route.trafficSegments : [];
        const usableTraffic = traffic.filter(
          (t) => Array.isArray(t.path) && t.path.length >= 2 && t.color
        );
        if (usableTraffic.length > 0) {
          for (const t of usableTraffic) {
            segments.push({
              positions: t.path,
              color: t.color,
              weight: 6,
              opacity: 0.95,
              dashed: false,
            });
          }
        } else {
          segments.push({
            positions: path,
            color: baseColor,
            weight: 5,
            opacity: 0.9,
            dashed: false,
          });
        }
      } else if (leg.fromLatLng && leg.toLatLng) {
        segments.push({
          positions: [leg.fromLatLng, leg.toLatLng],
          color: baseColor,
          weight: 3,
          opacity: 0.7,
          dashed: true,
        });
      }
    }
    return segments;
  }, [editDayLegs]);

  const legPolylinesHasReal = useMemo(
    () => editDayLegs.some((l) => l.real && l.routeData?.polylinePath),
    [editDayLegs]
  );
  const legPolylinesHasTraffic = useMemo(
    () =>
      editDayLegs.some(
        (l) =>
          Array.isArray(l.routeData?.trafficSegments) &&
          l.routeData.trafficSegments.some((t) => Array.isArray(t.path) && t.path.length >= 2)
      ),
    [editDayLegs]
  );

  return {
    editDayLegs,
    editDayLegsLoading,
    legPolylines,
    legPolylinesHasReal,
    legPolylinesHasTraffic,
    handleLegModeChange,
    retryLegChainFrom,
    resetEditDayLegs,
  };
}
