import { useEffect, useRef, useState, useCallback } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";

// ─── Matrix scramble effect ──────────────────────────────────────────────────
function ScrambleText({ text, duration = 3000 }) {
  const [display, setDisplay] = useState(text || "");
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.°+-";

  useEffect(() => {
    if (!text) { setDisplay(""); return; }

    const target = text;
    const len = target.length;
    const perChar = duration / len;
    let locked = 0;
    let alive = true;
    const arr = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]);

    const scrambleId = setInterval(() => {
      if (!alive) return;
      for (let i = locked; i < len; i++) arr[i] = chars[Math.floor(Math.random() * chars.length)];
      setDisplay(arr.join(""));
    }, 40);

    const lockId = setInterval(() => {
      if (!alive) return;
      if (locked >= len) {
        clearInterval(scrambleId);
        clearInterval(lockId);
        setDisplay(target);
        return;
      }
      arr[locked] = target[locked];
      locked++;
    }, perChar);

    return () => { alive = false; clearInterval(scrambleId); clearInterval(lockId); };
  }, [text, duration]);

  return <span className="scramble-text">{display}</span>;
}

// ─── GTA5 staged zoom ────────────────────────────────────────────────────────
function ZoomController({ center, targetZoom }) {
  const map = useMap();
  const isFirstRef = useRef(true);
  const prevCenterRef = useRef(null);
  const abortRef = useRef(null);

  const sleep = useCallback((ms, signal) => {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(id); resolve(); });
    });
  }, []);

  const flash = useCallback(() => {
    try {
      const el = document.createElement("div");
      el.className = "map-zoom-flash";
      map.getContainer().appendChild(el);
      setTimeout(() => el.remove(), 500);
    } catch {}
  }, [map]);

  useEffect(() => {
    if (!center) return;
    const key = `${center[0]},${center[1]}`;
    if (key === prevCenterRef.current) return;
    prevCenterRef.current = key;

    // Abort previous animation
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    const isFirst = isFirstRef.current;
    isFirstRef.current = false;

    const ZOOM_STEPS = [6, 12, targetZoom];
    const ZOOM_OUT = [...ZOOM_STEPS].reverse();

    async function run() {
      if (isFirst) {
        // Wait for map container to have size
        for (let i = 0; i < 20; i++) {
          if (signal.aborted) return;
          if (map.getSize().x > 0) break;
          await sleep(50, signal);
        }
        if (signal.aborted) return;

        map.setView(center, 2, { animate: false });
        map.invalidateSize();
        await sleep(500, signal);

        // Zoom in stages
        for (const z of ZOOM_STEPS) {
          if (signal.aborted) return;
          map.flyTo(center, z, { duration: 0.7, easeLinearity: 0.4 });
          flash();
          await sleep(850, signal);
        }
      } else {
        // Zoom out stages
        for (const z of ZOOM_OUT) {
          if (signal.aborted) return;
          map.flyTo(map.getCenter(), z, { duration: 0.6, easeLinearity: 0.4 });
          flash();
          await sleep(700, signal);
        }
        if (signal.aborted) return;

        // Drift to new location
        await sleep(600, signal);
        if (signal.aborted) return;
        map.flyTo(center, 3, { duration: 1.8, easeLinearity: 0.15 });
        await sleep(2000, signal);

        // Zoom in stages
        for (const z of ZOOM_STEPS) {
          if (signal.aborted) return;
          map.flyTo(center, z, { duration: 0.7, easeLinearity: 0.4 });
          flash();
          await sleep(850, signal);
        }
      }
    }

    run();
    return () => controller.abort();
  }, [center, targetZoom, map, sleep, flash]);

  return null;
}

// ─── Pin icon ────────────────────────────────────────────────────────────────
function destPinIcon(idx, isSelected) {
  const color = isSelected ? "#e8a020" : "#5ecfcf";
  const glow = isSelected ? "0 0 16px #e8a02088, 0 0 30px #e8a02044" : "0 0 10px #5ecfcf66";
  const scale = isSelected ? 1.2 : 1;
  const borderColor = isSelected ? "#ffb833" : "#3a8888";
  return L.divIcon({
    className: "dest-map-pin",
    html: `<div style="transform:scale(${scale});display:flex;flex-direction:column;align-items:center;filter:drop-shadow(${glow});">
      <svg width="26" height="38" viewBox="0 0 26 38">
        <path d="M13 0C5.8 0 0 5.8 0 13c0 9.75 13 25 13 25s13-15.25 13-25C26 5.8 20.2 0 13 0z" fill="${color}" stroke="${borderColor}" stroke-width="1.5"/>
        <circle cx="13" cy="13" r="8" fill="#0a0a0c" opacity="0.3"/>
        <text x="13" y="17" text-anchor="middle" font-size="11" font-weight="800" font-family="monospace" fill="#0a0a0c">${idx + 1}</text>
      </svg>
    </div>`,
    iconSize: [26, 38],
    iconAnchor: [13, 38],
    popupAnchor: [0, -38],
  });
}

// ─── Coord parser ────────────────────────────────────────────────────────────
function getCoords(dest) {
  const ll = dest.trav_loc_latlng;
  if (!ll) return null;
  if (Array.isArray(ll) && ll.length === 2 && typeof ll[0] === "number") return ll;
  if (typeof ll === "string") { try { const p = JSON.parse(ll); if (Array.isArray(p)) return p; } catch {} }
  if (ll.lat != null && ll.lng != null) return [ll.lat, ll.lng];
  return null;
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function DestPreviewMap({ destinations, selectedIdx }) {
  if (!destinations || destinations.length === 0) return null;

  const selected = destinations[selectedIdx];
  const withCoords = destinations.filter((d) => getCoords(d));

  const selectedCoords = getCoords(selected);
  let center = [35.6812, 139.7671];
  if (selectedCoords) {
    center = selectedCoords;
  } else if (withCoords.length > 0) {
    center = [
      withCoords.reduce((s, d) => s + getCoords(d)[0], 0) / withCoords.length,
      withCoords.reduce((s, d) => s + getCoords(d)[1], 0) / withCoords.length,
    ];
  }

  const coordText = selectedCoords ? `${selectedCoords[0].toFixed(4)}°N ${selectedCoords[1].toFixed(4)}°E` : null;

  return (
    <div className="dest-preview-map">
      <MapContainer
        center={[35, 135]}
        zoom={2}
        style={{ height: "100%", width: "100%" }}
        zoomControl={false}
        attributionControl={false}
      >
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" />
        <ZoomController center={center} targetZoom={selectedCoords ? 14 : 5} />
        {destinations.map((dest, idx) => {
          const coords = getCoords(dest);
          if (!coords) return null;
          return (
            <Marker key={idx} position={coords} icon={destPinIcon(idx, idx === selectedIdx)}>
              <Popup><strong>{dest.trav_loc}</strong><br />{dest.trav_loc_sum}</Popup>
            </Marker>
          );
        })}
      </MapContainer>
      <div className="dest-preview-map__toolbar">
        <div className="dest-preview-map__label">
          {selected && (
            <>
              <strong>{selected.trav_loc}</strong>
              {selected.trav_loc_depth && (
                <span>{selected.trav_loc_depth.city}, {selected.trav_loc_depth.country}</span>
              )}
            </>
          )}
        </div>
        {coordText && (
          <div className="dest-preview-map__coords">
            <ScrambleText key={coordText} text={coordText} />
          </div>
        )}
      </div>
    </div>
  );
}
