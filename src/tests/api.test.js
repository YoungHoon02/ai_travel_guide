/**
 * Unit tests for transit-routing helpers in src/api.js.
 *
 * Covers:
 *  - fetchTransitSequential: time propagation, stayDuration, error-resilience
 *  - fetchScheduleDirections: TRANSIT sequential dispatch vs legacy parallel path
 *
 * fetch is stubbed via vi.stubGlobal so no real HTTP traffic occurs.
 * VITE_GOOGLE_MAPS_API_KEY is stubbed via vi.stubEnv.
 *
 * NOTE: fetchTransitSequential calls fetchRoutesApiDirections directly
 * (internal function) so it always uses the Routes API v2 regardless of
 * the VITE_PREFER_ROUTES_API env setting. This is by design — sequential
 * transit routing requires Routes API v2 departureTime chaining.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTransitSequential, fetchScheduleDirections } from "../api.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal successful Routes API v2 TRANSIT response.
 * Matches the format expected by fetchRoutesApiDirections.
 */
function makeTransitRouteResponse({ durationSecs = 1800, distanceMeters = 5000 } = {}) {
  return {
    routes: [
      {
        duration: `${durationSecs}s`,
        distanceMeters,
        polyline: { encodedPolyline: "" },
        legs: [
          {
            steps: [
              {
                travelMode: "TRANSIT",
                staticDuration: `${durationSecs}s`,
                distanceMeters,
                transitDetails: {
                  transitLine: {
                    name: "긴자선",
                    nameShort: "G",
                    vehicle: { type: "SUBWAY", name: "지하철" },
                  },
                  headsign: "아사쿠사",
                  stopCount: 4,
                  stopDetails: {
                    departureStop: { name: "시부야" },
                    arrivalStop: { name: "아사쿠사" },
                  },
                },
              },
            ],
          },
        ],
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
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-api-key");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ─── fetchTransitSequential — input validation ─────────────────────────────────

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

// ─── fetchTransitSequential — basic two-stop journey ──────────────────────────

describe("fetchTransitSequential — basic two-stop journey", () => {
  it("returns one leg result for two stops", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800 }))));

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
    expect(result[0].durationSecs).toBe(1800);
    expect(result[0].error).toBeNull();
  });

  it("populates transitSummary from line short name", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse())));

    const places = [
      { latlng: [35.7, 139.7], name: "A역" },
      { latlng: [35.6, 139.8], name: "B역" },
    ];
    const [leg] = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    // transitSummary is built from the line short name ("G")
    expect(leg.transitSummary).toBe("G");
  });

  it("includes duration and distance strings", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800, distanceMeters: 5000 }))));

    const [leg] = await fetchTransitSequential(
      [{ latlng: [35.7, 139.7], name: "A" }, { latlng: [35.6, 139.8], name: "B" }],
      "2024-03-15T09:00:00Z"
    );
    expect(leg.duration).toBe("30분");
    expect(leg.distance).toBe("5.0 km");
  });
});

// ─── fetchTransitSequential — stayDuration time propagation ──────────────────

describe("fetchTransitSequential — stayDuration time propagation", () => {
  it("adds stayDuration to travel time for the next leg departure", async () => {
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 1800 })))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 3600 })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B역", stayDuration: 60 }, // 60 min stay at B
      { latlng: [35.5, 139.9], name: "C역", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    // Leg 1: departs at initial time
    expect(result[0].departureTime).toBe("2024-03-15T09:00:00Z");
    // Leg 2 departure = 09:00 + 1800s travel + 60min stay = 09:00 + 30m + 60m = 10:30
    const expectedDep2Ms =
      new Date("2024-03-15T09:00:00Z").getTime() + 1800 * 1000 + 60 * 60 * 1000;
    expect(new Date(result[1].departureTime).getTime()).toBe(expectedDep2Ms);
  });

  it("zero stayDuration: next leg departs exactly durationSecs after current departure", async () => {
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 2700 })))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 600 })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 0 },
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    const expectedDep2Ms = new Date("2024-03-15T09:00:00Z").getTime() + 2700 * 1000;
    expect(new Date(result[1].departureTime).getTime()).toBe(expectedDep2Ms);
  });

  it("advances only by stayDuration when route lookup fails (no durationSecs)", async () => {
    // fetchRoutesApiDirections tries up to 3 request variants per leg call.
    // Provide 3 empty-route responses to fail all variants of leg 1.
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 1
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 2
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 3
      .mockReturnValue(jsonResponse(makeTransitRouteResponse({ durationSecs: 600 }))); // leg 2
    vi.stubGlobal("fetch", fetchMock);

    // stayDuration is the time spent at the destination (to) before the next leg.
    // When A→B fails, advance by B's stayDuration (places[1].stayDuration).
    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 30 }, // 30 min stay at B
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    // Leg 1 failed → no durationSecs; advance only by B's stayDuration (30m)
    const expectedDep2Ms = new Date("2024-03-15T09:00:00Z").getTime() + 30 * 60 * 1000;
    expect(new Date(result[1].departureTime).getTime()).toBe(expectedDep2Ms);
  });
});

// ─── fetchTransitSequential — error handling ──────────────────────────────────

