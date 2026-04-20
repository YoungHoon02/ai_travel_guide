import { escapeHtml, parseBooleanEnv, simulateLLMResponse } from "./utils.js";
import {
  DEST_SYSTEM_PROMPT,
  TRANSPORT_PROMPT,
  LODGING_PROMPT,
  ITINERARY_PROMPT,
  buildRealtimeSystemPrompt,
} from "./prompts/index.js";

// ─── Local JSON DB loader ──────────────────────────────────────────────────────
export async function loadPlansDB() {
  try {
    const r = await fetch("/plans.json");
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── Weather (OpenWeatherMap or simulated) ────────────────────────────────────
export const OWM_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY;
export async function fetchWeather(lat, lng) {
  if (!OWM_KEY) {
    return { description: "맑음 (시뮬)", temp: "21°C", icon: "☀️", humidity: "52%", wind: "3m/s", raw: null };
  }
  const base = import.meta.env.DEV ? "/owm" : "https://api.openweathermap.org";
  try {
    const r = await fetch(
      `${base}/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OWM_KEY}&units=metric&lang=kr`
    );
    if (!r.ok) throw new Error("owm");
    const d = await r.json();
    const iconMap = { "01": "☀️", "02": "⛅", "03": "☁️", "04": "☁️", "09": "🌧️", "10": "🌦️", "11": "⛈️", "13": "❄️", "50": "🌫️" };
    const code = d.weather?.[0]?.icon?.slice(0, 2) ?? "01";
    return {
      description: d.weather?.[0]?.description ?? "",
      temp: `${Math.round(d.main?.temp ?? 0)}°C`,
      icon: iconMap[code] ?? "🌡️",
      humidity: `${d.main?.humidity ?? "--"}%`,
      wind: `${d.wind?.speed ?? "--"}m/s`,
      raw: d,
    };
  } catch {
    return { description: "날씨 조회 실패", temp: "--", icon: "🌡️", humidity: "--", wind: "--", raw: null };
  }
}

// ─── Google Maps nearby places (New API) ─────────────────────────────────────
export async function fetchNearbyPlaces(lat, lng, type = "tourist_attraction", radius = 1500) {
  if (!window.google?.maps?.places?.Place) return [];
  try {
    const { places } = await window.google.maps.places.Place.searchNearby({
      locationRestriction: { center: { lat, lng }, radius },
      includedPrimaryTypes: [type],
      fields: ["displayName", "formattedAddress", "rating", "currentOpeningHours", "id"],
      maxResultCount: 6,
    });
    return (places ?? []).map((p) => ({
      name: p.displayName, vicinity: p.formattedAddress, rating: p.rating,
      openNow: p.currentOpeningHours?.isOpen?.() ?? null, id: p.id,
    }));
  } catch { return []; }
}

// ─── Google Maps Directions → Routes API ─────────────────────────────────────
export const GMAPS_TRAVEL_MODE_MAP = {
  public: "TRANSIT", taxi: "DRIVING", car: "DRIVING", walking: "WALKING", bicycle: "BICYCLING",
};

const ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ROUTES_TRAVEL_MODE_MAP = {
  DRIVING: "DRIVE", WALKING: "WALK", BICYCLING: "BICYCLE", TRANSIT: "TRANSIT",
};
const PREFER_ROUTES_API = parseBooleanEnv(import.meta.env.VITE_PREFER_ROUTES_API, false);
const ENHANCED_TRANSIT = parseBooleanEnv(import.meta.env.VITE_ENHANCED_TRANSIT, true);
const ENHANCED_TRAFFIC = parseBooleanEnv(import.meta.env.VITE_ROUTE_TRAFFIC_COLORS, true);
const ALLOW_LEGACY_DIRECTIONS_FALLBACK = parseBooleanEnv(import.meta.env.VITE_ALLOW_LEGACY_DIRECTIONS_FALLBACK, false);
const ROUTES_BASE_FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.staticDuration",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.polyline",
];
const ROUTES_TRANSIT_FIELD_MASK = [
  "routes.legs.steps.transitDetails.transitLine.name",
  "routes.legs.steps.transitDetails.transitLine.nameShort",
  "routes.legs.steps.transitDetails.transitLine.vehicle.type",
  "routes.legs.steps.transitDetails.transitLine.vehicle.name",
  "routes.legs.steps.transitDetails.headsign",
  "routes.legs.steps.transitDetails.stopDetails.departureStop.name",
  "routes.legs.steps.transitDetails.stopDetails.arrivalStop.name",
  "routes.legs.steps.transitDetails.stopCount",
];
const ROUTES_TRAFFIC_FIELD_MASK = [
  "routes.travelAdvisory",
  "routes.legs.travelAdvisory",
];
const ROUTES_SOFT_DISABLE_WINDOW_MS = 5 * 60 * 1000;
const DIRECTIONS_CACHE_TTL_MS = 2 * 60 * 1000;
const DIRECTIONS_FAILURE_CACHE_TTL_MS = 20 * 1000;
let routesApiDisabledUntil = 0;
let lastRoutesApiErrorSig = "";
let legacyDirectionsDisabledUntil = 0;
let routesTrafficSupportState = "unknown"; // unknown | probing | supported | unsupported
let routesTrafficUnsupportedUntil = 0;
let routesTransitDetailsSupportState = "unknown"; // unknown | probing | supported | unsupported
let routesTransitDetailsUnsupportedUntil = 0;
const directionsCache = new Map();
const directionsInFlight = new Map();

function isValidLatLng(latlng) {
  if (!Array.isArray(latlng) || latlng.length !== 2) return false;
  const lat = Number(latlng[0]);
  const lng = Number(latlng[1]);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function parseDurationSeconds(durationText) {
  if (!durationText) return null;
  const m = String(durationText).match(/^([\d.]+)s$/i);
  if (!m) return null;
  const v = Math.round(Number.parseFloat(m[1]));
  return Number.isFinite(v) ? v : null;
}

function normalizeTransitStep(transitDetails) {
  if (!transitDetails) return null;
  const line = transitDetails.transitLine ?? {};
  const vehicle = line.vehicle ?? {};
  const stopDetails = transitDetails.stopDetails ?? transitDetails;
  return {
    lineName: line.name ?? "",
    lineShort: line.nameShort ?? "",
    vehicleType: vehicle.type ?? "",
    vehicleName: vehicle.name ?? "",
    headsign: transitDetails.headsign ?? "",
    departureStop: stopDetails.departureStop?.name ?? "",
    arrivalStop: stopDetails.arrivalStop?.name ?? "",
    stopCount: Number.isFinite(Number(transitDetails.stopCount)) ? Number(transitDetails.stopCount) : null,
  };
}

function normalizeTrafficSpeed(speed) {
  const normalized = String(speed ?? "").toUpperCase();
  if (normalized === "NORMAL") return "NORMAL";
  if (normalized === "SLOW") return "SLOW";
  if (normalized === "TRAFFIC_JAM") return "TRAFFIC_JAM";
  return "SPEED_UNSPECIFIED";
}

function trafficSpeedColor(speed) {
  const normalized = normalizeTrafficSpeed(speed);
  if (normalized === "NORMAL") return "#22c55e";
  if (normalized === "SLOW") return "#f59e0b";
  if (normalized === "TRAFFIC_JAM") return "#ef4444";
  return "#64748b";
}

function extractTrafficIntervals(route) {
  const routeIntervals = route?.travelAdvisory?.speedReadingIntervals;
  if (Array.isArray(routeIntervals) && routeIntervals.length > 0) return routeIntervals;
  const legIntervals = (route?.legs ?? []).flatMap((leg) => leg?.travelAdvisory?.speedReadingIntervals ?? []);
  return legIntervals;
}

function clampTrafficIndex(value, fallback, maxIndex) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(maxIndex, Math.round(n)));
}

