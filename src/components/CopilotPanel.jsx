import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVE_LLM, callChatLLM } from "../api.js";
import {
  validateSchedule,
  replaceSlot,
  removeSlot,
  getPrimaryLodging,
  applyPatches,
  detectScopeFromMessage,
  getDayCount,
  scheduleHash,
} from "../store/schedule.js";
import { buildCopilotSystemPrompt } from "../prompts/copilot.js";

/**
 * CopilotPanel — production-grade real-time Co-Pilot chat panel that reads
 * and writes the central TimeSlot schedule. Designed to be mounted inside
 * Edit View OR the trip-time Result screen — same component, both surfaces.
 *
 * The standalone CopilotDemo (src/components/CopilotDemo.jsx) is kept for
 * sandbox / presentation use; this component is the real integration.
 *
 * Props:
 *   schedule: Slot[]                — current schedule from App.jsx state
 *   onScheduleChange: (Slot[]) => void — called when LLM approves modification
 *   currentTime: string             — "HH:MM" injected into system prompt
 *   weather: string                 — e.g. "맑음 22°C"
 *   location: string                — e.g. "도쿄 신주쿠"
 *   onLog: (log) => void            — LLM request/response logging hook
 *   compact: boolean                — slimmer UI for side-mount
 *
 *   ── Trip-time only (optional) ──────────────────────────────────────────
 *   progress: { done, remaining, next }    — calcSlotProgress output. If
 *                                            present, prompt gains a "## 진행
 *                                            상황" block so the LLM knows
 *                                            what's already been visited.
 *   directions: [{ fromName, toName, ... }] — first 3 upcoming legs from
 *                                            fetchScheduleDirections. If
 *                                            present, prompt gains a "## 다음
 *                                            이동 구간" block.
 *   currentDay: number              — which day of the trip the user is on
 *                                     today. Used for scope detection ("오늘",
 *                                     "내일") and as a default when the LLM
 *                                     reasons about temporal context. Defaults
 *                                     to 1 when not provided.
 *
 *   ── Undo / Redo (optional) ────────────────────────────────────────────
 *   onUndo: () => void              — caller's commitSchedule history undo.
 *                                     Header shows "↩" button when canUndo.
 *   onRedo: () => void              — paired redo. Header shows "↪" when
 *                                     canRedo.
 *   canUndo: boolean                — toggle visibility/enabled state of the
 *                                     undo button.
 *   canRedo: boolean                — same for redo.
 */


function parseResponse(raw) {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    return { text: raw.trim(), scope: "none", modifiedSchedule: null, patches: null, changes: null };
  }
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const text = raw.replace(/```json[\s\S]*?```/g, "").trim();
    // Backward-compat: legacy responses had `modifiedSchedule` without an
    // explicit `scope`. Treat those as full-replace mode. The new partial
    // mode is `scope: "partial"` + `patches[]`.
    const scopeRaw = String(parsed.scope ?? "").toLowerCase();
    const hasPatches = Array.isArray(parsed.patches) && parsed.patches.length > 0;
    const hasFull = Array.isArray(parsed.modifiedSchedule);
    let scope;
    if (scopeRaw === "partial" || (hasPatches && !hasFull)) scope = "partial";
    else if (scopeRaw === "full" || hasFull) scope = "full";
    else scope = "none";
    return {
      text,
      scope,
      modifiedSchedule: hasFull ? parsed.modifiedSchedule : null,
      patches: hasPatches ? parsed.patches : null,
      changes: parsed.changes ?? null,
    };
  } catch {
    return { text: raw.trim(), scope: "none", modifiedSchedule: null, patches: null, changes: null };
  }
}

/**
 * Merge LLM-proposed schedule into existing schedule, preserving locked slots
 * and rejecting obviously malformed input. Returns { applied, merged, report }.
 */