describe("fetchTransitSequential — error handling", () => {
  it("continues to the next leg when one segment returns no route", async () => {
    // fetchRoutesApiDirections tries up to 3 request variants per leg call.
    // Provide 3 empty-route responses to fail all variants of leg 1, then succeed for leg 2.
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 1
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 2
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 3
      .mockReturnValue(jsonResponse(makeTransitRouteResponse({ durationSecs: 1800 }))); // leg 2
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 0 },
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    expect(result[0].error).toBeTruthy();
    expect(result[1].error).toBeNull();
    expect(result[1].durationSecs).toBe(1800);
  });

  it("records the error message and sets null fields on a failed segment", async () => {
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
    expect(leg.transitSummary).toBeNull();
    expect(leg.trafficSegments).toEqual([]);
  });

  it("handles network errors (fetch throws) without stopping the chain", async () => {
    // fetchRoutesApiDirections catches all fetch errors internally and returns null.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("네트워크 오류"))
      .mockReturnValueOnce(jsonResponse(makeTransitRouteResponse({ durationSecs: 600 })));
    vi.stubGlobal("fetch", fetchMock);

    const places = [
      { latlng: [35.7, 139.7], name: "A", stayDuration: 0 },
      { latlng: [35.6, 139.8], name: "B", stayDuration: 0 },
      { latlng: [35.5, 139.9], name: "C", stayDuration: 0 },
    ];
    const result = await fetchTransitSequential(places, "2024-03-15T09:00:00Z");

    expect(result).toHaveLength(2);
    // First segment fails (fetch error swallowed internally → dir=null → error message set)
    expect(result[0].error).toBeTruthy();
    // Second segment still executed and succeeded
    expect(result[1].error).toBeNull();
    expect(result[1].durationSecs).toBe(600);
  });
});

// ─── fetchTransitSequential — leg index and name fields ──────────────────────

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
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse())));

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

// ─── fetchScheduleDirections — TRANSIT sequential dispatch ───────────────────

describe("fetchScheduleDirections — TRANSIT mode with initialDepartureTime", () => {
  it("makes sequential API calls (one per leg) when initialDepartureTime is given", async () => {
    const fetchMock = vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800 })));
    vi.stubGlobal("fetch", fetchMock);

    const schedule = [
      { id: "a", latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { id: "b", latlng: [35.6, 139.8], name: "B역", stayDuration: 30 },
      { id: "c", latlng: [35.5, 139.9], name: "C역", stayDuration: 0 },
    ];
    const results = await fetchScheduleDirections(schedule, "public", {
      initialDepartureTime: "2024-03-15T09:00:00Z",
    });

    // Two legs → at least two fetch calls (may be more due to variant probing in fetchRoutesApiDirections)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(results).toHaveLength(2);
    expect(results[0].fromId).toBe("a");
    expect(results[0].toId).toBe("b");
    expect(results[1].fromId).toBe("b");
    expect(results[1].toId).toBe("c");
  });

  it("includes departureTime and travelModeRequested in results", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeTransitRouteResponse({ durationSecs: 1800 }))));

    const schedule = [
      { id: "a", latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { id: "b", latlng: [35.6, 139.8], name: "B역", stayDuration: 0 },
    ];
    const [leg] = await fetchScheduleDirections(schedule, "public", {
      initialDepartureTime: "2024-03-15T09:00:00Z",
    });

    expect(leg.departureTime).toBe("2024-03-15T09:00:00Z");
    expect(leg.travelModeRequested).toBe("TRANSIT");
  });

  it("reports per-segment errors without aborting the chain", async () => {
    // fetchRoutesApiDirections tries up to 3 request variants per leg call.
    // Provide 3 empty-route responses to fail all variants of leg 1, then succeed for leg 2.
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 1
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 2
      .mockReturnValueOnce(jsonResponse({ routes: [] })) // leg 1, variant 3
      .mockReturnValue(jsonResponse(makeTransitRouteResponse({ durationSecs: 600 }))); // leg 2
    vi.stubGlobal("fetch", fetchMock);

    const schedule = [
      { id: "a", latlng: [35.7, 139.7], name: "A역", stayDuration: 0 },
      { id: "b", latlng: [35.6, 139.8], name: "B역", stayDuration: 0 },
      { id: "c", latlng: [35.5, 139.9], name: "C역", stayDuration: 0 },
    ];
    const results = await fetchScheduleDirections(schedule, "public", {
      initialDepartureTime: "2024-03-15T09:00:00Z",
    });

    expect(results).toHaveLength(2);
    expect(results[0].error).toBeTruthy();
    expect(results[1].error).toBeNull();
  });
});

describe("fetchScheduleDirections — edge cases", () => {
  it("returns empty array when schedule has fewer than 2 items (TRANSIT)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchScheduleDirections(
      [{ id: "a", latlng: [35.7, 139.7], name: "A" }],
      "public",
      { initialDepartureTime: "2024-03-15T09:00:00Z" }
    );
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty array when schedule has fewer than 2 items (non-TRANSIT)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchScheduleDirections([{ id: "a", latlng: [35.7, 139.7], name: "A" }], "car");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty array when no API key is set", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "");
    const result = await fetchScheduleDirections(
      [
        { id: "a", latlng: [35.7, 139.7], name: "A" },
        { id: "b", latlng: [35.6, 139.8], name: "B" },
      ],
      "public",
      { initialDepartureTime: "2024-03-15T09:00:00Z" }
    );
    expect(result).toEqual([]);
  });
});