function buildTrafficSegments(polylinePath, intervals) {
  if (!Array.isArray(polylinePath) || polylinePath.length < 2 || !Array.isArray(intervals) || intervals.length === 0) {
    return [];
  }
  const maxIndex = polylinePath.length - 1;
  const out = [];
  for (const interval of intervals) {
    const start = clampTrafficIndex(interval?.startPolylinePointIndex, 0, maxIndex);
    const end = clampTrafficIndex(interval?.endPolylinePointIndex, maxIndex, maxIndex);
    if (end <= start) continue;
    const path = polylinePath.slice(start, end + 1);
    if (path.length < 2) continue;
    const speed = normalizeTrafficSpeed(interval?.speed);
    out.push({
      speed,
      color: trafficSpeedColor(speed),
      path,
    });
  }
  return out;
}

function normalizeLegacyTransitStep(transit) {
  if (!transit) return null;
  const line = transit.line ?? {};
  const vehicle = line.vehicle ?? {};
  return {
    lineName: line.name ?? "",
    lineShort: line.short_name ?? "",
    vehicleType: vehicle.type ?? "",
    vehicleName: vehicle.name ?? "",
    headsign: transit.headsign ?? "",
    departureStop: transit.departure_stop?.name ?? "",
    arrivalStop: transit.arrival_stop?.name ?? "",
    stopCount: Number.isFinite(Number(transit.num_stops)) ? Number(transit.num_stops) : null,
  };
}

function stripHtmlTags(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRouteDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m || 1}분`;
}

function formatRouteDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${meters} m`;
}

function buildDirectionCacheKey(originLatLng, destLatLng, travelMode) {
  const oLat = Number(originLatLng[0]).toFixed(6);
  const oLng = Number(originLatLng[1]).toFixed(6);
  const dLat = Number(destLatLng[0]).toFixed(6);
  const dLng = Number(destLatLng[1]).toFixed(6);
  return `${travelMode}|${oLat},${oLng}|${dLat},${dLng}`;
}

function isSameLatLng(a, b) {
  if (!isValidLatLng(a) || !isValidLatLng(b)) return false;
  return Math.abs(Number(a[0]) - Number(b[0])) < 1e-6 && Math.abs(Number(a[1]) - Number(b[1])) < 1e-6;
}

function buildZeroDistanceDirection(latlng, travelMode) {
  return {
    duration: "0분",
    durationSecs: 0,
    distance: "0 m",
    steps: [],
    polylinePath: [latlng, latlng],
    travelModeUsed: String(travelMode ?? "DRIVING").toUpperCase(),
    transitSummary: null,
    trafficSegments: [],
  };
}

function fetchLegacyGoogleDirections(originLatLng, destLatLng, travelMode = "DRIVING") {
  return new Promise((resolve) => {
    if (Date.now() < legacyDirectionsDisabledUntil) {
      resolve(null);
      return;
    }
    if (!window.google?.maps?.DirectionsService || !window.google?.maps?.TravelMode) {
      resolve(null);
      return;
    }
    const modeMap = {
      DRIVING: window.google.maps.TravelMode.DRIVING,
      WALKING: window.google.maps.TravelMode.WALKING,
      BICYCLING: window.google.maps.TravelMode.BICYCLING,
      TRANSIT: window.google.maps.TravelMode.TRANSIT,
    };
    const req = {
      origin: { lat: originLatLng[0], lng: originLatLng[1] },
      destination: { lat: destLatLng[0], lng: destLatLng[1] },
      travelMode: modeMap[travelMode] ?? window.google.maps.TravelMode.DRIVING,
      provideRouteAlternatives: false,
      region: "kr",
    };
    if (travelMode === "TRANSIT") {
      req.transitOptions = { departureTime: new Date() };
    }
    if (travelMode === "DRIVING" && window.google?.maps?.TrafficModel) {
      req.drivingOptions = {
        departureTime: new Date(),
        trafficModel: window.google.maps.TrafficModel.BEST_GUESS,
      };
    }

    new window.google.maps.DirectionsService().route(req, (result, status) => {
      if (status !== "OK" || !result?.routes?.[0]) {
        if (String(status).toUpperCase() === "REQUEST_DENIED") {
          // Legacy Directions API가 비활성화된 프로젝트에서는 반복 호출을 즉시 차단한다.
          legacyDirectionsDisabledUntil = Date.now() + ROUTES_SOFT_DISABLE_WINDOW_MS;
        }
        resolve(null);
        return;
      }
      const route = result.routes[0];
      const leg = route.legs?.[0];
      const durationSecs = leg?.duration_in_traffic?.value ?? leg?.duration?.value ?? null;
      const steps = (leg?.steps ?? []).map((s) => ({
        instruction: escapeHtml(stripHtmlTags(s.instructions).slice(0, 200)),
        duration: s.duration?.text ?? (Number.isFinite(Number(s.duration?.value)) ? formatRouteDuration(Number(s.duration.value)) : ""),
        distance: s.distance?.text ?? (Number.isFinite(Number(s.distance?.value)) ? formatRouteDistance(Number(s.distance.value)) : ""),
        travelMode: String(s.travel_mode ?? travelMode).toUpperCase(),
        transit: normalizeLegacyTransitStep(s.transit),
      }));
      const transitLineLabels = Array.from(
        new Set(
          steps
            .filter((s) => s.travelMode === "TRANSIT" && s.transit)
            .map((s) => s.transit.lineShort || s.transit.lineName || s.transit.vehicleName)
            .filter(Boolean)
        )
      );
      const inferredMode =
        steps.find((s) => s.travelMode === "TRANSIT")?.travelMode ||
        steps.find((s) => s.travelMode)?.travelMode ||
        String(travelMode).toUpperCase();

      resolve({
        duration: leg?.duration_in_traffic?.text ?? leg?.duration?.text ?? (durationSecs ? formatRouteDuration(durationSecs) : null),
        durationSecs,
        distance: leg?.distance?.text ?? (Number.isFinite(Number(leg?.distance?.value)) ? formatRouteDistance(Number(leg.distance.value)) : null),
        steps,
        polylinePath: (route.overview_path ?? []).map((p) => [p.lat(), p.lng()]),
        travelModeUsed: inferredMode,
        transitSummary: transitLineLabels.length > 0 ? transitLineLabels.join(" · ") : null,
      });
    });
  });
}

/**
 * @param {[number,number]} originLatLng
 * @param {[number,number]} destLatLng
 * @param {string} travelMode
 * @param {string} apiKey
 * @param {{ departureTime?: string }} [opts={}]
 *   departureTime — ISO 8601 UTC override. Only applied for TRANSIT/DRIVING.
 *   Defaults to the current moment when not provided (existing behaviour).
 */
