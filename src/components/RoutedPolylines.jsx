import { Fragment, useEffect, useState } from "react";
import { Polyline } from "react-leaflet";
import { buildTransitLikeRoute } from "../utils.js";
import { fetchGoogleDirections, fetchOsrmGeometry, buildStepSegments, GMAPS_TRAVEL_MODE_MAP } from "../api.js";
import { osrmProfileForMove } from "../constants.js";

export default function RoutedPolylines({ defs, moveId, onSegmentClick }) {
  const [geoms, setGeoms] = useState({});
  const [directionDetails, setDirectionDetails] = useState({});
  const [gmapsReady, setGmapsReady] = useState(Boolean(window.__googleMapsLoaded));

  useEffect(() => {
    if (gmapsReady || window.__googleMapsLoaded) {
      if (!gmapsReady) setGmapsReady(true);
      return;
    }
    const handler = () => setGmapsReady(true);
    window.addEventListener("googlemapsloaded", handler, { once: true });
    return () => window.removeEventListener("googlemapsloaded", handler);
  }, [gmapsReady]);

  useEffect(() => {
    let cancelled = false;
    if (!defs.length) { setGeoms({}); setDirectionDetails({}); return undefined; }

    const seed = Object.fromEntries(defs.map((d) => [d.id, buildTransitLikeRoute([d.from.latlng, d.to.latlng], moveId)]));
    setGeoms(seed);

    const travelMode = GMAPS_TRAVEL_MODE_MAP[moveId] ?? "DRIVING";
    (async () => {
      if (gmapsReady) {
        const entries = await Promise.all(
          defs.map(async (def) => {
            const dir = await fetchGoogleDirections(def.from.latlng, def.to.latlng, travelMode);
            if (dir?.polylinePath && dir.polylinePath.length >= 2) return { id: def.id, path: dir.polylinePath, dir };
            return { id: def.id, path: seed[def.id], dir: null };
          })
        );
        if (cancelled) return;
        setGeoms(Object.fromEntries(entries.map((e) => [e.id, e.path])));
        setDirectionDetails(Object.fromEntries(entries.filter((e) => e.dir).map((e) => [e.id, e.dir])));
        return;
      }
      const profile = osrmProfileForMove(moveId);
      const entries = await Promise.all(
        defs.map(async (def) => {
          const g = await fetchOsrmGeometry(def.from.latlng, def.to.latlng, profile);
          return [def.id, g && g.length >= 2 ? g : seed[def.id]];
        })
      );
      if (cancelled) return;
      setGeoms(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [defs, moveId, gmapsReady]);

  return (
    <>
      {defs.map((def) => {
        const dirInfo = directionDetails[def.id] ?? null;
        const trafficSegments = (dirInfo?.trafficSegments ?? []).filter((seg) => Array.isArray(seg.path) && seg.path.length >= 2);
        if (trafficSegments.length > 0) {
          return (
            <Fragment key={def.id}>
              {trafficSegments.map((seg, idx) => (
                <Polyline
                  key={`${def.id}-traffic-${idx}`}
                  pathOptions={{
                    color: seg.color,
                    weight: (def.weight ?? 7) + 1,
                    opacity: 0.92,
                    lineCap: "round",
                    lineJoin: "round",
                  }}
                  positions={seg.path}
                  eventHandlers={{ click: (e) => onSegmentClick(def, e, dirInfo) }}
                />
              ))}
            </Fragment>
          );
        }

        const stepSegments = buildStepSegments(dirInfo);
        const hasMixedModes =
          stepSegments.length > 1 &&
          new Set(stepSegments.map((s) => s.mode)).size > 1;
        if (hasMixedModes) {
          return (
            <Fragment key={def.id}>
              {stepSegments.map((seg, idx) => (
                <Polyline
                  key={`${def.id}-step-${idx}`}
                  pathOptions={{
                    color: seg.color,
                    weight: seg.mode === "WALKING" ? (def.weight ?? 7) - 2 : def.weight ?? 7,
                    opacity: 0.92,
                    lineCap: "round",
                    lineJoin: "round",
                    ...(seg.mode === "WALKING" ? { dashArray: "4 6" } : {}),
                  }}
                  positions={seg.path}
                  eventHandlers={{ click: (e) => onSegmentClick(def, e, dirInfo) }}
                />
              ))}
            </Fragment>
          );
        }

        return (
          <Polyline
            key={def.id}
            pathOptions={{
              color: def.color,
              weight: def.weight ?? 7,
              opacity: 0.9,
              lineCap: "round",
              lineJoin: "round",
              ...(dirInfo?.isApproximate ? { dashArray: "8 10" } : {}),
            }}
            positions={geoms[def.id] ?? [def.from.latlng, def.to.latlng]}
            eventHandlers={{ click: (e) => onSegmentClick(def, e, dirInfo) }}
          />
        );
      })}
    </>
  );
}