function applyProposedSchedule(current, proposed) {
  if (!Array.isArray(proposed)) return { applied: false, merged: current, report: "no array" };
  // Preserve locked slots from current, take non-locked from proposal
  const currentById = new Map(current.map((s) => [s.id, s]));
  const lockedIds = new Set(current.filter((s) => s.locked).map((s) => s.id));
  const merged = [];
  for (const p of proposed) {
    if (!p?.id) continue;
    if (lockedIds.has(p.id)) {
      merged.push(currentById.get(p.id)); // keep original locked slot untouched
    } else {
      const prev = currentById.get(p.id);
      merged.push(prev ? { ...prev, ...p, locked: false } : { ...p, locked: false });
    }
  }
  // Ensure all originally-locked slots survived (LLM shouldn't drop them, but guard)
  for (const id of lockedIds) {
    if (!merged.find((s) => s.id === id)) merged.push(currentById.get(id));
  }
  const v = validateSchedule(merged);
  return { applied: v.ok, merged: v.ok ? merged : current, report: v.errors.join("; ") || null };
}

export default function CopilotPanel({
  schedule: rawSchedule,
  onScheduleChange,
  currentTime,
  weather,
  location,
  onLog,
  compact = false,
  progress = null,
  directions = null,
  currentDay = 1,
  onUndo = null,
  onRedo = null,
  canUndo = false,
  canRedo = false,
}) {
  // Defensive: schedule must be an array. If parent passes undefined/null the
  // panel should still render (with an empty-state message) rather than crash.
  const schedule = Array.isArray(rawSchedule) ? rawSchedule : [];
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: `안녕하세요! AI Co-Pilot 입니다. 🤖\n여행 중 돌발 상황이 생기면 말씀해주세요.\n\n예시:\n• "비가 와서 야외 못 가"\n• "늦잠 자서 12시에 일어남"\n• "이 식당 1시간 대기"`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [changes, setChanges] = useState([]);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      // Heuristic scope detection — if the user said "오늘", "내일", "DAY 3"
      // etc, we send only that day's slots to the LLM to save tokens AND keep
      // the model focused. Falls back to full schedule on no temporal cue.
      const dayCount = getDayCount(schedule);
      // currentDay comes from props when the caller can compute it (trip-time
      // mount knows which day of the trip is happening); otherwise defaults
      // to 1 so "오늘" still resolves to a valid day.
      const { days: scopeDays } = detectScopeFromMessage(text, {
        currentDay,
        dayCount,
      });
      const scopeOpts = scopeDays ? { days: scopeDays } : {};
      // Capture schedule hash BEFORE the LLM call. Used as race-condition
      // guard on apply — if the user edits between request and response, the
      // patch is rejected rather than silently overwriting their changes.
      const requestHash = scheduleHash(schedule);
      const systemPrompt = buildCopilotSystemPrompt({
        schedule,
        currentTime,
        weather,
        location,
        scopeOpts,
        progress,
        directions,
      });
      const apiMessages = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: text },
      ];
      const { text: raw } = await callChatLLM({
        systemPrompt,
        messages: apiMessages,
        onLog,
        fnName: "copilot",
      });
      const parsed = parseResponse(raw);
      // callChatLLM already pushes one log entry with full request/response —
      // no second user-facing log needed here.

      setMessages((prev) => [...prev, { role: "assistant", content: parsed.text }]);

      // Dispatch on scope: "partial" → applyPatches (id-based, time cascade
      // automatic, locked-protected), "full" → legacy applyProposedSchedule
      // (full array replace). Both end at onScheduleChange with merged state.
      if (parsed.scope === "partial") {
        const { applied, merged, report, staleHash } = applyPatches(schedule, parsed.patches, {
          expectedHash: requestHash,
        });
        if (applied) {
          onScheduleChange?.(merged);
          if (parsed.changes) setChanges(parsed.changes);
          if (report) console.info("[Co-Pilot] partial applied with skips:", report);
        } else {
          const userMsg = staleHash
            ? `⚠️ 응답을 적용하려는 사이 일정이 변경되어 적용을 취소했습니다. 동일한 요청을 다시 보내주세요.`
            : `⚠️ 부분 수정 적용 실패: ${report}`;
          setMessages((prev) => [...prev, { role: "assistant", content: userMsg }]);
        }
      } else if (parsed.scope === "full") {
        // Same race guard as the partial path — reject if the schedule has
        // changed during the LLM call.
        if (scheduleHash(schedule) !== requestHash) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `⚠️ 응답을 적용하려는 사이 일정이 변경되어 적용을 취소했습니다. 동일한 요청을 다시 보내주세요.` },
          ]);
          return;
        }
        const { applied, merged, report } = applyProposedSchedule(schedule, parsed.modifiedSchedule);
        if (applied) {
          onScheduleChange?.(merged);
          if (parsed.changes) setChanges(parsed.changes);
        } else {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `⚠️ LLM 응답이 유효하지 않아 적용하지 못했습니다: ${report}` },
          ]);
        }
      }
    } catch (err) {
      console.error("[CopilotPanel] LLM error:", err);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `❌ LLM 요청 실패: ${err.message}\n\n(${ACTIVE_LLM.provider} / ${ACTIVE_LLM.model})`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, schedule, onScheduleChange, currentTime, weather, location, onLog, progress, directions, currentDay]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const scheduleSummary = useMemo(() => {
    const activities = schedule.filter((s) => s.kind === "activity").length;
    const lodging = getPrimaryLodging(schedule);
    return { activities, lodging: lodging?.name ?? null };
  }, [schedule]);

  return (
    <div className={`copilot-panel ${compact ? "copilot-panel--compact" : ""}`}>
      <div className="copilot-panel__header">
        <span className="copilot-panel__header-icon">🤖</span>
        <span className="copilot-panel__header-title">Co-Pilot</span>
        <span className="copilot-panel__header-meta">
          {scheduleSummary.lodging ? `🏨 ${scheduleSummary.lodging} · ` : ""}활동 {scheduleSummary.activities}개
        </span>
        {(onUndo || onRedo) && (
          <span className="copilot-panel__history">
            <button
              type="button"
              className="copilot-panel__history-btn"
              onClick={onUndo}
              disabled={!canUndo || !onUndo}
              title={canUndo ? "마지막 변경 되돌리기" : "되돌릴 변경이 없습니다"}
            >
              ↩
            </button>
            <button
              type="button"
              className="copilot-panel__history-btn"
              onClick={onRedo}
              disabled={!canRedo || !onRedo}
              title={canRedo ? "되돌린 변경 다시 실행" : "다시 실행할 변경이 없습니다"}
            >
              ↪
            </button>
          </span>
        )}
      </div>

      <div className="copilot-panel__messages">
        {messages.map((msg, i) => (
          <div key={i} className={`copilot-panel__msg copilot-panel__msg--${msg.role}`}>
            <div className="copilot-panel__msg-bubble">
              {msg.content.split("\n").map((line, j) => (
                <span key={j}>
                  {line}
                  {j < msg.content.split("\n").length - 1 && <br />}
                </span>
              ))}
            </div>
          </div>
        ))}
        {loading && (
          <div className="copilot-panel__msg copilot-panel__msg--assistant">
            <div className="copilot-panel__msg-bubble copilot-panel__msg-loading">
              <span className="copilot-panel__dot" />
              <span className="copilot-panel__dot" />
              <span className="copilot-panel__dot" />
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {changes.length > 0 && (
        <div className="copilot-panel__changes">
          <span className="copilot-panel__changes-title">최근 변경</span>
          {changes.slice(-3).map((c, i) => (
            <span key={i} className="copilot-panel__change-item">
              <span className={`copilot-panel__change-action copilot-panel__change-action--${c.action}`}>
                {c.action}
              </span>
              {c.action === "replaced"
                ? `${c.oldName} → ${c.newName}`
                : c.action === "removed"
                ? c.oldName
                : `${c.oldName} (시간 조정)`}
            </span>
          ))}
        </div>
      )}

      <div className="copilot-panel__input-row">
        <textarea
          className="copilot-panel__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="돌발 상황을 입력하세요..."
          rows={1}
          disabled={loading}
        />
        <button
          type="button"
          className="copilot-panel__send-btn"
          onClick={handleSend}
          disabled={loading || !input.trim()}
          title="전송"
        >
          ▶
        </button>
      </div>
    </div>
  );
}