async function fetchRoutesApiDirections(originLatLng, destLatLng, travelMode, apiKey, opts = {}) {
  const isTransit = travelMode === "TRANSIT";
  const isDriving = travelMode === "DRIVING";

  if (Date.now() >= routesTrafficUnsupportedUntil && routesTrafficSupportState === "unsupported") {
    routesTrafficSupportState = "unknown";
  }
  if (Date.now() >= routesTransitDetailsUnsupportedUntil && routesTransitDetailsSupportState === "unsupported") {
    routesTransitDetailsSupportState = "unknown";
  }

  const canTryTrafficDetails =
    isDriving &&
    ENHANCED_TRAFFIC &&
    Date.now() >= routesTrafficUnsupportedUntil &&
    routesTrafficSupportState !== "unsupported" &&
    routesTrafficSupportState !== "probing";

  const canTryTransitDetails =
    isTransit &&
    ENHANCED_TRANSIT &&
    Date.now() >= routesTransitDetailsUnsupportedUntil &&
    routesTransitDetailsSupportState !== "unsupported" &&
    routesTransitDetailsSupportState !== "probing";

  const baseBody = {
    origin: { location: { latLng: { latitude: originLatLng[0], longitude: originLatLng[1] } } },
    destination: { location: { latLng: { latitude: destLatLng[0], longitude: destLatLng[1] } } },
    travelMode: ROUTES_TRAVEL_MODE_MAP[travelMode] ?? "DRIVE",
    languageCode: "ko",
  };

  if (isTransit) baseBody.departureTime = opts.departureTime ?? new Date().toISOString();
  if (travelMode === "DRIVING") {
    baseBody.routingPreference = "TRAFFIC_AWARE";
    baseBody.departureTime = opts.departureTime ?? new Date().toISOString();
  }

  const requestVariants = [];

  if (travelMode === "DRIVING") {
    if (canTryTrafficDetails) {
      routesTrafficSupportState = "probing";
      requestVariants.push({
        tag: "driving-traffic",
        body: { ...baseBody, extraComputations: ["TRAFFIC_ON_POLYLINE"] },
        fieldMask: Array.from(new Set([...ROUTES_BASE_FIELD_MASK, ...ROUTES_TRAFFIC_FIELD_MASK])).join(","),
      });
    }

    const noTrafficBody = { ...baseBody };
    requestVariants.push({
      tag: "driving-base",
      body: noTrafficBody,
      fieldMask: ROUTES_BASE_FIELD_MASK.join(","),
    });

    const relaxedBody = { ...noTrafficBody };
    delete relaxedBody.routingPreference;
    delete relaxedBody.departureTime;
    requestVariants.push({
      tag: "driving-relaxed",
      body: relaxedBody,
      fieldMask: ROUTES_BASE_FIELD_MASK.join(","),
    });
  } else if (isTransit) {
    if (canTryTransitDetails) {
      routesTransitDetailsSupportState = "probing";
      requestVariants.push({
        tag: "transit-detailed",
        body: { ...baseBody },
        fieldMask: Array.from(new Set([...ROUTES_BASE_FIELD_MASK, ...ROUTES_TRANSIT_FIELD_MASK])).join(","),
      });
    }

    requestVariants.push({
      tag: "transit-base",
      body: { ...baseBody },
      fieldMask: ROUTES_BASE_FIELD_MASK.join(","),
    });

    const relaxedTransitBody = { ...baseBody };
    delete relaxedTransitBody.languageCode;
    requestVariants.push({
      tag: "transit-relaxed",
      body: relaxedTransitBody,
      fieldMask: ROUTES_BASE_FIELD_MASK.join(","),
    });
  } else {
    requestVariants.push({
      tag: "base",
      body: { ...baseBody },
      fieldMask: ROUTES_BASE_FIELD_MASK.join(","),
    });
  }

  let route = null;
  let lastError = "";
  let hadBadRequest = false;
  const finalizeVariantSupport = (variantTag, ok, statusCode) => {
    if (variantTag === "driving-traffic") {
      if (ok) {
        routesTrafficSupportState = "supported";
      } else if (statusCode === 400) {
        routesTrafficSupportState = "unsupported";
        routesTrafficUnsupportedUntil = Date.now() + ROUTES_SOFT_DISABLE_WINDOW_MS;
      } else if (routesTrafficSupportState === "probing") {
        routesTrafficSupportState = "unknown";
      }
    }
    if (variantTag === "transit-detailed") {
      if (ok) {
        routesTransitDetailsSupportState = "supported";
      } else if (statusCode === 400) {
        routesTransitDetailsSupportState = "unsupported";
        routesTransitDetailsUnsupportedUntil = Date.now() + ROUTES_SOFT_DISABLE_WINDOW_MS;
      } else if (routesTransitDetailsSupportState === "probing") {
        routesTransitDetailsSupportState = "unknown";
      }
    }
  };

  for (const variant of requestVariants) {
    const res = await fetch(ROUTES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": variant.fieldMask,
      },
      body: JSON.stringify(variant.body),
    });
    if (!res.ok) {
      finalizeVariantSupport(variant.tag, false, res.status);
      lastError = await res.text().catch(() => "");
      if (res.status === 400) hadBadRequest = true;
      continue;
    }
    finalizeVariantSupport(variant.tag, true, res.status);
    const data = await res.json();
    route = data?.routes?.[0] ?? null;
    if (route) break;
  }

  if (!route) {
    if (hadBadRequest) routesApiDisabledUntil = Date.now() + ROUTES_SOFT_DISABLE_WINDOW_MS;
    if (lastError) {
      const signature = `${travelMode}:${lastError.slice(0, 180)}`;
      if (signature !== lastRoutesApiErrorSig) {
        lastRoutesApiErrorSig = signature;
        console.warn("[Routes API] computeRoutes failed:", lastError.slice(0, 500));
      }
    }
    return null;
  }

  const durationSecs = parseDurationSeconds(route.duration);
  const distanceMeters = route.distanceMeters ?? null;

  const polylinePath =
    route.polyline?.encodedPolyline && window.google?.maps?.geometry
      ? window.google.maps.geometry.encoding
          .decodePath(route.polyline.encodedPolyline)
          .map((p) => [p.lat(), p.lng()])
      : null;
  const trafficSegments =
    isDriving && polylinePath
      ? buildTrafficSegments(polylinePath, extractTrafficIntervals(route))
      : [];

  const steps = (route.legs?.[0]?.steps ?? []).map((s) => {
    const sec = parseDurationSeconds(s.staticDuration);
    const travelModeUsed = String(s.travelMode ?? travelMode).toUpperCase();
    return {
      instruction: escapeHtml((s.navigationInstruction?.instructions ?? "").slice(0, 200)),
      duration: sec != null ? formatRouteDuration(sec) : "",
      distance: s.distanceMeters ? formatRouteDistance(s.distanceMeters) : "",
      travelMode: travelModeUsed,
      transit: normalizeTransitStep(s.transitDetails),
    };
  });
  const transitLineLabels = Array.from(
    new Set(
      steps
        .filter((s) => s.travelMode === "TRANSIT" && s.transit)
        .map((s) => s.transit.lineShort || s.transit.lineName || s.transit.vehicleName)
        .filter(Boolean)
    )
  );
  const inferredMode =
    steps.find((s) => s.travelMode === "TRANSIT")?.travelMode ||
    steps.find((s) => s.travelMode)?.travelMode ||
    String(travelMode).toUpperCase();

  return {
    duration: durationSecs ? formatRouteDuration(durationSecs) : null,
    durationSecs,
    distance: distanceMeters ? formatRouteDistance(distanceMeters) : null,
    steps,
    polylinePath,
    travelModeUsed: inferredMode,
    transitSummary: transitLineLabels.length > 0 ? transitLineLabels.join(" · ") : null,
    trafficSegments,
  };
}

/**
 * Fetch a single point-to-point route via the configured routing backend.
 *
 * @param {[number,number]} originLatLng
 * @param {[number,number]} destLatLng
 * @param {string} [travelMode="DRIVING"]
 * @param {{ departureTime?: string }} [options={}]
 *   departureTime — ISO 8601 UTC (e.g. "2024-03-15T09:00:00Z").
 *   When provided, bypasses the direction cache so the time-sensitive
 *   sequential transit chain always gets a fresh result.
 */
export async function fetchGoogleDirections(originLatLng, destLatLng, travelMode = "DRIVING", options = {}) {
  if (!isValidLatLng(originLatLng) || !isValidLatLng(destLatLng)) return null;
  if (isSameLatLng(originLatLng, destLatLng)) {
    return buildZeroDistanceDirection(originLatLng, travelMode);
  }
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const { departureTime = null } = options;
  // Time-stamped transit requests must not use the cache (different times → different routes).
  const cacheKey = buildDirectionCacheKey(originLatLng, destLatLng, travelMode);
  if (!departureTime) {
    const now = Date.now();
    const cached = directionsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    if (directionsInFlight.has(cacheKey)) return directionsInFlight.get(cacheKey);
  }

  const routeOpts = departureTime ? { departureTime } : {};
  const requestPromise = (async () => {
    const shouldTryRoutesApi = PREFER_ROUTES_API && Boolean(apiKey) && Date.now() >= routesApiDisabledUntil;
    if (shouldTryRoutesApi) {
      const routesResult = await fetchRoutesApiDirections(originLatLng, destLatLng, travelMode, apiKey, routeOpts);
      if (routesResult) return routesResult;
      // Routes 우선 모드에서는 레거시 DirectionsService를 기본적으로 호출하지 않는다.
      if (!ALLOW_LEGACY_DIRECTIONS_FALLBACK) return null;
    }
    if (!ALLOW_LEGACY_DIRECTIONS_FALLBACK && PREFER_ROUTES_API) return null;
    return await fetchLegacyGoogleDirections(originLatLng, destLatLng, travelMode);
  })();

  if (departureTime) {
    // Don't cache time-stamped results — let them complete and return directly.
    return requestPromise;
  }

  directionsInFlight.set(cacheKey, requestPromise);
  try {
    const result = await requestPromise;
    directionsCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + (result ? DIRECTIONS_CACHE_TTL_MS : DIRECTIONS_FAILURE_CACHE_TTL_MS),
    });
    return result;
  } finally {
    directionsInFlight.delete(cacheKey);
  }
}

