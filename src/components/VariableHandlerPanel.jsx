import { useEffect, useRef } from "react";
import { ACTIVE_LLM, OWM_KEY } from "../api.js";
import { PLACE_TYPES } from "../constants.js";

/** Tokenize one line into React nodes. Handles **bold** and `code` inline
 *  syntax without touching innerHTML, so React's auto-escaping protects us
 *  from XSS on LLM / user output. */
function renderInlineMarkdown(line) {
  if (!line) return "\u00A0"; // non-breaking space so empty lines keep height
  const regex = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  const parts = [];
  let lastIdx = 0;
  let key = 0;
  let match;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIdx) {
      parts.push(line.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    }
    lastIdx = match.index + token.length;
  }
  if (lastIdx < line.length) {
    parts.push(line.slice(lastIdx));
  }
  return parts;
}

function renderMarkdownLike(text) {
  return String(text).split("\n").map((line, i) => (
    <p key={i} style={{ margin: "3px 0" }}>{renderInlineMarkdown(line)}</p>
  ));
}

export default function VariableHandlerPanel({
  show, onToggle,
  chatHistory, chatInput, onChatInputChange, onSend, isLoading,
  currentTime, location, weather, progress,
  modifiedSchedule, onApplyOriginal,
  nearbyPlaces, nearbyPlaceType, onNearbyTypeChange, hasGoogleMaps,
  scheduleDirections,
}) {
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (show) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      inputRef.current?.focus();
    }
  }, [show, chatHistory.length]);

  const suggestions = [
    "늦잠 자서 12시에 출발하는데 일정 변동 있나요?",
    "비가 오는데 야외 일정 조정해주세요",
    "팀랩 예약이 취소됐어요",
    "다음 장소까지 이동 시간이 얼마나 걸리나요?",
  ];

  const nextDir = scheduleDirections?.[0] ?? null;

  return (
    <div className={`var-handler ${show ? "var-handler--open" : ""}`}>
      <button type="button" className="var-handler__toggle" onClick={onToggle}>
        <span className="var-handler__toggle-icon">🤖</span>
        AI 변수 조치 {show ? "▲ 접기" : "▼ 열기"}
        {modifiedSchedule && <span className="var-handler__modified-dot" title="수정된 일정 적용 중" />}
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
              <span className="var-ctx__val">완료 {progress.done.length} / 남은 {progress.remaining.length}</span>
            </div>
            {nextDir && (
              <div className="var-ctx__col var-ctx__col--dir">
                <span className="var-ctx__label">🗺️ 다음 구간</span>
                <span className="var-ctx__val">{nextDir.fromName} → {nextDir.toName}</span>
                <span className="var-ctx__sub">{nextDir.duration} · {nextDir.distance}</span>
              </div>
            )}
            {modifiedSchedule && (
              <div className="var-ctx__col var-ctx__col--modified">
                <span className="var-ctx__label">일정 상태</span>
                <span className="var-ctx__val">🔄 AI 수정 적용 중 ({modifiedSchedule.length}곳)</span>
                <button type="button" className="var-ctx__revert-btn" onClick={onApplyOriginal}>원래 일정으로</button>
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

          <div className="var-chat">
            {chatHistory.length === 0 && (
              <div className="var-chat__empty">
                <p>✨ 예상치 못한 상황을 알려주세요. LLM이 현재 일정을 분석해 수정안을 제안합니다.</p>
                <div className="var-chat__suggestions">
                  {suggestions.map((s) => (
                    <button key={s} type="button" className="var-chat__suggestion-chip" onClick={() => { onChatInputChange(s); inputRef.current?.focus(); }}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`var-chat__msg var-chat__msg--${msg.role}`}>
                <span className="var-chat__role">{msg.role === "user" ? "👤 나" : "🤖 AI"}</span>
                <div className="var-chat__content">
                  {msg.role === "assistant" ? renderMarkdownLike(msg.content) : <p>{msg.content}</p>}
                  {msg.modifiedSchedule && msg.modifiedSchedule.length > 0 && (
                    <div className="var-chat__modified-schedule">
                      <strong>📋 수정된 일정 ({msg.modifiedSchedule.length}곳)</strong>
                      <ol>{msg.modifiedSchedule.map((item, idx) => (<li key={item.id != null ? `${item.id}-${idx}` : idx}>{item.time} {item.name} ({item.area ?? item.type})</li>))}</ol>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="var-chat__msg var-chat__msg--assistant">
                <span className="var-chat__role">🤖 AI</span>
                <div className="var-chat__content var-chat__thinking">
                  <span>분석 중</span>
                  <span className="var-chat__dots"><span /><span /><span /></span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="var-input-row">
            <textarea ref={inputRef} className="var-input" rows={2} placeholder="상황을 입력하세요 (예: 늦잠 자서 12시에 출발, 비가 와서 야외 취소…)" value={chatInput} onChange={(e) => onChatInputChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }} />
            <button type="button" className="btn primary var-send-btn" disabled={!chatInput.trim() || isLoading} onClick={onSend}>
              {isLoading ? "분석 중…" : "전송"}
            </button>
          </div>
          <p className="var-hint">
            {ACTIVE_LLM.key ? `${ACTIVE_LLM.label} 연결됨 (${ACTIVE_LLM.model})` : `시뮬레이션 모드 (${ACTIVE_LLM.keyEnv} 미설정)`}
            {" · "}{OWM_KEY ? "날씨 API 연결됨" : "날씨 시뮬레이션"}
            {" · "}{hasGoogleMaps ? "Google Maps 연결됨" : "Google Maps 미연결"}
          </p>
        </div>
      )}
    </div>
  );
}
