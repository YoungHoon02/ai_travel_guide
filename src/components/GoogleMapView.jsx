import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Declarative Google Maps component.
 *
 * Works with the globally-loaded `google.maps` script (loaded once from App.jsx).
 * No additional React wrapper library — uses raw Google Maps JS API via refs.
 *
 * Props:
 *   center:             [lat, lng]  — map center
 *   zoom:               number      — initial zoom (default 13)
 *   markers:            [{ id, lat, lng, title, icon, label }]  — pins
 *   polylinePositions:  [[lat, lng], ...]   — connecting line between points
 *   polylineOptions:    { color, weight, dashed }  — line styling
 *   onMarkerClick:      (id) => void  — pin click callback
 *   fitBounds:          boolean — auto-fit to markers (default true when 2+)
 *   className:          extra CSS class
 */

// ─── Map ID (required for AdvancedMarkerElement) ─────────────────────────────
// If user mapId is not configured, use Google's demo map id so we can still
// avoid deprecated google.maps.Marker in local/dev environments.
const GOOGLE_MAPS_MAP_ID = import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

// ─── Custom SVG pin factories ────────────────────────────────────────────
// Markers carry an optional `pin: { kind, color, number }` spec which this
// component turns into a Google Maps icon. Keeps generation inside the view
// so parent code doesn't have to touch window.google.maps primitives.

function buildNumberedPinSvg(number, color = "#ffd23f") {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">` +
    `<defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.55"/>` +
    `</filter></defs>` +
    `<path d="M20 0 C9 0 0 9 0 20 C0 34 20 50 20 50 C20 50 40 34 40 20 C40 9 31 0 20 0 Z" ` +
    `fill="${color}" stroke="#0f0f12" stroke-width="2.5" filter="url(#sh)"/>` +
    `<circle cx="20" cy="19" r="13" fill="#0f0f12"/>` +
    `<text x="20" y="25" text-anchor="middle" fill="${color}" ` +
    `font-family="-apple-system,system-ui,sans-serif" font-size="16" font-weight="900">${number}</text>` +
    `</svg>`
  );
}

function buildHotelPinSvg(color = "#ffa33a") {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="54" viewBox="0 0 44 54">` +
    `<defs><filter id="sh2" x="-30%" y="-30%" width="160%" height="160%">` +
    `<feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000" flood-opacity="0.6"/>` +
    `</filter></defs>` +
    `<path d="M22 0 C10 0 0 10 0 22 C0 37 22 54 22 54 C22 54 44 37 44 22 C44 10 34 0 22 0 Z" ` +
    `fill="${color}" stroke="#0f0f12" stroke-width="3" filter="url(#sh2)"/>` +
    `<circle cx="22" cy="21" r="14" fill="#0f0f12"/>` +
    `<text x="22" y="28" text-anchor="middle" font-size="18">🏨</text>` +
    `</svg>`
  );
}

// DOM element content for AdvancedMarkerElement (used when GOOGLE_MAPS_MAP_ID is set)
function buildSvgImgElement(svgString, width, height) {
  const img = document.createElement("img");
  img.src = "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svgString);
  img.style.width = width + "px";
  img.style.height = height + "px";
  img.style.display = "block";
  return img;
}

function resolveAdvancedMarkerContent(pin, label) {
  if (pin?.kind === "number" && pin?.number != null) {
    return buildSvgImgElement(buildNumberedPinSvg(pin.number, pin.color), 40, 50);
  }
  if (pin?.kind === "hotel") {
    return buildSvgImgElement(buildHotelPinSvg(pin.color), 44, 54);
  }
  // No custom icon — use PinElement with an optional label glyph
  if (label != null && window.google?.maps?.marker?.PinElement) {
    const labelText = typeof label === "object" ? label?.text ?? "" : String(label ?? "");
    if (labelText) {
      const pinEl = new window.google.maps.marker.PinElement({
        glyph: labelText,
        background: "#ffd23f",
        borderColor: "#0f0f12",
        glyphColor: "#0f0f12",
      });
      return pinEl.element;
    }
  }
  return null; // default Google pin
}

