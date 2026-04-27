import { escapeHtml, parseBooleanEnv, simulateLLMResponse } from "./utils.js";
import {
  DEST_SYSTEM_PROMPT,
  TRANSPORT_PROMPT,
  LODGING_PROMPT,
  ITINERARY_PROMPT,
  ALTERNATIVES_PROMPT,
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
export async function fetchNearbyPlaces(lat, lng, type = "tourist_attraction", radius = 1500, maxResults = 6) {
  if (!window.google?.maps?.places?.Place) return [];
  try {
    const { places } = await window.google.maps.places.Place.searchNearby({
      locationRestriction: { center: { lat, lng }, radius },
      includedPrimaryTypes: [type],
      // location lets the caller place markers / fetch directions without a
      // follow-up Place Details call. photos enables thumbnail generation via
      // fetchPlacePhoto. primaryTypeDisplayName provides a localized category.
      fields: ["displayName", "formattedAddress", "rating", "currentOpeningHours", "id", "location", "photos", "primaryTypeDisplayName"],
      maxResultCount: maxResults,
    });
    return (places ?? []).map((p) => {
      const loc = p.location;
      const placeLat = typeof loc?.lat === "function" ? loc.lat() : loc?.lat;
      const placeLng = typeof loc?.lng === "function" ? loc.lng() : loc?.lng;
      const latlng = Number.isFinite(placeLat) && Number.isFinite(placeLng) ? [placeLat, placeLng] : null;
      // Call getURI inline while the Place object is still alive — once the
      // searchNearby promise resolves the Photo handles remain valid for the
      // session, but capturing the URL up-front avoids storing live refs.
      let photoUrl = null;
      try {
        const photo = Array.isArray(p.photos) && p.photos.length > 0 ? p.photos[0] : null;
        if (photo && typeof photo.getURI === "function") {
          photoUrl = photo.getURI({ maxWidth: 600 });
        }
      } catch {}
      return {
        name: p.displayName,
        vicinity: p.formattedAddress,
        rating: p.rating,
        openNow: p.currentOpeningHours?.isOpen?.() ?? null,
        id: p.id,
        latlng,
        photoUrl,
        category: p.primaryTypeDisplayName ?? null,
      };
    });
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
// Set VITE_ROUTES_API_DEBUG=true to see full request body + response body for
// every Routes API failure. Off by default to avoid console noise.
const ROUTES_API_DEBUG = parseBooleanEnv(import.meta.env.VITE_ROUTES_API_DEBUG, false);
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
  // Real-world line colors — Google returns hex strings like "#0072BC" for
  // 서울 1호선, "#00A84D" for 2호선, etc. We use these to paint polylines so
  // the map matches official transit signage instead of generic mode colors.
  "routes.legs.steps.transitDetails.transitLine.color",
  "routes.legs.steps.transitDetails.transitLine.textColor",
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
// Per-variant signature dedupe — keyed by `${travelMode}:${variant.tag}` so
// each distinct variant gets one warning even if its body changes between
// calls. Reset (cleared) every 5 min to allow fresh diagnostics.
const variantErrorSigs = new Map();
const VARIANT_ERROR_DEDUPE_MS = 5 * 60 * 1000;
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

// Validate hex color from Google Routes API. Routes API typically returns
// "#RRGGBB" but we defensively accept "#RGB" too and reject anything else
// (e.g. CSS keywords, malformed strings) before piping to inline styles.
function sanitizeHexColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) return trimmed;
  return null;
}

function normalizeTransitStep(transitDetails) {
  if (!transitDetails) return null;
  const line = transitDetails.transitLine ?? {};
  const vehicle = line.vehicle ?? {};
  const stopDetails = transitDetails.stopDetails ?? transitDetails;
  return {
    lineName: line.name ?? "",
    lineShort: line.nameShort ?? "",
    lineColor: sanitizeHexColor(line.color),
    lineTextColor: sanitizeHexColor(line.textColor),
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

// Color palette for step-level polyline rendering. Walking sections of a
// transit leg should look different from the bus/subway sections so the user
// can tell at a glance where they need to walk vs ride.
const STEP_MODE_COLORS = {
  WALKING: "#5ecfcf",
  TRANSIT: "#ffd23f",
  DRIVING: "#e8a020",
  BICYCLING: "#a3e635",
};

export function colorForStepMode(mode) {
  const m = String(mode ?? "").toUpperCase();
  return STEP_MODE_COLORS[m] ?? "#5ecfcf";
}

// Build per-step polyline segments from a normalized direction result. Each
// returned entry is { mode, color, path, lineLabel? }, suitable for rendering
// as a distinct polyline. For TRANSIT steps we prefer the Google-supplied
// real-world line color (서울 1호선 남색, 2호선 초록색, etc.) and fall back
// to the generic mode color when the line color is missing.
//
// Falls back to [] when steps lack geometry — caller should fall back to the
// leg-level `polylinePath` in that case.
export function buildStepSegments(direction) {
  if (!direction || !Array.isArray(direction.steps)) return [];
  const out = [];
  for (const step of direction.steps) {
    const path = step.polylinePath;
    if (!Array.isArray(path) || path.length < 2) continue;
    const mode = String(step.travelMode ?? "").toUpperCase();
    const lineColor = mode === "TRANSIT" ? step.transit?.lineColor : null;
    out.push({
      mode,
      color: lineColor || colorForStepMode(mode),
      path,
      lineLabel: mode === "TRANSIT"
        ? (step.transit?.lineShort || step.transit?.lineName || step.transit?.vehicleName || "")
        : "",
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
    lineColor: sanitizeHexColor(line.color),
    lineTextColor: sanitizeHexColor(line.text_color),
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

  if (isTransit) {
    baseBody.departureTime = opts.departureTime ?? new Date().toISOString();
    // transitPreferences: { allowedTravelModes?: [...], routingPreference?: "LESS_WALKING"|"FEWER_TRANSFERS" }
    // Forwarded only when caller supplies explicit preferences — Routes API
    // rejects empty objects with INVALID_ARGUMENT.
    const prefs = opts.transitPreferences;
    if (prefs && typeof prefs === "object") {
      const cleaned = {};
      if (Array.isArray(prefs.allowedTravelModes) && prefs.allowedTravelModes.length > 0) {
        cleaned.allowedTravelModes = prefs.allowedTravelModes;
      }
      if (typeof prefs.routingPreference === "string" && prefs.routingPreference) {
        cleaned.routingPreference = prefs.routingPreference;
      }
      if (Object.keys(cleaned).length > 0) baseBody.transitPreferences = cleaned;
    }
  }
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

    // Auto-fallback when transitPreferences is the offender. We strip prefs
    // before the relaxed variant so a single bad pref combo doesn't poison
    // the whole leg fetch — the relaxed variant gets one more chance after
    // this with no languageCode either.
    if (baseBody.transitPreferences) {
      const noPrefsBody = { ...baseBody };
      delete noPrefsBody.transitPreferences;
      requestVariants.push({
        tag: "transit-no-prefs",
        body: noPrefsBody,
        fieldMask: ROUTES_BASE_FIELD_MASK.join(","),
      });
    }

    const relaxedTransitBody = { ...baseBody };
    delete relaxedTransitBody.languageCode;
    delete relaxedTransitBody.transitPreferences;
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
      // Per-variant dedupe so each distinct variant tag gets exactly one
      // warning per 5-min window, with body + response excerpts. Verbose mode
      // (VITE_ROUTES_API_DEBUG=true) bypasses dedupe and prints full bodies.
      const sigKey = `${travelMode}:${variant.tag}`;
      const lastAt = variantErrorSigs.get(sigKey) ?? 0;
      const dedupeExpired = Date.now() - lastAt > VARIANT_ERROR_DEDUPE_MS;
      if (ROUTES_API_DEBUG || dedupeExpired) {
        variantErrorSigs.set(sigKey, Date.now());
        const bodyPreview = ROUTES_API_DEBUG
          ? JSON.stringify(variant.body)
          : JSON.stringify(variant.body).slice(0, 200);
        const errPreview = ROUTES_API_DEBUG ? lastError : lastError.slice(0, 300);
        console.warn(
          `[Routes API] ${res.status} on variant=${variant.tag} mode=${travelMode}\n  body: ${bodyPreview}\n  resp: ${errPreview}`
        );
      }
      continue;
    }
    finalizeVariantSupport(variant.tag, true, res.status);
    const data = await res.json();
    route = data?.routes?.[0] ?? null;
    if (route) break;
  }

  if (!route) {
    if (hadBadRequest) routesApiDisabledUntil = Date.now() + ROUTES_SOFT_DISABLE_WINDOW_MS;
    // Per-variant warnings already fired in the loop above; no further log
    // here to avoid duplicating the same context.
    return null;
  }

  const durationSecs = parseDurationSeconds(route.duration);
  const distanceMeters = route.distanceMeters ?? null;

  const decodeEncodedPath = (encoded) => {
    if (!encoded || !window.google?.maps?.geometry) return null;
    return window.google.maps.geometry.encoding
      .decodePath(encoded)
      .map((p) => [p.lat(), p.lng()]);
  };

  const polylinePath = decodeEncodedPath(route.polyline?.encodedPolyline);
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
      polylinePath: decodeEncodedPath(s.polyline?.encodedPolyline),
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
 * @param {{ departureTime?: string, transitPreferences?: { allowedTravelModes?: string[], routingPreference?: "LESS_WALKING"|"FEWER_TRANSFERS" } }} [options={}]
 *   departureTime — ISO 8601 UTC (e.g. "2024-03-15T09:00:00Z").
 *   When provided, bypasses the direction cache so the time-sensitive
 *   sequential transit chain always gets a fresh result.
 *   transitPreferences — Forwarded to the Routes API only for TRANSIT mode.
 *   Presence also bypasses the cache (different prefs → different routes).
 */
export async function fetchGoogleDirections(originLatLng, destLatLng, travelMode = "DRIVING", options = {}) {
  if (!isValidLatLng(originLatLng) || !isValidLatLng(destLatLng)) return null;
  if (isSameLatLng(originLatLng, destLatLng)) {
    return buildZeroDistanceDirection(originLatLng, travelMode);
  }
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const { departureTime = null, transitPreferences = null } = options;
  // Time-stamped or pref-tuned transit requests must not use the cache.
  const bypassCache = Boolean(departureTime) || Boolean(transitPreferences);
  const cacheKey = buildDirectionCacheKey(originLatLng, destLatLng, travelMode);
  if (!bypassCache) {
    const now = Date.now();
    const cached = directionsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    if (directionsInFlight.has(cacheKey)) return directionsInFlight.get(cacheKey);
  }

  const routeOpts = {};
  if (departureTime) routeOpts.departureTime = departureTime;
  if (transitPreferences) routeOpts.transitPreferences = transitPreferences;
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

  if (bypassCache) {
    // Don't cache time-stamped or pref-tuned results — let them complete and return directly.
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
  if (isoString == null || isoString === "") return null;
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
//
// `options`:
//   bounds   — `{ south, west, north, east }` rectangular bias box; Google
//              treats it as a soft preference, not a strict filter
//   region   — ccTLD region bias ("jp", "kr", ...)
//   details  — when true, resolve with an enriched object instead of `[lat,lng]`,
//              so callers can detect partial matches and pick the best query.
//
// Default return shape (no `details`) is `[lat, lng] | null`, preserving
// backward compatibility with callers that only need coordinates.
export function forwardGeocode(query, options = {}) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.Geocoder) { resolve(null); return; }
    const { bounds, region, details = false } = options;
    const request = { address: query };
    if (bounds && Number.isFinite(bounds.south) && Number.isFinite(bounds.west)
      && Number.isFinite(bounds.north) && Number.isFinite(bounds.east)) {
      request.bounds = {
        south: bounds.south, west: bounds.west, north: bounds.north, east: bounds.east,
      };
    }
    if (region) request.region = region;
    new window.google.maps.Geocoder().geocode(request, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const r = results[0];
        const loc = r.geometry.location;
        const latlng = [loc.lat(), loc.lng()];
        if (!details) { resolve(latlng); return; }
        resolve({
          latlng,
          partialMatch: Boolean(r.partial_match),
          locationType: r.geometry?.location_type ?? null,
          formattedAddress: r.formatted_address ?? null,
          types: r.types ?? [],
        });
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
const LMSTUDIO_URL = (import.meta.env.VITE_LMSTUDIO_URL || "http://localhost:1234").trim();
const OLLAMA_TAGS_TTL_MS = 60 * 1000;
let ollamaTagsCache = { expiresAt: 0, models: null };
const LLM_SETTINGS = {
  openai: { provider: "openai", label: "OpenAI", key: import.meta.env.VITE_OPENAI_API_KEY, model: (import.meta.env.VITE_OPENAI_MODEL || "gpt-4o-mini").trim(), keyEnv: "VITE_OPENAI_API_KEY" },
  gemini: { provider: "gemini", label: "Gemini", key: import.meta.env.VITE_GEMINI_API_KEY, model: (import.meta.env.VITE_GEMINI_MODEL || "gemini-2.5-flash-lite").trim(), keyEnv: "VITE_GEMINI_API_KEY" },
  claude: { provider: "claude", label: "Claude", key: import.meta.env.VITE_CLAUDE_API_KEY, model: (import.meta.env.VITE_CLAUDE_MODEL || "claude-3-5-sonnet-latest").trim(), keyEnv: "VITE_CLAUDE_API_KEY" },
  ollama: { provider: "ollama", label: "Ollama (local)", key: "ollama", model: (import.meta.env.VITE_OLLAMA_MODEL || "bjoernb/gemma4-31b-think").trim(), keyEnv: "VITE_OLLAMA_MODEL" },
  lmstudio: { provider: "lmstudio", label: "LM Studio (local)", key: "lmstudio", model: (import.meta.env.VITE_LMSTUDIO_MODEL || "local-model").trim(), keyEnv: "VITE_LMSTUDIO_MODEL" },
};
export const ACTIVE_LLM = LLM_SETTINGS[LLM_PROVIDER] ?? LLM_SETTINGS.openai;

// True for providers that speak the OpenAI Chat Completions wire format.
// LM Studio + Ollama both expose `/v1/chat/completions`, but only Ollama
// accepts the `options.num_ctx` extension — LM Studio rejects unknown body
// fields on stricter versions, so we keep the request body minimal for it.
function isOpenAICompatProvider(provider) {
  return provider === "openai" || provider === "ollama" || provider === "lmstudio";
}

function openAICompatUrl(provider) {
  if (provider === "ollama") return `${OLLAMA_URL}/v1/chat/completions`;
  if (provider === "lmstudio") return `${LMSTUDIO_URL}/v1/chat/completions`;
  return "https://api.openai.com/v1/chat/completions";
}

function needsOpenAIAuthHeader(provider) {
  return provider === "openai";
}

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

/**
 * Multi-turn chat LLM call that returns raw text (no JSON parsing).
 *
 * Why this exists: callGenericLLM forces JSON-only output via response_format
 * and a single user message. Co-Pilot needs multi-turn history AND can return
 * either text-only counter-questions OR text+JSON modifications. Caller does
 * its own parsing, so this helper just owns the provider routing + auth +
 * error logging that all chat-flavored consumers share.
 *
 * @param {Object} args
 * @param {string} args.systemPrompt
 * @param {Array<{role:"user"|"assistant", content:string}>} args.messages
 * @param {Function} [args.onLog]
 * @param {string} [args.fnName="copilot"]  per-function provider override key
 * @returns {Promise<{text:string, raw:any}>}
 */
export async function callChatLLM({ systemPrompt, messages, onLog, fnName = "copilot" }) {
  const cfg = resolveFnConfig(fnName);
  const timestamp = new Date().toISOString();
  if (!cfg.key) {
    if (onLog) onLog({ provider: "simulation", model: "rule-based", responseText: "No API key", error: true, timestamp, fn: fnName });
    throw new Error("LLM API key not configured");
  }
  let reqBody = null;
  let resData = null;
  let raw = "";
  try {
    if (isOpenAICompatProvider(cfg.provider)) {
      const apiUrl = openAICompatUrl(cfg.provider);
      const headers = { "Content-Type": "application/json" };
      if (needsOpenAIAuthHeader(cfg.provider)) headers.Authorization = `Bearer ${cfg.key}`;
      const apiMsgs = [{ role: "system", content: systemPrompt }, ...messages];
      reqBody = { model: cfg.model, messages: apiMsgs, max_tokens: 4096, temperature: 0.7 };
      // Ollama-only: extend context window so longer schedules fit. LM Studio
      // and OpenAI reject this field — keep behavior conditional.
      if (cfg.provider === "ollama") reqBody.options = { num_ctx: 8192 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`${cfg.provider} ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (cfg.provider === "gemini") {
      const geminiMessages = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      reqBody = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: geminiMessages,
        generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
      };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) }
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (cfg.provider === "claude") {
      const claudeMessages = messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));
      reqBody = { model: cfg.model, system: systemPrompt, max_tokens: 4096, temperature: 0.7, messages: claudeMessages };
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(reqBody),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`claude ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    } else {
      throw new Error(`Unsupported provider: ${cfg.provider}`);
    }
    const logResData = cfg.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: cfg.provider, model: cfg.model, requestBody: reqBody, responseData: logResData, responseText: raw, timestamp, fn: fnName });
    return { text: raw, raw: resData };
  } catch (e) {
    console.error(`[ChatLLM:${fnName}] error:`, e);
    if (onLog) onLog({ provider: cfg.provider + " (error)", model: cfg.model, requestBody: reqBody, responseText: raw || e.message, error: true, timestamp, fn: fnName });
    throw e;
  }
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
    if (isOpenAICompatProvider(ACTIVE_LLM.provider)) {
      const apiUrl = openAICompatUrl(ACTIVE_LLM.provider);
      const headers = { "Content-Type": "application/json" };
      if (needsOpenAIAuthHeader(ACTIVE_LLM.provider)) headers.Authorization = `Bearer ${ACTIVE_LLM.key}`;
      const messages = [{ role: "system", content: systemContent }, ...chatMessages];
      reqBody = { model: ACTIVE_LLM.model, messages, max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`${ACTIVE_LLM.provider} ${res.status}: ${errText.slice(0, 300)}`);
      }
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
// Also closes a string truncated mid-value, then drops a trailing partial
// property ("key":) or trailing comma so the result is parseable.
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
  // Close an unterminated string (truncation cut off mid-value).
  if (inStr) result += '"';
  // Drop dangling "key": or "key" with no value, then any trailing comma/colon.
  result = result.trimEnd();
  result = result.replace(/,?\s*"[^"\\]*"\s*:\s*$/, '');
  result = result.replace(/[,:]\s*$/, '');
  while (stack.length > 0) result += stack.pop();
  return result;
}

// Strip ```json ... ``` fences. Tolerates a missing closing fence (response
// truncated mid-output) — without this, the leading ```json prefix poisons
// JSON.parse on every truncated LLM reply.
function stripCodeFence(text) {
  let out = text.trim();
  const open = out.match(/^```(?:json|JSON)?\s*\n?/);
  if (open) out = out.slice(open[0].length);
  const close = out.match(/\n?\s*```\s*$/);
  if (close) out = out.slice(0, out.length - close[0].length);
  return out.trim();
}

// Find the position right after the last fully-closed element inside the
// innermost open array. Used to pick a safe cut point for continuation: if we
// trim the partial response back to here, the model can resume by emitting
// "," + next array element without having to mid-string-resume.
// Returns -1 when there's no such position (e.g. response cuts off before any
// array element finished).
function findLastSafeArrayCutPoint(str) {
  let inStr = false, escape = false;
  const stack = [];
  let lastSafeCut = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length > 0 && stack[stack.length - 1] === '[') {
        lastSafeCut = i + 1;
      }
    }
  }
  return lastSafeCut;
}

// Best-effort continuation when finish_reason indicates truncation. Sends one
// follow-up call with the (trimmed) partial as a prior assistant turn and asks
// the model to resume. Only wired for openai/ollama since they're the
// providers most likely to truncate on small contexts; gemini/claude have
// larger output budgets in this codebase. Returns the merged cleaned text on
// success, or null if continuation isn't safe / fails / model refuses.
async function tryContinue(cfg, systemPrompt, userMessage, partialCleaned) {
  if (!isOpenAICompatProvider(cfg.provider)) return null;
  const cutPoint = findLastSafeArrayCutPoint(partialCleaned);
  if (cutPoint < 0) return null;
  const trimmed = partialCleaned.slice(0, cutPoint);
  const continuationMsg = `이전 응답이 토큰 한도로 잘렸습니다. 위 JSON을 그대로 이어서 완성해주세요.\n- 이미 출력된 내용은 절대 반복하지 말고 다음 항목부터만 출력\n- 동일한 JSON 형식 유지\n- 코드 펜스나 설명 텍스트 없이 JSON 일부 텍스트만 출력\n- ","로 시작해 다음 객체를 추가하거나, 배열을 닫는 "]"로 시작 가능`;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
    { role: "assistant", content: trimmed },
    { role: "user", content: continuationMsg },
  ];
  const url = openAICompatUrl(cfg.provider);
  const headers = { "Content-Type": "application/json" };
  let body;
  if (cfg.provider === "ollama") {
    body = { model: cfg.model, messages, temperature: 0.5, options: { num_ctx: 8192 } };
  } else if (cfg.provider === "lmstudio") {
    body = { model: cfg.model, messages, max_tokens: 4096, temperature: 0.5 };
  } else {
    headers.Authorization = `Bearer ${cfg.key}`;
    body = { model: cfg.model, messages, max_tokens: 4096, temperature: 0.5 };
  }
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json();
    const continuation = data.choices?.[0]?.message?.content ?? "";
    if (!continuation) return null;
    return trimmed + stripCodeFence(continuation);
  } catch {
    return null;
  }
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
    if (isOpenAICompatProvider(ACTIVE_LLM.provider)) {
      const apiUrl = openAICompatUrl(ACTIVE_LLM.provider);
      const headers = { "Content-Type": "application/json" };
      if (needsOpenAIAuthHeader(ACTIVE_LLM.provider)) headers.Authorization = `Bearer ${ACTIVE_LLM.key}`;
      const apiMsgs = [{ role: "system", content: DEST_SYSTEM_PROMPT }, ...messages];
      reqBody = { model: ACTIVE_LLM.model, messages: apiMsgs, max_tokens: 4096, temperature: 0.7 };
      // response_format support varies: OpenAI/Ollama accept "json_object",
      // LM Studio only accepts "json_schema" or "text" → omit and rely on the
      // system prompt + tryRepairJSON. num_ctx is Ollama-only.
      if (ACTIVE_LLM.provider !== "lmstudio") reqBody.response_format = { type: "json_object" };
      if (ACTIVE_LLM.provider === "ollama") reqBody.options = { num_ctx: 8192 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`${ACTIVE_LLM.provider} ${res.status}: ${errText.slice(0, 300)}`);
      }
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
    let cleaned = stripCodeFence(raw);
    const finishReason = resData?.choices?.[0]?.finish_reason ?? resData?.candidates?.[0]?.finishReason ?? resData?.stop_reason ?? null;
    const truncated = finishReason === "length" || finishReason === "MAX_TOKENS" || finishReason === "max_tokens";
    if (truncated) {
      const continued = await tryContinue({ provider: ACTIVE_LLM.provider, model: ACTIVE_LLM.model, key: ACTIVE_LLM.key }, DEST_SYSTEM_PROMPT, prefixed, cleaned);
      if (continued && continued.length > cleaned.length) cleaned = continued;
    }
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
      reqBody = { model: cfg.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }], max_tokens: 4096, temperature: 0.7, response_format: { type: "json_object" } };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`${cfg.provider} ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (cfg.provider === "ollama") {
      const apiUrl = openAICompatUrl(cfg.provider);
      const headers = { "Content-Type": "application/json" };
      const messages = [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }];
      // num_ctx raises the model's runtime context window above the 4k default
      // so itinerary outputs don't get truncated. Ollama's OpenAI-compat
      // endpoint forwards `options` straight to the runtime. response_format
      // forces JSON-only output (no prose/code-fence preamble) — Ollama maps
      // this to its `format: "json"` mode internally.
      const buildBody = (model) => ({ model, messages, temperature: 0.7, options: { num_ctx: 8192 }, response_format: { type: "json_object" } });

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
    } else if (cfg.provider === "lmstudio") {
      // LM Studio exposes the OpenAI Chat Completions wire format on
      // VITE_LMSTUDIO_URL (default http://localhost:1234). Differences vs
      // OpenAI/Ollama: rejects the `options` extension (Ollama-only) AND
      // rejects response_format.type="json_object" (only "json_schema"/"text"
      // are accepted). We rely on the system prompt + tryRepairJSON to keep
      // outputs JSON-shaped without the format hint.
      const apiUrl = openAICompatUrl(cfg.provider);
      const headers = { "Content-Type": "application/json" };
      reqBody = {
        model: cfg.model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
        max_tokens: 4096,
        temperature: 0.7,
      };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`lmstudio ${res.status}: ${errText.slice(0, 300)}`);
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
    let cleaned = stripCodeFence(raw);
    // Truncation detection across providers — finish_reason on openai/ollama,
    // finishReason on gemini, stop_reason on claude.
    const finishReason = resData?.choices?.[0]?.finish_reason ?? resData?.candidates?.[0]?.finishReason ?? resData?.stop_reason ?? null;
    const truncated = finishReason === "length" || finishReason === "MAX_TOKENS" || finishReason === "max_tokens";
    if (truncated) {
      const continued = await tryContinue(cfg, systemPrompt, userMessage, cleaned);
      if (continued && continued.length > cleaned.length) cleaned = continued;
    }
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
// Split into two parallel LLM calls (days + alternatives) so each output stays
// well under the model's context window. Combined output was hitting truncation
// on small local models (4k window). Alternatives don't reference specific
// spot IDs from the days, so they can be generated in parallel with shared
// trip context. If the alternatives call fails we still return the days.
export async function generateItinerary(country, city, tags, days, transportName, onLog) {
  const dayCount = parseTripDayCount(days);
  const tagStr = tags.length > 0 ? tags.join(", ") : "전체";
  const tripContext = `${country} ${city} ${dayCount - 1}박${dayCount}일 여행.\n선호 성향: ${tagStr}\n이동수단: ${transportName}`;
  const daysMsg = `${tripContext}\n${dayCount}일간의 완벽한 일정을 만들어줘.\n중요: days 배열은 DAY 1부터 DAY ${dayCount}까지 정확히 ${dayCount}개를 포함해야 하며, day 값은 누락 없이 연속이어야 한다.`;
  const altsMsg = `${tripContext}\n위 여행에 어울리는 대체 가능한 명소 3곳을 추천해줘.`;

  const [daysResult, altsResult] = await Promise.all([
    callGenericLLM(ITINERARY_PROMPT, daysMsg, onLog, "itinerary"),
    callGenericLLM(ALTERNATIVES_PROMPT, altsMsg, onLog, "alternatives").catch(() => null),
  ]);

  const merged = { ...(daysResult ?? {}), alternatives: Array.isArray(altsResult?.alternatives) ? altsResult.alternatives : [] };
  const normalized = normalizeItineraryResult(merged, dayCount);
  if (normalized?.days && normalized.days.length > 0) return normalized;
  return null;
}