/**
 * Sequential leg-by-leg transit routing for Google Routes API v2.
 *
 * The Routes API v2 does not allow multiple intermediate waypoints for
 * TRANSIT mode. This function resolves that constraint by calling the API
 * once per consecutive stop pair and chaining the times:
 *
 *   departureTime(B→C) = arrivalTime(A→B) + stayDuration(at B)
 *
 * All times are handled in ISO 8601 UTC so cross-timezone itineraries
 * (e.g. Incheon → New York) work correctly.
 *
 * On a segment error the result records `error` but processing continues —
 * the caller receives a full array with per-leg success/failure status.
 *
 * @param {Array<{latlng: [number,number], name?: string, stayDuration?: number}>} places
 *   Ordered stop list. `stayDuration` is in **minutes** (default 0).
 * @param {string} initialDepartureTime
 *   ISO 8601 UTC timestamp for the first leg departure.
 * @returns {Promise<Array<{
 *   legIndex: number,
 *   fromIndex: number,
 *   toIndex: number,
 *   fromName: string,
 *   toName: string,
 *   departureTime: string,
 *   arrivalTime: string|null,
 *   duration: string|null,
 *   durationSecs: number|null,
 *   distance: string|null,
 *   transitSummary: string|null,
 *   polylinePath: Array|null,
 *   trafficSegments: Array,
 *   error: string|null
 * }>>}
 */
/**
 * Parse an ISO 8601 UTC string and return its millisecond timestamp.
 * Returns `null` when the input is missing or results in an invalid date,
 * so callers can fall back gracefully instead of letting `toISOString()`
 * throw a `RangeError: Invalid time value`.
 */
function parseDateMs(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function fetchTransitSequential(places, initialDepartureTime) {
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey || places.length < 2) return [];

  // Validate the initial departure anchor — if unparseable, fall back to now.
  const anchorMs = parseDateMs(initialDepartureTime) ?? Date.now();
  let currentDepartureTimeMs = anchorMs;

  const results = [];

  for (let i = 0; i < places.length - 1; i++) {
    const from = places[i];
    const to = places[i + 1];
    const fromName = from.name ?? `지점 ${i + 1}`;
    const toName = to.name ?? `지점 ${i + 2}`;
    const currentDepartureTime = new Date(currentDepartureTimeMs).toISOString();

    // Call fetchRoutesApiDirections directly so the departureTime is always
    // honoured regardless of the PREFER_ROUTES_API env setting. Sequential
    // transit routing explicitly requires the Routes API v2.
    let dir = null;
    let segmentError = null;

    try {
      dir = await fetchRoutesApiDirections(from.latlng, to.latlng, "TRANSIT", apiKey, {
        departureTime: currentDepartureTime,
      });
      if (!dir) segmentError = "대중교통 경로를 찾을 수 없습니다";
    } catch (e) {
      segmentError = e?.message ?? "알 수 없는 오류";
    }

    results.push({
      legIndex: i,
      fromIndex: i,
      toIndex: i + 1,
      fromName,
      toName,
      departureTime: currentDepartureTime,
      duration: dir?.duration ?? null,
      durationSecs: dir?.durationSecs ?? null,
      distance: dir?.distance ?? null,
      transitSummary: dir?.transitSummary ?? null,
      polylinePath: dir?.polylinePath ?? null,
      trafficSegments: dir?.trafficSegments ?? [],
      error: segmentError,
    });

    // Propagate next departure: compute from departureTime + durationSecs + stayDuration.
    // Guard: coerce stayDuration to a finite number of minutes (default 0) so that
    // NaN or undefined values don't corrupt the time chain.
    const rawStay = Number(to.stayDuration ?? 0);
    const stayMs = Number.isFinite(rawStay) ? rawStay * 60 * 1000 : 0;
    const durationMs = Number.isFinite(dir?.durationSecs) ? dir.durationSecs * 1000 : 0;
    currentDepartureTimeMs = currentDepartureTimeMs + durationMs + stayMs;
  }

  return results;
}

/**
 * Fetch directions for every consecutive stop pair in a schedule.
 *
 * For TRANSIT / "public" mode the Routes API v2 does not support
 * multi-waypoint requests, so this dispatches to `fetchTransitSequential`
 * (sequential leg-by-leg calls with departure-time chaining) when
 * `options.initialDepartureTime` is provided. Without that option the
 * existing parallel-call logic with DRIVING/WALKING fallbacks is used.
 *
 * All other travel modes always use parallel calls (unchanged).
 *
 * @param {Array<{id:string, latlng:[number,number], name:string, stayDuration?:number}>} schedule
 * @param {string} moveId  — key in GMAPS_TRAVEL_MODE_MAP
 * @param {{ initialDepartureTime?: string }} [options={}]
 *   initialDepartureTime — ISO 8601 UTC for the first TRANSIT leg.
 *   When provided, enables time-chained sequential routing for "public" mode.
 */