function detachMapOverlay(overlay) {
  if (!overlay) return;
  if (typeof overlay.setMap === "function") {
    overlay.setMap(null);
    return;
  }
  if ("map" in overlay) {
    overlay.map = null;
  }
}

// Dark-mode styles matching the MGS cyber theme of the rest of the app
const DARK_MAP_STYLES = [
  { elementType: "geometry", stylers: [{ color: "#0f0f12" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0f0f12" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#5a5a68" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#bdbdc6" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1a2a1e" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b9a76" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#1e1e24" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#2a2a30" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#5ecfcf" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#2a2a30" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#e8a020" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#16161c" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#e8a020" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0a1a1e" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#3a8888" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#0a1a1e" }] },
];

export default function GoogleMapView({
  center = [35.68, 139.77],
  zoom = 13,
  markers = [],
  polylineSegments = [],
  polylinePositions = [],
  polylineOptions,
  onMarkerClick,
  fitBounds = true,
  className = "",
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRefs = useRef([]);
  const polylineRefs = useRef([]);
  // Hold latest click handler in a ref so marker effect doesn't refire when
  // the parent passes a fresh inline callback every render.
  const onMarkerClickRef = useRef(onMarkerClick);
  useEffect(() => { onMarkerClickRef.current = onMarkerClick; }, [onMarkerClick]);
  const [ready, setReady] = useState(
    typeof window !== "undefined" && Boolean(window.google?.maps)
  );

  // Wait for google.maps script load
  useEffect(() => {
    if (ready) return;
    const handler = () => setReady(true);
    window.addEventListener("googlemapsloaded", handler, { once: true });
    // Also poll once in case event already fired
    const t = setTimeout(() => {
      if (window.google?.maps) setReady(true);
    }, 100);
    return () => {
      window.removeEventListener("googlemapsloaded", handler);
      clearTimeout(t);
    };
  }, [ready]);

  // Init map once google.maps is ready and DOM is mounted
  useEffect(() => {
    if (!ready || !containerRef.current || mapRef.current) return;
    mapRef.current = new window.google.maps.Map(containerRef.current, {
      center: { lat: center[0], lng: center[1] },
      zoom,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControl: true,
      clickableIcons: false,
      // Advanced markers require a mapId. Use user-provided mapId when set,
      // otherwise DEMO_MAP_ID in development.
      mapId: GOOGLE_MAPS_MAP_ID,
      ...(GOOGLE_MAPS_MAP_ID ? {} : { styles: DARK_MAP_STYLES }),
      backgroundColor: "#0f0f12",
      gestureHandling: "greedy",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Update center when it changes
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.setCenter({ lat: center[0], lng: center[1] });
  }, [center?.[0], center?.[1]]);

  // Content hash of markers — ignores reference identity so the effect only
  // refires when the actual pin set changes. Prevents fitBounds from yanking
  // the camera back every time the parent re-renders (e.g. pan/zoom focus bug).
  const markersKey = useMemo(
    () =>
      markers
        .map(
          (m) =>
            `${m.id}@${m.lat},${m.lng}|${m.title ?? ""}|${typeof m.label === "object" ? m.label?.text : m.label ?? ""}|${
              m.pin ? `${m.pin.kind}:${m.pin.number ?? ""}:${m.pin.color ?? ""}` : ""
            }`
        )
        .join("~"),
    [markers]
  );

  // Update markers
  useEffect(() => {
    if (!mapRef.current) return;
    markerRefs.current.forEach((m) => detachMapOverlay(m));
    markerRefs.current = [];
    if (markers.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    const useAdvanced = Boolean(window.google?.maps?.marker?.AdvancedMarkerElement);
    if (!useAdvanced) return;
    markers.forEach((m) => {
      const content = resolveAdvancedMarkerContent(m.pin, m.label);
      const marker = new window.google.maps.marker.AdvancedMarkerElement({
        position: { lat: m.lat, lng: m.lng },
        map: mapRef.current,
        title: m.title,
        ...(content ? { content } : {}),
        zIndex: m.pin?.kind === "hotel" ? 1000 : undefined,
      });
      marker.addListener("gmp-click", () => {
        onMarkerClickRef.current?.(m.id);
      });
      markerRefs.current.push(marker);
      bounds.extend({ lat: m.lat, lng: m.lng });
    });
    if (fitBounds && markers.length >= 2) {
      mapRef.current.fitBounds(bounds, { top: 64, right: 64, bottom: 64, left: 64 });
    } else if (markers.length === 1) {
      mapRef.current.setCenter({ lat: markers[0].lat, lng: markers[0].lng });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markersKey, fitBounds]);

  // Content hash of polyline positions + style — same reasoning as markersKey.
  const polylineKey = useMemo(
    () => polylinePositions.map((p) => `${p[0]},${p[1]}`).join("|") + `#${polylineOptions?.color ?? ""}/${polylineOptions?.weight ?? ""}/${polylineOptions?.dashed ?? ""}`,
    [polylinePositions, polylineOptions]
  );

  const polylineSegmentsKey = useMemo(
    () =>
      polylineSegments
        .map((seg) => {
          const pathKey = (seg.positions ?? []).map((p) => `${p[0]},${p[1]}`).join("|");
          return `${pathKey}#${seg.color ?? ""}/${seg.weight ?? ""}/${seg.opacity ?? ""}/${seg.dashed ?? ""}`;
        })
        .join("~"),
    [polylineSegments]
  );

  // Update polyline
  useEffect(() => {
    if (!mapRef.current) return;
    polylineRefs.current.forEach((line) => line.setMap(null));
    polylineRefs.current = [];

    if (polylineSegments.length > 0) {
      polylineRefs.current = polylineSegments
        .filter((seg) => Array.isArray(seg.positions) && seg.positions.length >= 2)
        .map((seg) => {
          const color = seg.color ?? polylineOptions?.color ?? "#5ecfcf";
          const dashed = Boolean(seg.dashed);
          return new window.google.maps.Polyline({
            path: seg.positions.map(([lat, lng]) => ({ lat, lng })),
            strokeColor: color,
            strokeOpacity: dashed ? 0 : (seg.opacity ?? 0.9),
            strokeWeight: seg.weight ?? polylineOptions?.weight ?? 5,
            icons: dashed
              ? [
                  {
                    icon: {
                      path: "M 0,-1 0,1",
                      strokeOpacity: 1,
                      scale: 3,
                      strokeColor: color,
                    },
                    offset: "0",
                    repeat: "12px",
                  },
                ]
              : undefined,
            map: mapRef.current,
          });
        });
      return;
    }

    if (polylinePositions.length < 2) return;
    const color = polylineOptions?.color ?? "#5ecfcf";
    const dashed = polylineOptions?.dashed !== false;
    polylineRefs.current = [
      new window.google.maps.Polyline({
        path: polylinePositions.map(([lat, lng]) => ({ lat, lng })),
        strokeColor: color,
        strokeOpacity: dashed ? 0 : 0.85,
        strokeWeight: polylineOptions?.weight ?? 3,
        icons: dashed
          ? [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: 1,
                  scale: 3,
                  strokeColor: color,
                },
                offset: "0",
                repeat: "12px",
              },
            ]
          : undefined,
        map: mapRef.current,
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polylineKey, polylineSegmentsKey]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      markerRefs.current.forEach((m) => detachMapOverlay(m));
      markerRefs.current = [];
      polylineRefs.current.forEach((line) => detachMapOverlay(line));
      polylineRefs.current = [];
    };
  }, []);

  return (
    <div ref={containerRef} className={`gmap-view ${className}`.trim()}>
      {!ready && (
        <div className="gmap-view__loading">
          <span className="var-chat__dots"><span /><span /><span /></span>
          <span>Google Maps 로드 중…</span>
        </div>
      )}
    </div>
  );
}
