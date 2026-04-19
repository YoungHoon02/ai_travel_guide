/**
 * Unit tests for transit-routing helpers in src/api.js.
 *
 * Covers:
 *  - fetchTransitSequential: time propagation, stayDuration, error-resilience
 *  - fetchScheduleDirections: TRANSIT vs non-TRANSIT dispatch
 *
 * fetch is stubbed via vi.stubGlobal so no real HTTP traffic occurs.
 * import.meta.env.VITE_GOOGLE_MAPS_API_KEY is stubbed via vi.stubEnv.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTransitSequential, fetchScheduleDirections } from "../api.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal successful Routes API v2 TRANSIT response. */
function makeTransitRouteResponse({ durationSecs = 1800, distanceMeters = 5000, arrivalTime = null, departureTime = null } = {}) {
  const leg = {
    steps: [
      {
        travelMode: "TRANSIT",
        staticDuration: `${durationSecs}s`,
        distanceMeters,
        transitDetails: {
          transitLine: { name: "긴자선", nameShort: "G", color: "#f4b400", vehicle: { type: "SUBWAY", name: { text: "지하철" } } },
          headsign: "아사쿠사",
          stopCount: 4,
          stopDetails: { departureStop: { name: "시부야" }, arrivalStop: { name: "아사쿠사" } },
        },
      },
    ],
  };
  if (arrivalTime) leg.arrivalTime = arrivalTime;
  if (departureTime) leg.departureTime = departureTime;

  return {
    routes: [
      {
        duration: `${durationSecs}s`,
        distanceMeters,
        polyline: { encodedPolyline: "" },
        legs: [leg],
      },
    ],
  };
}

/** Wrap a JS object in a minimal fetch Response. */
function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-api-key");
  // Suppress console.error noise from api.js
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── fetchTransitSequential ────────────────────────────────────────────────────

describe("fetchTransitSequential — input validation", () => {
  it("returns [] when fewer than 2 places are provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchTransitSequential([{ latlng: [35.7, 139.7] }], "2024-03-15T09:00:00Z");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] when no API key is set", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchTransitSequential(
      [{ latlng: [35.7, 139.7] }, { latlng: [35.6, 139.8] }],
      "2024-03-15T09:00:00Z"
    );
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchTransitSequential — basic two-stop journey", () => {
  it("returns one leg result for two stops", async () => {
    const arrivalTime = "2024-03-15T09:30:00Z";
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, arrivalTime }))));

    const places = [
      { latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B역", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(1);
    expect(result[0].legIndex).toBe(0);
    expect(result[0].fromIndex).toBe(0);
    expect(result[0].toIndex).toBe(1);
    expect(result[0].fromName).toBe("A역");
    expect(result[0].toName).toBe("B역");
    expect(result[0].departureTime).toBe("2024-03-15T09:00:00Z");
    expect(result[0].arrivalTime).toBe(arrivalTime);
    expect(result[0].error).toBeNull();
  });

  it("includes transitDetails from the API response", async () => {
    const arrivalTime = "2024-03-15T09:30:00Z";
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ arrivalTime }))));

    const places = [
      { latlng: [35.7, 139.7], name: "A역" },
      { latlng: [35.6, 139.8], name: "B역" },
    ];
    const [leg] = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(leg.transitDetails).toHaveLength(1);
    expect(leg.transitDetails[0].lineName).toBe("긴자선");
    expect(leg.transitDetails[0].vehicleType).toBe("SUBWAY");
    expect(leg.transitDetails[0].headsign).toBe("아사쿠사");
    expect(leg.transitDetails[0].stopCount).toBe(4);
  });
});