export async function fetchScheduleDirections(schedule, moveId, options = {}) {
  const travelMode = GMAPS_TRAVEL_MODE_MAP[moveId] ?? "DRIVING";
  if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY || schedule.length < 2) return [];

  // ── TRANSIT sequential mode (when caller provides a departure anchor) ──────
  if (moveId === "public" && options.initialDepartureTime) {
    const places = schedule.map((s) => ({
      latlng: s.latlng,
      name: s.name,
      stayDuration: s.stayDuration ?? 0,
    }));
    const legs = await fetchTransitSequential(places, options.initialDepartureTime);
    return legs.map((leg) => ({
      fromId: schedule[leg.fromIndex]?.id ?? null,
      toId: schedule[leg.toIndex]?.id ?? null,
      fromName: leg.fromName,
      toName: leg.toName,
      travelModeRequested: "TRANSIT",
      duration: leg.duration,
      durationSecs: leg.durationSecs,
      distance: leg.distance,
      transitSummary: leg.transitSummary,
      polylinePath: leg.polylinePath,
      trafficSegments: leg.trafficSegments,
      // Expose both `departureTime` (TRANSIT-sequential field name) and
      // `departureTimeISO` (the alias used by the non-TRANSIT parallel path)
      // so consumers can use a single field name regardless of routing mode.
      departureTime: leg.departureTime,
      departureTimeISO: leg.departureTime,
      error: leg.error,
    }));
  }

  const hasTransitStep = (dir) =>
    dir?.travelModeUsed === "TRANSIT" || (dir?.steps ?? []).some((s) => s.travelMode === "TRANSIT");

  const withPolicy = (dir, policy) => {
    if (!dir) return null;
    return {
      ...dir,
      isApproximate: Boolean(policy?.approximate) || Boolean(dir.isApproximate),
      fallbackNotice: policy?.notice ?? dir.fallbackNotice ?? null,
      routePolicy: {
        requestedMode: policy?.requestedMode ?? String(travelMode).toUpperCase(),
        resolvedMode: policy?.resolvedMode ?? String(dir.travelModeUsed ?? travelMode).toUpperCase(),
        retried: Boolean(policy?.retried),
        fallback: Boolean(policy?.fallback),
        approximate: Boolean(policy?.approximate),
      },
    };
  };

  const results = await Promise.all(
    schedule.slice(0, -1).map(async (from, idx) => {
      const to = schedule[idx + 1];
      if (!isValidLatLng(from.latlng) || !isValidLatLng(to.latlng)) return null;

      let dir = null;
      if (moveId === "mixed") {
        const transitDir = await fetchGoogleDirections(from.latlng, to.latlng, "TRANSIT");
        const transitAvailable = hasTransitStep(transitDir);
        dir = transitAvailable ? transitDir : await fetchGoogleDirections(from.latlng, to.latlng, "DRIVING");
        if (!dir) dir = transitDir;
        dir = withPolicy(dir, {
          requestedMode: "TRANSIT",
          resolvedMode: String(dir?.travelModeUsed ?? "DRIVING").toUpperCase(),
          retried: !transitAvailable,
          fallback: !transitAvailable,
          notice: !transitAvailable && dir ? "대중교통 구간을 찾지 못해 도로 경로로 대체했습니다." : null,
        });
      } else if (moveId === "public") {
        const transitDir = await fetchGoogleDirections(from.latlng, to.latlng, "TRANSIT");
        if (hasTransitStep(transitDir)) {
          dir = withPolicy(transitDir, {
            requestedMode: "TRANSIT",
            resolvedMode: "TRANSIT",
            retried: false,
            fallback: false,
          });
        } else {
          const drivingDir = await fetchGoogleDirections(from.latlng, to.latlng, "DRIVING");
          if (drivingDir) {
            dir = withPolicy(drivingDir, {
              requestedMode: "TRANSIT",
              resolvedMode: String(drivingDir.travelModeUsed ?? "DRIVING").toUpperCase(),
              retried: true,
              fallback: true,
              notice: "대중교통 경로를 찾지 못해 도로 경로로 대체했습니다.",
            });
          } else {
            const walkingDir = await fetchGoogleDirections(from.latlng, to.latlng, "WALKING");
            if (walkingDir) {
              dir = withPolicy(walkingDir, {
                requestedMode: "TRANSIT",
                resolvedMode: "WALKING",
                retried: true,
                fallback: true,
                notice: "대중교통 경로를 찾지 못해 도보 경로로 대체했습니다.",
              });
            } else if (transitDir) {
              dir = withPolicy(transitDir, {
                requestedMode: "TRANSIT",
                resolvedMode: String(transitDir.travelModeUsed ?? "TRANSIT").toUpperCase(),
                retried: true,
                fallback: true,
                notice: "대중교통 상세 구간을 확인하지 못해 대체 경로를 표시합니다.",
              });
            } else {
              dir = withPolicy(
                {
                  duration: null,
                  durationSecs: null,
                  distance: null,
                  steps: [],
                  polylinePath: [from.latlng, to.latlng],
                  travelModeUsed: "ESTIMATE",
                  transitSummary: null,
                  trafficSegments: [],
                  isApproximate: true,
                },
                {
                  requestedMode: "TRANSIT",
                  resolvedMode: "ESTIMATE",
                  retried: true,
                  fallback: true,
                  approximate: true,
                  notice: "대중교통 경로 조회에 실패해 직선 근사 경로로 표시합니다.",
                }
              );
            }
          }
        }
      } else {
        dir = await fetchGoogleDirections(from.latlng, to.latlng, travelMode);
      }

      return dir
        ? {
            fromId: from.id,
            toId: to.id,
            fromName: from.name,
            toName: to.name,
            travelModeRequested: moveId === "public" ? "TRANSIT" : String(travelMode).toUpperCase(),
            ...dir,
          }
        : null;
    })
  );
  return results.filter(Boolean);
}

// ─── Reverse geocode ────────────────────────────────────────────────────────
export function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.Geocoder) { resolve(null); return; }
    new window.google.maps.Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const locality = results[0].address_components?.find((c) => c.types.includes("locality"));
        resolve(locality?.long_name ?? results[0].formatted_address ?? null);
      } else { resolve(null); }
    });
  });
}

// ─── Forward geocode (city name → lat/lng via Google Maps) ───────────────────
export function forwardGeocode(query) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.Geocoder) { resolve(null); return; }
    new window.google.maps.Geocoder().geocode({ address: query }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const loc = results[0].geometry.location;
        resolve([loc.lat(), loc.lng()]);
      } else { resolve(null); }
    });
  });
}

// ─── Place photo (Google Places API New) ─────────────────────────────────────
// maxWidth caps at 4800 on Google side. 1600 gives a sharp hi-res image for
// full-bleed backgrounds without blowing out bandwidth on dest-card grids.
export async function fetchPlacePhoto(query, { maxWidth = 1600 } = {}) {
  if (!window.google?.maps?.places?.Place) return null;
  try {
    const { places } = await window.google.maps.places.Place.searchByText({ textQuery: query, fields: ["photos"], maxResultCount: 1 });
    if (places?.[0]?.photos?.[0]) {
      return places[0].photos[0].getURI({ maxWidth });
    }
  } catch {}
  return null;
}

// ─── OSRM geometry ──────────────────────────────────────────────────────────
export async function fetchOsrmGeometry(fromLatLng, toLatLng, profile) {
  const a = `${fromLatLng[1]},${fromLatLng[0]}`;
  const b = `${toLatLng[1]},${toLatLng[0]}`;
  const base = import.meta.env.DEV ? "/osrm" : "https://router.project-osrm.org";
  const url = `${base}/route/v1/${profile}/${a};${b}?overview=full&geometries=geojson`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return coords.map(([lng, lat]) => [lat, lng]);
  } catch { return null; }
}

// ─── LLM configuration ──────────────────────────────────────────────────────
const LLM_PROVIDER = (import.meta.env.VITE_LLM_PROVIDER || "openai").trim().toLowerCase();
const OLLAMA_URL = (import.meta.env.VITE_OLLAMA_URL || "http://localhost:11434").trim();
const OLLAMA_TAGS_TTL_MS = 60 * 1000;
let ollamaTagsCache = { expiresAt: 0, models: null };
const LLM_SETTINGS = {
  openai: { provider: "openai", label: "OpenAI", key: import.meta.env.VITE_OPENAI_API_KEY, model: (import.meta.env.VITE_OPENAI_MODEL || "gpt-4o-mini").trim(), keyEnv: "VITE_OPENAI_API_KEY" },
  gemini: { provider: "gemini", label: "Gemini", key: import.meta.env.VITE_GEMINI_API_KEY, model: (import.meta.env.VITE_GEMINI_MODEL || "gemini-2.5-flash-lite").trim(), keyEnv: "VITE_GEMINI_API_KEY" },
  claude: { provider: "claude", label: "Claude", key: import.meta.env.VITE_CLAUDE_API_KEY, model: (import.meta.env.VITE_CLAUDE_MODEL || "claude-3-5-sonnet-latest").trim(), keyEnv: "VITE_CLAUDE_API_KEY" },
  ollama: { provider: "ollama", label: "Ollama (local)", key: "ollama", model: (import.meta.env.VITE_OLLAMA_MODEL || "bjoernb/gemma4-31b-think").trim(), keyEnv: "VITE_OLLAMA_MODEL" },
};
export const ACTIVE_LLM = LLM_SETTINGS[LLM_PROVIDER] ?? LLM_SETTINGS.openai;

function shouldRetryOllamaModel(errText) {
  const msg = String(errText ?? "").toLowerCase();
  return msg.includes("model") && (
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("pull") ||
    msg.includes("unknown")
  );
}

async function listOllamaModels() {
  if (ollamaTagsCache.models && ollamaTagsCache.expiresAt > Date.now()) return ollamaTagsCache.models;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    const models = (data?.models ?? []).map((m) => String(m?.name ?? "").trim()).filter(Boolean);
    ollamaTagsCache = { models, expiresAt: Date.now() + OLLAMA_TAGS_TTL_MS };
    return models;
  } catch {
    return [];
  }
}

