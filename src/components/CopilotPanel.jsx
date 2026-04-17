import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVE_LLM } from "../api.js";
import {
  validateSchedule,
  scheduleToLLMText,
  replaceSlot,
  removeSlot,
  getPrimaryLodging,
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

const OLLAMA_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_OLLAMA_URL) ||
  "http://localhost:11434";

function buildSystemPrompt(schedule, currentTime, weather, location) {
  const scheduleText = scheduleToLLMText(schedule);
  return `당신은 AI 여행 Co-Pilot입니다. 사용자의 실시간 돌발 상황에 맞춰 여행 일정을 지능적으로 수정합니다.
모든 응답은 반드시 한국어로 작성하세요.

## 현재 상황
- 현재 시각: ${currentTime ?? "-"}
- 날씨: ${weather ?? "-"}
- 위치: ${location ?? "-"}

## 현재 일정 (TimeSlot 형식)
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
텍스트 설명 후 반드시 아래 JSON 블록을 포함하세요:

\`\`\`json
{
  "modifiedSchedule": [... 수정된 전체 TimeSlot 배열 — 모든 필드 유지 ...],
  "changes": [
    {
      "action": "replaced" | "removed" | "timeShift",
      "oldName": "기존 항목명",
      "newName": "새 항목명 (replaced일 때만)",
      "reason": "변경 사유"
    }
  ]
}
\`\`\`

## 중요사항
- \`locked: true\` 인 슬롯 (숙소 앵커 등) 은 절대 수정하지 마세요
- 시간 연속성을 유지하세요 (겹치는 시간 없이)
- 새 슬롯 추가 시 기존 슬롯과 같은 필드 구조 유지: id, day, kind, startTime, endTime, duration, name, area, indoor, locked
- id 는 기존 id 를 유지하거나 새로 추가 시 unique 하게 부여하세요
- duration 은 분 단위입니다
- 대체 장소 추천 시 같은 area 내 또는 인접 area 의 실제 존재하는 장소를 제안하세요`;
}

async function fetchLLM(systemPrompt, chatMessages) {
  const cfg = ACTIVE_LLM;
  if (!cfg.key) throw new Error("API key not configured");

  if (cfg.provider === "openai" || cfg.provider === "ollama") {
    const isOllama = cfg.provider === "ollama";
    const apiUrl = isOllama
      ? `${OLLAMA_URL}/v1/chat/completions`
      : "https://api.openai.com/v1/chat/completions";
    const headers = { "Content-Type": "application/json" };
    if (!isOllama) headers.Authorization = `Bearer ${cfg.key}`;
    const messages = [{ role: "system", content: systemPrompt }, ...chatMessages];
    const res = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 4096, temperature: 0.7 }),
    });
    if (!res.ok) throw new Error(`${cfg.provider} ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (cfg.provider === "gemini") {
    const geminiMessages = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const reqBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: geminiMessages,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      }
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n");
  }

  if (cfg.provider === "claude") {
    const claudeMessages = chatMessages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));
    const reqBody = {
      model: cfg.model,
      system: systemPrompt,
      max_tokens: 4096,
      temperature: 0.7,
      messages: claudeMessages,
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) throw new Error(`claude ${res.status}`);
    const data = await res.json();
    return (data.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
  }

  throw new Error(`Unknown provider: ${cfg.provider}`);
}

function parseResponse(raw) {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return { text: raw.trim(), modifiedSchedule: null, changes: null };
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const text = raw.replace(/```json[\s\S]*?```/g, "").trim();
    return {
      text,
      modifiedSchedule: parsed.modifiedSchedule ?? null,
      changes: parsed.changes ?? null,
    };
  } catch {
    return { text: raw.trim(), modifiedSchedule: null, changes: null };
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
      const systemPrompt = buildSystemPrompt(schedule, currentTime, weather, location);
      const apiMessages = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: text },
      ];
      const raw = await fetchLLM(systemPrompt, apiMessages);
      const parsed = parseResponse(raw);

      if (onLog) {
        onLog({
          provider: ACTIVE_LLM.provider,
          model: ACTIVE_LLM.model,
          userMessage: text,
          responseText: parsed.text,
          timestamp: new Date().toISOString(),
          fn: "copilot",
        });
      }

      setMessages((prev) => [...prev, { role: "assistant", content: parsed.text }]);

      if (parsed.modifiedSchedule) {
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