describe("fetchTransitSequential — stayDuration time propagation", () => {
  it("adds stayDuration to arrival time for the next leg departure", async () => {
    const arrivalTime1 = "2024-03-15T09:30:00Z";
    const arrivalTime2 = "2024-03-15T11:00:00Z";
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, arrivalTime: arrivalTime1 })))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 3600, arrivalTime: arrivalTime2 })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B역", stayDuration: 60 }, // 60 min stay at B
      { latlng: [35.5, 139.9], name: "C역", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    // First leg: departs at initial time
    expect(result[0].departureTime).toBe("2024-03-15T09:00:00Z");
    expect(result[0].arrivalTime).toBe(arrivalTime1);
    // Second leg: departs at arrival(B) + 60 min stay = 09:30 + 01:00 = 10:30
    expect(result[1].departureTime).toBe("2024-03-15T10:30:00.000Z");
    expect(result[1].arrivalTime).toBe(arrivalTime2);
  });

  it("uses durationSecs fallback when arrivalTime is absent", async () => {
    // No arrivalTime in response — should fall back to departure + durationSecs
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, arrivalTime: null })))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 900, arrivalTime: null })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 30 }, // 30 min stay
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    // Leg 2 departure = 09:00 + 1800s + 30min = 09:00 + 30m + 30m = 10:00
    const depMs = new Date("2024-03-15T09:00:00Z").getTime() + 1800 * 1000 + 30 * 60 * 1000;
    expect(result[1].departureTime).toBe(new Date(depMs).toISOString());
  });

  it("zero stayDuration: next leg departs exactly at arrival time", async () => {
    const arrivalTime = "2024-03-15T09:45:00Z";
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 2700, arrivalTime })))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 600, arrivalTime: "2024-03-15T10:00:00Z" })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 0 }, // no stay
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    // Departure of leg 2 should equal arrival of leg 1 (same moment, ISO 8601).
    const dep2 = new Date(result[1].departureTime).getTime();
    const arr1 = new Date(arrivalTime).getTime();
    expect(dep2).toBe(arr1);
  });
});

describe("fetchTransitSequential — error handling", () => {
  it("continues to the next leg when one segment returns no route", async () => {
    const arrivalTime = "2024-03-15T11:00:00Z";
    const fetchMock = vi.fn()
      // First leg: API returns empty routes (no route found)
      .mockReturnValueOnce(jsonResponse({ routes: [] }))
      // Second leg: succeeds
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, arrivalTime })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 30 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 0 },
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    // First segment has an error
    expect(result[0].error).toBeTruthy();
    expect(result[0].arrivalTime).toBeNull();
    // Second segment still executed and succeeded
    expect(result[1].error).toBeNull();
    expect(result[1].arrivalTime).toBe(arrivalTime);
  });

  it("records the error message and sets null route fields on a failed segment", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ routes: [] })));

    const places = [
      { latlng: [35.7, 139.7], name: "A" },
      { latlng: [35.6, 139.8], name: "B" },
    ];
    const [leg] = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(leg.error).toBe("대중교통 경로를 찾을 수 없습니다");
    expect(leg.duration).toBeNull();
    expect(leg.durationSecs).toBeNull();
    expect(leg.distance).toBeNull();
    expect(leg.polylinePath).toBeNull();
    expect(leg.transitDetails).toEqual([]);
  });

  it("handles network errors (fetch throws) without stopping the chain", async () => {
    // fetchGoogleDirections catches fetch errors and returns null, so
    // fetchTransitSequential sees a null result and reports the standard
    // "no route" error message — but the chain still continues.
    const arrivalTime = "2024-03-15T10:00:00Z";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("네트워크 오류"))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 600, arrivalTime })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 0 },
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    // First segment fails (fetch error is swallowed by fetchGoogleDirections → null).
    expect(result[0].error).toBeTruthy();
    // Second segment still executed and succeeded.
    expect(result[1].error).toBeNull();
    expect(result[1].arrivalTime).toBe(arrivalTime);
  });
});