async function pickOllamaRetryModel(preferredModel) {
  const models = await listOllamaModels();
  if (!models.length) return null;
  if (preferredModel && models.includes(preferredModel)) return preferredModel;
  const preferred = models.find((m) => /qwen|llama|gemma|phi|mistral|deepseek/i.test(m));
  return preferred ?? models[0];
}

/**
 * Per-function LLM routing.
 *
 * Allows each LLM function to run on a different provider/model via env vars.
 * Motivation: AutoDetect parser needs sub-2s response (cloud flash), while
 * heavy generations (dest, itinerary) can run on local Ollama for privacy and
 * cost. Defaults to ACTIVE_LLM when no override is set.
 *
 * Env var pattern: VITE_{FN}_PROVIDER + VITE_{FN}_MODEL
 *   Fn names: PARSER | GEOGRAPHY | DEST | TRANSPORT | LODGING | ITINERARY | LUCKY | REALTIME
 *
 * Example .env for hybrid mode:
 *   VITE_LLM_PROVIDER=ollama
 *   VITE_OLLAMA_MODEL=gemma4:latest
 *   VITE_PARSER_PROVIDER=gemini
 *   VITE_PARSER_MODEL=gemini-2.5-flash-lite
 *   VITE_GEOGRAPHY_PROVIDER=gemini
 *   VITE_GEOGRAPHY_MODEL=gemini-2.5-flash-lite
 */
function resolveFnConfig(fnName) {
  if (!fnName || fnName === "default") return ACTIVE_LLM;
  const upper = fnName.toUpperCase();
  const providerRaw = import.meta.env[`VITE_${upper}_PROVIDER`];
  const modelRaw = import.meta.env[`VITE_${upper}_MODEL`];
  if (!providerRaw && !modelRaw) return ACTIVE_LLM;
  const providerKey = (providerRaw ?? LLM_PROVIDER).trim().toLowerCase();
  const base = LLM_SETTINGS[providerKey] ?? ACTIVE_LLM;
  return {
    ...base,
    model: modelRaw ? modelRaw.trim() : base.model,
    fnName,
  };
}

function sanitizeGeminiResponse(data) {
  if (!data?.candidates) return data;
  return { ...data, candidates: data.candidates.map((c) => ({ ...c, content: c.content ? { ...c.content, parts: (c.content.parts ?? []).map(({ thoughtSignature, ...rest }) => rest) } : c.content })) };
}


export async function callLLM({ userMessage, plan, currentTime, location, weather, progress, history, directions, onLog }) {
  if (!ACTIVE_LLM.key) {
    const reqLog = { provider: "simulation", model: "rule-based", userMessage, timestamp: new Date().toISOString() };
    await new Promise((r) => setTimeout(r, 700));
    const result = simulateLLMResponse(userMessage, plan, currentTime);
    if (onLog) onLog({ ...reqLog, responseText: result.text, modifiedSchedule: result.modifiedSchedule });
    return result;
  }
  const systemContent = buildRealtimeSystemPrompt({ plan, currentTime, location, weather, progress, directions });
  const chatMessages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: userMessage }];
  let reqBody = null; let resData = null; let raw = "";

  try {
    if (ACTIVE_LLM.provider === "openai" || ACTIVE_LLM.provider === "ollama") {
      const isOllama = ACTIVE_LLM.provider === "ollama";
      const apiUrl = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
      const headers = { "Content-Type": "application/json" };
      if (!isOllama) headers.Authorization = `Bearer ${ACTIVE_LLM.key}`;
      const messages = [{ role: "system", content: systemContent }, ...chatMessages];
      reqBody = { model: ACTIVE_LLM.model, messages, max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error(ACTIVE_LLM.provider);
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (ACTIVE_LLM.provider === "gemini") {
      const geminiMessages = chatMessages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      reqBody = { systemInstruction: { parts: [{ text: systemContent }] }, contents: geminiMessages, generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ACTIVE_LLM.model)}:generateContent?key=${encodeURIComponent(ACTIVE_LLM.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("gemini");
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (ACTIVE_LLM.provider === "claude") {
      const claudeMessages = chatMessages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      reqBody = { model: ACTIVE_LLM.model, system: systemContent, max_tokens: 1200, temperature: 0.7, messages: claudeMessages };
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ACTIVE_LLM.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("claude");
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    }
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
    let modifiedSchedule = null;
    if (jsonMatch) { try { modifiedSchedule = JSON.parse(jsonMatch[1]).modifiedSchedule ?? null; } catch (e) { console.error("[LLM] JSON parse error:", e); } }
    const result = { text: raw.replace(/```json[\s\S]*?```/g, "").trim(), modifiedSchedule };
    const logResData = ACTIVE_LLM.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: ACTIVE_LLM.provider, model: ACTIVE_LLM.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: result.text, modifiedSchedule, timestamp: new Date().toISOString() });
    return result;
  } catch {
    const fallback = simulateLLMResponse(userMessage, plan, currentTime);
    if (onLog) onLog({ provider: ACTIVE_LLM.provider + " (fallback)", model: "rule-based", userMessage, requestBody: reqBody, responseText: fallback.text, modifiedSchedule: fallback.modifiedSchedule, error: true, timestamp: new Date().toISOString() });
    return fallback;
  }
}

// ─── JSON repair helper ───────────────────────────────────────────────────────
// Stack-based repair: inserts missing } before ] when an object is still open,
// then appends any remaining unclosed structures at the end.
// Handles the common LLM pattern where the last array item is missing its closing }.
function tryRepairJSON(str) {
  const stack = [];
  let result = '';
  let inStr = false, escape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; result += ch; continue; }
    if (ch === '\\' && inStr) { escape = true; result += ch; continue; }
    if (ch === '"') { inStr = !inStr; result += ch; continue; }
    if (inStr) { result += ch; continue; }
    if (ch === '{') { stack.push('}'); result += ch; }
    else if (ch === '[') { stack.push(']'); result += ch; }
    else if (ch === '}' || ch === ']') {
      // Insert missing closers until we match
      while (stack.length > 0 && stack[stack.length - 1] !== ch) result += stack.pop();
      if (stack.length > 0) stack.pop();
      result += ch;
    } else { result += ch; }
  }
  result = result.trimEnd().replace(/,\s*$/, '');
  while (stack.length > 0) result += stack.pop();
  return result;
}

// ─── Destination LLM ─────────────────────────────────────────────────────────
// Strip app-enriched fields (_photo, trav_loc_latlng) from assistant messages
// before sending history back to the LLM — these are not LLM-generated and
// can inflate prompt tokens by thousands when Google Photos URLs accumulate.
function stripEnrichedFields(history) {
  return history.map((msg) => {
    if (msg.role !== "assistant") return msg;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed.destinations)) {
        parsed.destinations = parsed.destinations.map(({ _photo, trav_loc_latlng, ...rest }) => rest);
      }
      return { ...msg, content: JSON.stringify(parsed) };
    } catch { return msg; }
  });
}

