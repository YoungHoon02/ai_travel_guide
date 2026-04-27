import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVE_LLM, callChatLLM } from "../api.js";
import {
  validateSchedule,
  scheduleToLLMText,
  replaceSlot,
  removeSlot,
  getPrimaryLodging,
  applyPatches,
  detectScopeFromMessage,
  getDayCount,
  scheduleHash,
} from "../store/schedule.js";

/**
 * CopilotPanel — production-grade real-time Co-Pilot chat panel that reads
 * and writes the central TimeSlot schedule. Designed to be mounted inside
 * Edit View (or any screen that holds the schedule).
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
 */

function buildSystemPrompt(schedule, currentTime, weather, location, scopeOpts) {
  const scheduleText = scheduleToLLMText(schedule, scopeOpts ?? {});
  // Tell the LLM exactly which slice it's seeing so it doesn't propose changes
  // for slots it can't see — important once we filter by day.
  const scopeNote = scopeOpts?.days?.length
    ? `\n_(이 응답에 포함된 일정은 DAY ${scopeOpts.days.join(", ")} 만 입니다. 다른 날 일정은 변경하지 마세요.)_`
    : "";
  return `당신은 AI 여행 Co-Pilot입니다. 사용자의 실시간 돌발 상황에 맞춰 여행 일정을 지능적으로 수정합니다.
모든 응답은 반드시 한국어로 작성하세요.

## 현재 상황
- 현재 시각: ${currentTime ?? "-"}
- 날씨: ${weather ?? "-"}
- 위치: ${location ?? "-"}

## 현재 일정 (TimeSlot 형식)${scopeNote}
${scheduleText}

## 핵심 규칙: 역질문 프로토콜 (Counter-Question Protocol)

사용자의 의도가 불분명하거나 여러 대응이 가능할 때는 **반드시 역질문**을 먼저 하세요.
직접 수정은 사용자가 명확한 지시를 내릴 때만 합니다.

### 역질문이 필요한 상황:
1. **날씨 변화** → "야외 일정을 실내로 전환할까요? 아니면 우산 쓰고 그대로 진행할까요?"
2. **늦잠/지각** → "놓친 일정을 건너뛸까요, 아니면 나머지를 압축할까요?"
3. **컨디션 불량** → "전체 일정을 취소하고 쉴까요? 아니면 가벼운 실내 일정으로 바꿀까요?"
4. **장소 폐쇄/만석** → "대체 장소를 추천할까요, 아니면 건너뛸까요?"

### 직접 수정하는 상황 (역질문 없이):
- 사용자가 "A 대신 B 가고 싶어"처럼 명확한 지시
- 사용자가 역질문에 대해 선택을 답변한 경우
- "압축해줘", "건너뛰어", "실내로 바꿔" 등 구체적 액션

## 응답 형식

### 역질문 시 (일정 수정 없음):
일반 텍스트로만 응답하세요. JSON 블록을 포함하지 마세요.

### 일정 수정 시:
텍스트 설명 후 반드시 아래 JSON 블록을 포함하세요. **부분 수정은 \`scope: "partial"\` + \`patches\` 형식을, 전면 재구성은 \`scope: "full"\` + \`modifiedSchedule\` 형식을 사용하세요.**

#### A) 부분 수정 (권장 — 대부분의 경우 이 형식)
영향받은 슬롯만 patch로 보내세요. 시간 cascade(다음 슬롯들 시간 자동 밀림)는 시스템이 처리하므로 **변경된 슬롯의 startTime만 바꿔주면 됩니다** — 영향받지 않은 슬롯은 절대 patches에 포함하지 마세요.

\`\`\`json
{
  "scope": "partial",
  "patches": [
    { "id": "기존슬롯id", "op": "replace", "fields": { "startTime": "10:30", "name": "..." } },
    { "id": "기존슬롯id", "op": "remove" },
    { "op": "insert", "afterId": "참조슬롯id또는null", "slot": { "id": "새unique id", "day": 1, "kind": "activity", "startTime": "14:00", "duration": 90, "name": "...", "area": "...", "indoor": false, "locked": false } }
  ],
  "changes": [
    { "action": "replaced" | "removed" | "timeShift" | "added", "oldName": "...", "newName": "...", "reason": "..." }
  ]
}
\`\`\`

#### B) 전면 재구성 (특수 — day 전체를 다시 짤 때만)

\`\`\`json
{
  "scope": "full",
  "modifiedSchedule": [... 수정된 전체 TimeSlot 배열 ...],
  "changes": [...]
}
\`\`\`

## 중요사항
- \`locked: true\` 인 슬롯 (숙소 앵커 등) 은 절대 수정하지 마세요 — patch 또는 modifiedSchedule에 포함해도 시스템이 거부합니다
- **부분 수정 시 시간 cascade는 시스템이 자동 처리**: 슬롯 C의 startTime만 바꾸면 D/E는 자동으로 밀립니다. patches에 D/E를 넣지 마세요
- 새 슬롯 insert 시 unique한 id 부여 (예: \`slot-new-1\`)
- duration 은 분 단위입니다
- 대체 장소 추천 시 같은 area 내 또는 인접 area 의 실제 존재하는 장소를 제안하세요
- 슬롯 옆 \`[morning|lunch|afternoon|dinner|night]\` 표시는 시간대 라벨입니다. 사용자가 "오전 일정", "저녁 일정" 같이 표현하면 그 시간대 슬롯들을 대상으로 판단하세요 (시스템이 자동으로 부여, LLM이 직접 채울 필요 없음)`;
}

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
      // currentDay is inferred from currentTime when caller doesn't provide
      // a day index — for now we default to day 1 when ambiguous.
      const inferredCurrentDay = 1;
      const { days: scopeDays } = detectScopeFromMessage(text, {
        currentDay: inferredCurrentDay,
        dayCount,
      });
      const scopeOpts = scopeDays ? { days: scopeDays } : {};
      // Capture schedule hash BEFORE the LLM call. Used as race-condition
      // guard on apply — if the user edits between request and response, the
      // patch is rejected rather than silently overwriting their changes.
      const requestHash = scheduleHash(schedule);
      const systemPrompt = buildSystemPrompt(schedule, currentTime, weather, location, scopeOpts);
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
  }, [input, loading, messages, schedule, onScheduleChange, currentTime, weather, location, onLog]);

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
