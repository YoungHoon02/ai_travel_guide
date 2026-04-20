import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleDirections } from "../api.js";

describe("fetchGoogleDirections", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    import.meta.env.VITE_GOOGLE_MAPS_API_KEY = "test-key";
  });

  it("builds TRANSIT request with departureTime, transitPreferences and transit field mask", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [{
          duration: "1800s",
          distanceMeters: 12000,
          legs: [{
            departureTime: "2026-04-20T09:00:00.000Z",
            arrivalTime: "2026-04-20T09:30:00.000Z",
            steps: [{
              travelMode: "TRANSIT",
              transitDetails: { transitLine: { color: { red: 66, green: 133, blue: 244 } } },
            }],
          }],
        }],
      }),
    });

    const result = await fetchGoogleDirections([35.68, 139.76], [35.69, 139.77], "TRANSIT", {
      departureTimeISO: "2026-04-20T09:00:00.000Z",
    });

    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(request.headers["X-Goog-FieldMask"]).toContain("routes.legs.steps.transitDetails.transitLine.color");
    expect(body.travelMode).toBe("TRANSIT");
    expect(body.departureTime).toBe("2026-04-20T09:00:00.000Z");
    expect(body.transitPreferences).toBeTruthy();
    expect(result.transitLineColor).toBe("#4285f4");
    expect(result.departureTimeISO).toBe("2026-04-20T09:00:00.000Z");
    expect(result.arrivalTimeISO).toBe("2026-04-20T09:30:00.000Z");
  });

  it("builds DRIVING request with routingPreference and no transitPreferences", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [{ duration: "900s", distanceMeters: 2000, legs: [{ steps: [] }] }],
      }),
    });

    await fetchGoogleDirections([35.68, 139.76], [35.69, 139.77], "DRIVING");

    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(request.headers["X-Goog-FieldMask"]).not.toContain("transitDetails");
    expect(body.travelMode).toBe("DRIVE");
    expect(body.routingPreference).toBe("TRAFFIC_AWARE_OPTIMAL");
    expect(body.transitPreferences).toBeUndefined();
  });
});