// chatHistory: [{role: "user"|"assistant", content: string}, ...]
export async function callDestinationLLM(userMessage, chatHistory, onLog, count = 4) {
  const prefixed = `[${count}개 추천해줘] ${userMessage}`;
  const messages = [...stripEnrichedFields(chatHistory), { role: "user", content: prefixed }];
  const timestamp = new Date().toISOString();
  if (!ACTIVE_LLM.key) {
    await new Promise((r) => setTimeout(r, 500));
    const fallback = {
      destinations: [
        { trav_loc: "도쿄 (Tokyo)", trav_loc_sum: "시부야 쇼핑, 아사쿠사 사원, 하라주쿠 트렌드 탐방", trav_loc_reason: "다양한 문화 체험과 맛집이 풍부한 도시", trav_loc_depth: { continent: "아시아", country: "일본", region: "도쿄도", city: "시부야구", detail: "시부야 스크램블 교차로 일대" } },
        { trav_loc: "방콕 (Bangkok)", trav_loc_sum: "왕궁 관광, 카오산로드 야시장, 짜뚜짝 마켓 쇼핑", trav_loc_reason: "가성비 좋은 동남아 대표 여행지", trav_loc_depth: { continent: "아시아", country: "태국", region: "방콕특별시", city: "프라나콘구", detail: "왕궁 및 왓프라깨우 사원 일대" } },
        { trav_loc: "파리 (Paris)", trav_loc_sum: "에펠탑, 루브르 박물관, 몽마르뜨 카페 산책", trav_loc_reason: "예술과 미식의 유럽 대표 도시", trav_loc_depth: { continent: "유럽", country: "프랑스", region: "일드프랑스", city: "파리", detail: "샹젤리제 거리 및 에펠탑 일대" } },
        { trav_loc: "바르셀로나 (Barcelona)", trav_loc_sum: "사그라다 파밀리아, 람블라스 거리, 해변 산책", trav_loc_reason: "건축과 지중해를 동시에 즐기는 도시", trav_loc_depth: { continent: "유럽", country: "스페인", region: "카탈루냐", city: "바르셀로나", detail: "고딕 지구 및 람블라스 거리" } },
      ],
      follow_up_questions: ["여행 기간은 며칠 정도 생각하고 계신가요?", "혼자 여행인가요, 동행이 있나요?", "예산 범위가 어느 정도인가요?"],
    };
    if (onLog) onLog({ provider: "simulation", model: "rule-based", userMessage, requestBody: { messages }, responseText: JSON.stringify(fallback), timestamp });
    return fallback;
  }
  let reqBody = null; let resData = null; let raw = "";
  try {
    if (ACTIVE_LLM.provider === "openai" || ACTIVE_LLM.provider === "ollama") {
      const isOllama = ACTIVE_LLM.provider === "ollama";
      const apiUrl = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
      const headers = { "Content-Type": "application/json" };
      if (!isOllama) headers.Authorization = `Bearer ${ACTIVE_LLM.key}`;
      const apiMsgs = [{ role: "system", content: DEST_SYSTEM_PROMPT }, ...messages];
      reqBody = { model: ACTIVE_LLM.model, messages: apiMsgs, max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error(ACTIVE_LLM.provider);
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (ACTIVE_LLM.provider === "gemini") {
      // Gemini requires alternating user/model roles — merge consecutive same-role messages
      const merged = [];
      for (const m of messages) {
        const role = m.role === "assistant" ? "model" : "user";
        if (merged.length > 0 && merged[merged.length - 1].role === role) {
          merged[merged.length - 1].parts[0].text += "\n" + m.content;
        } else {
          merged.push({ role, parts: [{ text: m.content }] });
        }
      }
      // Gemini must start with user role
      if (merged.length > 0 && merged[0].role === "model") {
        merged.unshift({ role: "user", parts: [{ text: "여행지를 추천해주세요." }] });
      }
      reqBody = { systemInstruction: { parts: [{ text: DEST_SYSTEM_PROMPT }] }, contents: merged, generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json" } };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ACTIVE_LLM.model)}:generateContent?key=${encodeURIComponent(ACTIVE_LLM.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[Gemini Dest]", res.status, errText);
        throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (ACTIVE_LLM.provider === "claude") {
      const claudeMsgs = messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      reqBody = { model: ACTIVE_LLM.model, system: DEST_SYSTEM_PROMPT, max_tokens: 1500, temperature: 0.7, messages: claudeMsgs };
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ACTIVE_LLM.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("claude");
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    }
    let cleaned = raw.trim();
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1].trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (_) { parsed = JSON.parse(tryRepairJSON(cleaned)); }
    const logResData = ACTIVE_LLM.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: ACTIVE_LLM.provider, model: ACTIVE_LLM.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: raw, timestamp });
    if (Array.isArray(parsed)) return { destinations: parsed, follow_up_questions: [], raw };
    return { destinations: parsed.destinations ?? [], follow_up_questions: parsed.follow_up_questions ?? [], raw };
  } catch (e) {
    console.error("[Destination LLM] error:", e);
    const logResData = ACTIVE_LLM.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: ACTIVE_LLM.provider + " (error)", model: ACTIVE_LLM.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: raw || e.message, error: true, timestamp });
    return { destinations: [], follow_up_questions: [] };
  }
}

// ─── Generic LLM call (system + user message → JSON response) ────────────────
/**
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Function} [onLog]
 * @param {string} [fnName] — optional per-function routing key (e.g., "parser",
 *   "dest", "geography"). Looks up VITE_{FN}_PROVIDER/MODEL from env to pick a
 *   different provider/model than the default. See resolveFnConfig.
 */
export async function callGenericLLM(systemPrompt, userMessage, onLog, fnName) {
  const cfg = resolveFnConfig(fnName);
  const timestamp = new Date().toISOString();
  let usedModel = cfg.model;
  if (!cfg.key) {
    if (onLog) onLog({ provider: "simulation", model: "rule-based", userMessage, timestamp, error: true, responseText: "No API key" });
    return null;
  }
  let reqBody = null; let resData = null; let raw = "";
  try {
    if (cfg.provider === "openai") {
      const apiUrl = "https://api.openai.com/v1/chat/completions";
      const headers = { "Content-Type": "application/json" };
      headers.Authorization = `Bearer ${cfg.key}`;
      reqBody = { model: cfg.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }], max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`${cfg.provider} ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (cfg.provider === "ollama") {
      const apiUrl = `${OLLAMA_URL}/v1/chat/completions`;
      const headers = { "Content-Type": "application/json" };
      const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
      const buildBody = (model) => ({ model, messages, temperature: 0.7 });

      usedModel = cfg.model;
      reqBody = buildBody(usedModel);
      let res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const shouldRetry = res.status === 400 && shouldRetryOllamaModel(errText);
        if (shouldRetry) {
          const retryModel = await pickOllamaRetryModel(usedModel);
          if (retryModel && retryModel !== usedModel) {
            usedModel = retryModel;
            reqBody = buildBody(usedModel);
            res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
            if (!res.ok) {
              const retryErrText = await res.text().catch(() => "");
              throw new Error(`ollama ${res.status}: ${retryErrText.slice(0, 300)}`);
            }
          } else {
            throw new Error(`ollama ${res.status}: ${errText.slice(0, 300)}`);
          }
        } else {
          throw new Error(`ollama ${res.status}: ${errText.slice(0, 300)}`);
        }
      }
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (cfg.provider === "gemini") {
      reqBody = { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: "user", parts: [{ text: userMessage }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json" } };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (cfg.provider === "claude") {
      reqBody = { model: cfg.model, system: systemPrompt, max_tokens: 4096, temperature: 0.7, messages: [{ role: "user", content: userMessage }] };
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`claude ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    }
    let cleaned = raw.trim();
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1].trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch (_) { parsed = JSON.parse(tryRepairJSON(cleaned)); }
    const logResData = cfg.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: cfg.provider, model: usedModel, userMessage, requestBody: reqBody, responseData: logResData, responseText: raw, timestamp, fn: fnName ?? "default" });
    return parsed;
  } catch (e) {
    console.error(`[GenericLLM:${fnName ?? "default"}] error:`, e);
    if (onLog) onLog({ provider: cfg.provider + " (error)", model: usedModel, userMessage, requestBody: reqBody, responseText: raw || e.message, error: true, timestamp, fn: fnName ?? "default" });
    return null;
  }
}

// ─── Generate transport options ──────────────────────────────────────────────
export async function generateTransports(country, city, days, onLog) {
  const result = await callGenericLLM(TRANSPORT_PROMPT, `${country} ${city} ${days} 여행 시 이동수단 3가지 추천`, onLog, "transport");
  if (Array.isArray(result) && result.length > 0) return result;
  return null; // null = use hardcoded MOVES fallback
}

// ─── Generate lodgings ───────────────────────────────────────────────────────
export async function generateLodgings(country, city, onLog) {
  const result = await callGenericLLM(LODGING_PROMPT, `${country} ${city} 여행 숙소 지역 4곳 추천`, onLog, "lodging");
  if (Array.isArray(result) && result.length > 0) return result;
  return [
    { id: "lodging-1", name: `${city} 중심가 숙소`, summary: "교통 접근성이 좋은 중심지 숙소", area: city },
    { id: "lodging-2", name: `${city} 역세권 숙소`, summary: "역 근처 편리한 위치", area: city },
  ];
}

