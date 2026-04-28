import { PLACE_TYPES } from "../constants.js";

/**
 * VariableHandlerPanel — trip-time context shell.
 *
 * Owns the toggle and renders the static info widgets the user wants to see
 * while traveling: current time/location/weather/progress, upcoming route
 * segment, schedule-wide directions list, and nearby places. The actual LLM
 * chat is rendered as `children` — App.jsx slots in <CopilotPanel> with the
 * trip-time props so the same chat surface drives both Edit View and Result
 * page modifications.
 */
export default function VariableHandlerPanel({
  show, onToggle,
  currentTime, location, weather, progress,
  nearbyPlaces, nearbyPlaceType, onNearbyTypeChange, hasGoogleMaps,
  scheduleDirections,
  children,
}) {
  const nextDir = scheduleDirections?.[0] ?? null;
  const nextSlot = progress?.next ?? null;

  return (
    <div className={`var-handler ${show ? "var-handler--open" : ""}`}>
      <button type="button" className="var-handler__toggle" onClick={onToggle}>
        <span className="var-handler__toggle-icon">🤖</span>
        AI 변수 조치 {show ? "▲ 접기" : "▼ 열기"}
      </button>

      {show && (
        <div className="var-handler__body">
          <div className="var-ctx">
            <div className="var-ctx__col">
              <span className="var-ctx__label">현재 시간</span>
              <span className="var-ctx__val">{currentTime}</span>
            </div>
            <div className="var-ctx__col">
              <span className="var-ctx__label">현재 위치</span>
              <span className="var-ctx__val">{location ?? "확인 중…"}</span>
            </div>
            <div className="var-ctx__col">
              <span className="var-ctx__label">날씨</span>
              <span className="var-ctx__val">{weather ? `${weather.icon} ${weather.temp} ${weather.description}` : "로딩…"}</span>
            </div>
            <div className="var-ctx__col">
              <span className="var-ctx__label">진행 상황</span>
              <span className="var-ctx__val">완료 {progress?.done?.length ?? 0} / 남은 {progress?.remaining?.length ?? 0}</span>
              {nextSlot && (
                <span className="var-ctx__sub">다음: {nextSlot.startTime ?? nextSlot.time ?? ""} {nextSlot.name}</span>
              )}
            </div>
            {nextDir && (
              <div className="var-ctx__col var-ctx__col--dir">
                <span className="var-ctx__label">🗺️ 다음 구간</span>
                <span className="var-ctx__val">{nextDir.fromName} → {nextDir.toName}</span>
                <span className="var-ctx__sub">{nextDir.duration} · {nextDir.distance}</span>
              </div>
            )}
          </div>

          {hasGoogleMaps && scheduleDirections && scheduleDirections.length > 0 && (
            <div className="var-directions">
              <span className="var-directions__label">🗺️ 경로 안내 (Google Maps Directions)</span>
              <div className="var-directions__list">
                {scheduleDirections.map((d, idx) => (
                  <div key={`${d.fromId}-${d.toId}-${idx}`} className="var-directions__item">
                    <span className="var-directions__route">{d.fromName} → {d.toName}</span>
                    <span className="var-directions__meta">{d.duration} · {d.distance}</span>
                    {d.steps && d.steps.length > 0 && (
                      <ol className="var-directions__steps">
                        {d.steps.slice(0, 3).map((s, si) => (<li key={si}>{s.instruction} ({s.duration})</li>))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasGoogleMaps && (
            <div className="var-nearby">
              <div className="var-nearby__header">
                <span className="var-nearby__label">📍 현재 위치 주변</span>
                <div className="var-nearby__type-btns">
                  {PLACE_TYPES.map((pt) => (
                    <button key={pt.id} type="button" className={`var-nearby__type-btn ${nearbyPlaceType === pt.id ? "active" : ""}`} onClick={() => onNearbyTypeChange(pt.id)} title={pt.label}>
                      {pt.icon} {pt.label}
                    </button>
                  ))}
                </div>
              </div>
              {nearbyPlaces.length > 0 ? (
                <div className="var-nearby__list">
                  {nearbyPlaces.map((p, idx) => (
                    <span key={p.id ? `${p.id}-${idx}` : idx} className="var-nearby__chip" title={p.vicinity}>
                      {p.name}{p.rating ? ` ★${p.rating}` : ""}{p.openNow === true && " ✅"}{p.openNow === false && " 🔴"}
                    </span>
                  ))}
                </div>
              ) : (<p className="var-nearby__empty">검색 중…</p>)}
            </div>
          )}

          {children}
        </div>
      )}
    </div>
  );
}
