import { useEffect, useState } from "react";
import { Polyline } from "react-leaflet";
import { buildTransitLikeRoute } from "../utils.js";
import { fetchGoogleDirections, fetchOsrmGeometry, GMAPS_TRAVEL_MODE_MAP } from "../api.js";
import { osrmProfileForMove } from "../constants.js";

export default function RoutedPolylines({ defs, moveId, onSegmentClick }) {
  const [geoms, setGeoms] = useState({});
  const [directionDetails, setDirectionDetails] = useState({});

  useEffect(() => {
    let cancelled = false;
    if (!defs.length) { setGeoms({}); setDirectionDetails({}); return undefined; }

    const seed = Object.fromEntries(defs.map((d) => [d.id, buildTransitLikeRoute([d.from.latlng, d.to.latlng], moveId)]));
    setGeoms(seed);

    const travelMode = GMAPS_TRAVEL_MODE_MAP[moveId] ?? "DRIVING";
    const osrmProfile = osrmProfileForMove(moveId);

    (async () => {
      // Always try Google Directions first (returns null if VITE_GOOGLE_MAPS_API_KEY
      // is unset). Fall back to OSRM per-segment if Google returns no polyline.
      // fetchGoogleDirections uses a pure-JS polyline decoder so it works
      // immediately — no need to wait for the Maps JS SDK to load.
      const entries = await Promise.all(
        defs.map(async (def) => {
          const dir = await fetchGoogleDirections(def.from.latlng, def.to.latlng, travelMode);
          if (dir?.polylinePath && dir.polylinePath.length >= 2) {
            return { id: def.id, path: dir.polylinePath, dir };
          }
          // Google unavailable or no polyline — try OSRM as fallback
          const g = await fetchOsrmGeometry(def.from.latlng, def.to.latlng, osrmProfile);
          return { id: def.id, path: g && g.length >= 2 ? g : seed[def.id], dir: null };
        })
      );
      if (cancelled) return;
      setGeoms(Object.fromEntries(entries.map((e) => [e.id, e.path])));
      setDirectionDetails(Object.fromEntries(entries.filter((e) => e.dir).map((e) => [e.id, e.dir])));
    })();
    return () => { cancelled = true; };
  }, [defs, moveId]);

  return (
    <>
      {defs.map((def) => (
        <Polyline
          key={def.id}
          pathOptions={{ color: def.color, weight: def.weight ?? 7, opacity: 0.9, lineCap: "round", lineJoin: "round" }}
          positions={geoms[def.id] ?? [def.from.latlng, def.to.latlng]}
          eventHandlers={{ click: (e) => onSegmentClick(def, e, directionDetails[def.id] ?? null) }}
        />
      ))}
    </>
  );
}