// ─── Generate hotel insights (pros / cons / tags / price range) ────────────
/**
 * Batch-infer traveler-facing insights for a list of hotels. One LLM call
 * for the whole array — returns per-hotel tags, pros, cons, and an estimated
 * Korean nightly price range. Used by HotelBrowseModal to power filter chips
 * and card descriptions. Tags come from a closed set so the filter UI stays
 * predictable.
 *
 * Returns: [{ id, tags: [string], pros: [string], cons: [string], priceRange: string }]
 * or null on failure (modal just skips the insights row).
 */
export async function generateHotelInsights(hotels, { country, region } = {}, onLog) {
  if (!Array.isArray(hotels) || hotels.length === 0) return null;
  const payload = hotels.slice(0, 20).map((h) => ({
    id: h.id,
    name: h.name,
    address: h.address,
    rating: h.rating ?? null,
    ratingCount: h.ratingCount ?? null,
    priceLevel: h.priceLevel ?? null,
  }));
  const systemPrompt = `You analyze hotels for Korean travelers. For each hotel in the input array, infer realistic traveler-facing insights based on name, location, rating, and price level. Output JSON:

{ "hotels": [{ "id": "...", "tags": ["..."], "pros": ["..."], "cons": ["..."], "priceRange": "..." }] }

Strict rules:
- tags: pick 1-3 from this EXACT closed set — ["역세권", "가성비", "시설좋음", "비즈니스", "럭셔리", "조용함", "관광중심"]. Do NOT invent new tags.
- pros: 2-3 very short Korean phrases (각 12자 이내). Concrete traveler benefits: "역 3분", "조식 포함", "넓은 객실" etc.
- cons: 1-2 very short Korean phrases (각 12자 이내). Honest drawbacks: "방 좁음", "관광지 멀어", "가격대 높음" etc.
- priceRange: estimated Korean nightly range. Format: "n만원대" or "n만원대+" (e.g. "8만원대", "15만원대", "30만원대+")
- Price level inference:
  - PRICE_LEVEL_INEXPENSIVE → 5-10만원대
  - PRICE_LEVEL_MODERATE → 10-20만원대
  - PRICE_LEVEL_EXPENSIVE → 20-35만원대
  - PRICE_LEVEL_VERY_EXPENSIVE → 35만원대+
  - null/missing priceLevel → infer from name & rating
- Brand heuristics (apply when name matches):
  - Toyoko Inn / Dormy Inn / Super Hotel / APA / Route Inn / 비즈니스 → tags include ["가성비", "비즈니스"], pros like ["역 근처", "저렴"], cons include ["방 크기 작음"]
  - Hyatt / Marriott / Hilton / Ritz / Four Seasons / Conrad / Mandarin → tags include ["럭셔리", "시설좋음"], pros ["최고급 시설", "넓은 객실"], cons ["가격대 높음"]
  - Hostel / Guesthouse → tags ["가성비"], pros ["저렴"], cons ["사생활 제한"]
- 역세권 tag: only if name or address clearly suggests station proximity (contains 역/Station/駅 nearby, or business chain brand).
- Return the hotels in the SAME order and with the SAME id strings as the input.`;

  const userMessage = `Country: ${country || "?"}, Region: ${region || "?"}\n\nHotels:\n${JSON.stringify(payload, null, 2)}`;
  const result = await callGenericLLM(systemPrompt, userMessage, onLog, "hotel_insights");
  if (!result) return null;
  const list = Array.isArray(result) ? result : result.hotels;
  return Array.isArray(list) ? list : null;
}

function parseTripDayCount(days) {
  const clamp = (n) => Math.max(1, Math.min(10, n));
  if (Number.isFinite(Number(days))) return clamp(Number(days));
  const text = String(days ?? "").trim();
  if (!text) return 3;

  const nightsDays = text.match(/(\d+)\s*박\s*(\d+)\s*일/);
  if (nightsDays) return clamp(Number.parseInt(nightsDays[2], 10));

  const dayOnly = text.match(/(\d+)\s*일/);
  if (dayOnly) return clamp(Number.parseInt(dayOnly[1], 10));

  const nums = text.match(/\d+/g);
  if (nums?.length) return clamp(Number.parseInt(nums[nums.length - 1], 10));
  return 3;
}

function makeUniqueSpotId(baseId, usedIds, day, idx) {
  const normalizedBase = String(baseId ?? "").trim() || `spot-d${day}-${idx + 1}`;
  if (!usedIds.has(normalizedBase)) {
    usedIds.add(normalizedBase);
    return normalizedBase;
  }
  let suffix = 2;
  while (usedIds.has(`${normalizedBase}-${suffix}`)) suffix += 1;
  const id = `${normalizedBase}-${suffix}`;
  usedIds.add(id);
  return id;
}

function rebalanceItineraryDays(days) {
  const out = days.map((d) => ({ ...d, spots: [...(d.spots ?? [])] }));
  const totalSpots = out.reduce((sum, d) => sum + (d.spots?.length ?? 0), 0);
  if (totalSpots < out.length) return out;

  for (let targetIdx = 0; targetIdx < out.length; targetIdx += 1) {
    if ((out[targetIdx].spots?.length ?? 0) > 0) continue;
    let donorIdx = -1;
    let donorCount = 1;
    for (let i = 0; i < out.length; i += 1) {
      const count = out[i].spots?.length ?? 0;
      if (count > donorCount) {
        donorCount = count;
        donorIdx = i;
      }
    }
    if (donorIdx < 0) break;
    const moved = out[donorIdx].spots.pop();
    if (moved) out[targetIdx].spots.push({ ...moved, time: moved.time ?? "10:00" });
  }

  return out;
}

function normalizeItineraryResult(result, dayCount) {
  if (!result || !Array.isArray(result.days)) return null;

  const byDay = new Map();
  result.days.forEach((d, idx) => {
    const parsedDay = Number.parseInt(d?.day, 10);
    const day = Number.isFinite(parsedDay) ? parsedDay : (idx + 1);
    if (day >= 1 && day <= dayCount && !byDay.has(day)) {
      byDay.set(day, d);
    }
  });

  const usedIds = new Set();
  const normalizedDays = [];

  for (let day = 1; day <= dayCount; day += 1) {
    const srcDay = byDay.get(day) ?? { day, theme: `DAY ${day} 추천 일정`, spots: [] };
    const rawSpots = Array.isArray(srcDay.spots) ? srcDay.spots : [];
    const spots = rawSpots.map((spot, idx) => {
      const nameSeed = String(spot?.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const baseId = spot?.id ?? nameSeed;
      return { ...spot, id: makeUniqueSpotId(baseId, usedIds, day, idx) };
    });
    normalizedDays.push({ ...srcDay, day, spots });
  }

  const balancedDays = rebalanceItineraryDays(normalizedDays);
  return { ...result, days: balancedDays };
}

// ─── Generate complete itinerary (spots pre-assigned to days) ────────────────
export async function generateItinerary(country, city, tags, days, transportName, onLog) {
  const dayCount = parseTripDayCount(days);
  const tagStr = tags.length > 0 ? tags.join(", ") : "전체";
  const msg = `${country} ${city} ${dayCount - 1}박${dayCount}일 여행 일정 생성.\n선호 성향: ${tagStr}\n이동수단: ${transportName}\n${dayCount}일간의 완벽한 일정을 만들어줘.\n중요: days 배열은 DAY 1부터 DAY ${dayCount}까지 정확히 ${dayCount}개를 포함해야 하며, day 값은 누락 없이 연속이어야 한다.`;
  const result = await callGenericLLM(ITINERARY_PROMPT, msg, onLog, "itinerary");
  const normalized = normalizeItineraryResult(result, dayCount);
  if (normalized?.days && normalized.days.length > 0) return normalized;
  return null;
}
