import { useEffect, useRef, useState } from "react";
import DestFlowDiagram from "./DestFlowDiagram.jsx";

export default function LLMLogSidebar({ logs, open, onToggle, onClear, view, onViewChange, destChatHistory, destSuggestions, destFollowUps }) {
  const endRef = useRef(null);
  const [expandedIdx, setExpandedIdx] = useState(null);

  useEffect(() => {
    if (open && endRef.current) endRef.current.scrollIntoView({ behavior: "smooth" });
  }, [logs.length, open]);

  return (
    <>
      <button type="button" className={`llm-log-toggle ${open ? "open" : ""}`} onClick={onToggle} title="LLM 통신 로그">
        <span className="llm-log-toggle__icon">&#x1F4E1;</span>
        {logs.length > 0 && <span className="llm-log-toggle__badge">{logs.length}</span>}
      </button>
      {open && (
        <aside className="llm-log-sidebar">
          <div className="llm-log-sidebar__header">
            <div className="llm-log-sidebar__tabs">
              <button type="button" className={`llm-log-sidebar__tab ${view === "log" ? "active" : ""}`} onClick={() => onViewChange("log")}>LOG</button>
              <button type="button" className={`llm-log-sidebar__tab ${view === "flow" ? "active" : ""}`} onClick={() => onViewChange("flow")}>FLOW</button>
            </div>
            <div className="llm-log-sidebar__actions">
              {view === "log" && logs.length > 0 && (<button type="button" className="llm-log-sidebar__clear" onClick={onClear}>초기화</button>)}
              <button type="button" className="llm-log-sidebar__close" onClick={onToggle}>&times;</button>
            </div>
          </div>
          {view === "flow" ? (
            <div className="llm-log-sidebar__body llm-log-sidebar__body--flow">
              <DestFlowDiagram chatHistory={destChatHistory ?? []} suggestions={destSuggestions ?? []} followUps={destFollowUps ?? []} />
            </div>
          ) : (
          <div className="llm-log-sidebar__body">
            {logs.length === 0 && (<p className="llm-log-sidebar__empty">아직 LLM 통신 내역이 없습니다.<br />AI 변수 조치 패널에서 메시지를 보내면 여기에 표시됩니다.</p>)}
            {logs.map((log, i) => (
              <div key={i} className={`llm-log-entry${log.error ? " llm-log-entry--error" : ""}${log.pending ? " llm-log-entry--pending" : ""}`}>
                <div className="llm-log-entry__time">
                  <span className={`llm-log-entry__provider${log.error ? " llm-log-entry__provider--error" : ""}${log.pending ? " llm-log-entry__provider--pending" : ""}`}>{log.pending ? "PENDING" : log.provider}{log.error ? " ERROR" : ""}</span>
                  <span>{log.pending ? "awaiting response…" : log.model}</span>
                  <span>{new Date(log.timestamp).toLocaleTimeString("ko-KR")}</span>
                </div>
                <div className="llm-log-msg llm-log-msg--req">
                  <span className="llm-log-msg__label">REQ</span>
                  <div className="llm-log-msg__content">
                    <p className="llm-log-msg__user">{log.userMessage}</p>
                    {log.requestBody && (
                      <button type="button" className="llm-log-msg__expand" onClick={() => setExpandedIdx(expandedIdx === `req-${i}` ? null : `req-${i}`)}>
                        {expandedIdx === `req-${i}` ? "▾ Request Body 접기" : "▸ Request Body 펼치기"}
                      </button>
                    )}
                    {expandedIdx === `req-${i}` && (<pre className="llm-log-msg__json">{JSON.stringify(log.requestBody, null, 2)}</pre>)}
                  </div>
                </div>
                {log.pending ? (
                  <div className="llm-log-msg llm-log-msg--res">
                    <span className="llm-log-msg__label">RES</span>
                    <div className="llm-log-msg__content">
                      <p className="llm-log-msg__text llm-log-msg__text--pending">Waiting for response<span className="var-chat__dots"><span /><span /><span /></span></p>
                    </div>
                  </div>
                ) : (
                <div className="llm-log-msg llm-log-msg--res">
                  <span className="llm-log-msg__label">RES</span>
                  <div className="llm-log-msg__content">
                    <p className="llm-log-msg__text">{log.responseText}</p>
                    {log.responseData && (() => {
                      const text = log.responseText ?? "";
                      const m = text.match(/```json\s*([\s\S]*?)```/);
                      if (!m) return null;
                      try {
                        const parsed = JSON.parse(m[1]);
                        const scope = parsed.scope ?? (Array.isArray(parsed.modifiedSchedule) ? "full" : null);
                        if (!scope) return null;
                        return (
                          <div className="llm-log-msg__schedule">
                            <strong>scope: {scope}</strong>
                            {Array.isArray(parsed.patches) && parsed.patches.length > 0 && (
                              <ol>{parsed.patches.map((p, idx) => (
                                <li key={idx}>
                                  {p.op}{p.id ? ` ${p.id}` : ""}{p.fields?.startTime ? ` → ${p.fields.startTime}` : ""}{p.slot?.name ? ` (${p.slot.name})` : ""}{p.fields?.name ? ` (${p.fields.name})` : ""}
                                </li>
                              ))}</ol>
                            )}
                            {Array.isArray(parsed.changes) && parsed.changes.length > 0 && (
                              <ul className="llm-log-msg__changes">
                                {parsed.changes.map((c, idx) => (
                                  <li key={idx}>{c.action}: {c.oldName ?? ""}{c.newName ? ` → ${c.newName}` : ""} {c.reason ? `— ${c.reason}` : ""}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        );
                      } catch {
                        return null;
                      }
                    })()}
                    {log.responseData && (
                      <button type="button" className="llm-log-msg__expand" onClick={() => setExpandedIdx(expandedIdx === `res-${i}` ? null : `res-${i}`)}>
                        {expandedIdx === `res-${i}` ? "▾ Response Body 접기" : "▸ Response Body 펼치기"}
                      </button>
                    )}
                    {expandedIdx === `res-${i}` && (<pre className="llm-log-msg__json">{JSON.stringify(log.responseData, null, 2)}</pre>)}
                  </div>
                </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
          )}
        </aside>
      )}
    </>
  );
}
