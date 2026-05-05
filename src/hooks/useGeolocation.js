import { useState, useEffect, useRef, useCallback } from "react";

const THROTTLE_MS = 30_000;    // 최소 30초 간격
const ACCURACY_THRESHOLD_M = 100; // 100m 이상 불확실이면 무시

/**
 * Continuous GPS tracking via `navigator.geolocation.watchPosition`.
 *
 * Returns:
 *   position: { lat, lng, accuracyM } | null
 *   error: string | null          — "denied" | "unavailable" | "timeout" | null
 *   isTracking: boolean
 *   startTracking: () => void     — call on user gesture (permission prompt timing)
 *   stopTracking: () => void
 *
 * Throttles updates to at most once per THROTTLE_MS to avoid excessive
 * re-renders. Silently ignores readings with accuracy > ACCURACY_THRESHOLD_M.
 * Falls back gracefully when geolocation is unavailable or denied.
 */
export function useGeolocation() {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const watchIdRef = useRef(null);
  const lastUpdateRef = useRef(0);

  const stopTracking = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation?.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setIsTracking(false);
  }, []);

  const startTracking = useCallback(() => {
    if (!navigator.geolocation) {
      setError("unavailable");
      return;
    }
    if (watchIdRef.current !== null) return; // already watching

    setError(null);
    setIsTracking(true);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastUpdateRef.current < THROTTLE_MS) return;
        if (pos.coords.accuracy > ACCURACY_THRESHOLD_M) return;
        lastUpdateRef.current = now;
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Math.round(pos.coords.accuracy),
        });
      },
      (err) => {
        if (err.code === 1) setError("denied");
        else if (err.code === 2) setError("unavailable");
        else setError("timeout");
        stopTracking();
      },
      {
        enableHighAccuracy: true,
        maximumAge: THROTTLE_MS,
        timeout: 15_000,
      }
    );
  }, [stopTracking]);

  // Auto-cleanup on unmount.
  useEffect(() => () => stopTracking(), [stopTracking]);

  return { position, error, isTracking, startTracking, stopTracking };
}