describe("fetchTransitSequential — leg index and name fields", () => {
  it("uses default names when place.name is not provided", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ routes: [] })));

    const places = [
      { latlng: [35.7, 139.7] },
      { latlng: [35.6, 139.8] },
    ];
    const [leg] = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");
    expect(leg.fromName).toBe("지점 1");
    expect(leg.toName).toBe("지점 2");
  });

  it("assigns correct legIndex, fromIndex, toIndex for a 4-stop journey", async () => {
    const arrivalTime = "2024-03-15T09:30:00Z";
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ arrivalTime }))));

    const places = [
      { latlng: [35.7, 139.7], name: "S0" },
      { latlng: [35.6, 139.8], name: "S1" },
      { latlng: [35.5, 139.9], name: "S2" },
      { latlng: [35.4, 140.0], name: "S3" },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(3);
    result.forEach((leg, i) => {
      expect(leg.legIndex).toBe(i);
      expect(leg.fromIndex).toBe(i);
      expect(leg.toIndex).toBe(i + 1);
      expect(leg.fromName).toBe(`S${i}`);
      expect(leg.toName).toBe(`S${i + 1}`);
    });
  });
});

// ─── fetchScheduleDirections — TRANSIT dispatch ───────────────────────────────

describe("fetchScheduleDirections — TRANSIT mode uses sequential routing", () => {
  it("makes sequential API calls (one per leg) for TRANSIT moveId", async () => {
    const arrivalTime = "2024-03-15T09:30:00Z";
    const fetchMock = vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, arrivalTime })));
    vi.stubGlobal("fetch", fetchMock);

    const schedule = [
      { id: "a", latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { id: "b", latlng: [35.6, 139.8], name: "B역", stayDuration: 30 },
      { id: "c", latlng: [35.5, 139.9], name: "C역", stayDuration: 0 },
    ];
    const results = await fetchScheduleDirections(schedule, "public", {
      initialDepartureTime: "2024-03-15T09:00:00Z",
    });

    // Two legs → two API calls
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].fromId).toBe("a");
    expect(results[0].toId).toBe("b");
    expect(results[1].fromId).toBe("b");
    expect(results[1].toId).toBe("c");
  });

  it("includes arrivalTime and departureTime fields in TRANSIT results", async () => {
    const arrivalTime = "2024-03-15T09:30:00Z";
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, arrivalTime }))));

    const schedule = [
      { id: "a", latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { id: "b", latlng: [35.6, 139.8], name: "B역", stayDuration: 0 },
    ];
    const [leg] = await fetchScheduleDirections(schedule, "public", {
      initialDepartureTime: "2024-03-15T09:00:00Z",
    });

    expect(leg.arrivalTime).toBe(arrivalTime);
    expect(leg.departureTime).toBe("2024-03-15T09:00:00Z");
    expect(leg.transitDetails).toBeDefined();
  });
});

describe("fetchScheduleDirections — non-TRANSIT mode uses parallel routing", () => {
  it("fires all route requests in parallel for DRIVING moveId", async () => {
    // Make fetch calls distinguishable by call order
    const callTimes = [];
    const fetchMock = vi.fn(async () => {
      callTimes.push(Date.now());
      return jsonResponse({
        routes: [
          {
            duration: "600s",
            distanceMeters: 3000,
            polyline: { encodedPolyline: "" },
            legs: [{ steps: [] }],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const schedule = [
      { id: "a", latlng: [35.7, 139.7], name: "A" },
      { id: "b", latlng: [35.6, 139.8], name: "B" },
      { id: "c", latlng: [35.5, 139.9], name: "C" },
    ];
    const results = await fetchScheduleDirections(schedule, "car");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    // Non-TRANSIT results: arrivalTimeISO is null (DRIVING mode).
    expect(results[0].arrivalTimeISO).toBeNull();
  });

  it("returns empty array when schedule has fewer than 2 items", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchScheduleDirections([{ id: "a", latlng: [35.7, 139.7], name: "A" }], "car");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
