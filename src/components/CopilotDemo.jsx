import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVE_LLM } from "../api.js";

// ─── Hardcoded Tokyo 2N3D sample schedule ──────────────────────────────────
const INITIAL_SCHEDULE = [
  // Day 1
  { id: "d1-lodge-start", day: 1, startTime: "08:00", endTime: "09:00", duration: 60, type: "lodging", name: "신주쿠 호텔 출발", area: "신주쿠", indoor: true, locked: true },
  { id: "d1-a1", day: 1, startTime: "09:30", endTime: "11:00", duration: 90, type: "activity", name: "메이지 신궁", area: "하라주쿠", indoor: false, locked: false },
  { id: "d1-a2", day: 1, startTime: "11:30", endTime: "13:00", duration: 90, type: "activity", name: "다케시타 거리 & 점심", area: "하라주쿠", indoor: false, locked: false },
  { id: "d1-a3", day: 1, startTime: "13:30", endTime: "15:30", duration: 120, type: "activity", name: "시부야 스크램블 & 하치코", area: "시부야", indoor: false, locked: false },
  { id: "d1-a4", day: 1, startTime: "16:00", endTime: "18:00", duration: 120, type: "activity", name: "시부야 스카이 전망대", area: "시부야", indoor: true, locked: false },
  { id: "d1-lodge-end", day: 1, startTime: "19:00", endTime: "20:00", duration: 60, type: "lodging", name: "호텔 복귀 & 저녁", area: "신주쿠", indoor: true, locked: true },

  // Day 2
  { id: "d2-lodge-start", day: 2, startTime: "08:00", endTime: "09:00", duration: 60, type: "lodging", name: "호텔 출발", area: "신주쿠", indoor: true, locked: true },
  { id: "d2-a1", day: 2, startTime: "09:30", endTime: "11:30", duration: 120, type: "activity", name: "센소지 (아사쿠사)", area: "아사쿠사", indoor: false, locked: false },
  { id: "d2-a2", day: 2, startTime: "12:00", endTime: "13:30", duration: 90, type: "activity", name: "우에노 아메요코 & 점심", area: "우에노", indoor: false, locked: false },
  { id: "d2-a3", day: 2, startTime: "14:00", endTime: "16:00", duration: 120, type: "activity", name: "도쿄 국립박물관", area: "우에노", indoor: true, locked: false },
  { id: "d2-a4", day: 2, startTime: "16:30", endTime: "18:30", duration: 120, type: "activity", name: "아키하바라 전자상가", area: "아키하바라", indoor: true, locked: false },
  { id: "d2-lodge-end", day: 2, startTime: "19:30", endTime: "20:30", duration: 60, type: "lodging", name: "호텔 복귀 & 저녁", area: "신주쿠", indoor: true, locked: true },

  // Day 3
  { id: "d3-lodge-start", day: 3, startTime: "08:00", endTime: "09:00", duration: 60, type: "lodging", name: "호텔 출발 (체크아웃)", area: "신주쿠", indoor: true, locked: true },
  { id: "d3-a1", day: 3, startTime: "09:30", endTime: "11:00", duration: 90, type: "activity", name: "츠키지 아우터 마켓", area: "츠키지", indoor: false, locked: false },
  { id: "d3-a2", day: 3, startTime: "11:30", endTime: "13:00", duration: 90, type: "activity", name: "하마리큐 정원", area: "시오도메", indoor: false, locked: false },
  { id: "d3-a3", day: 3, startTime: "13:30", endTime: "15:00", duration: 90, type: "activity", name: "오다이바 팀랩 보더리스", area: "오다이바", indoor: true, locked: false },
  { id: "d3-a4", day: 3, startTime: "15:30", endTime: "17:00", duration: 90, type: "activity", name: "도쿄역 쇼핑 & 기념품", area: "마루노우치", indoor: true, locked: false },
  { id: "d3-lodge-end", day: 3, startTime: "18:00", endTime: "19:00", duration: 60, type: "lodging", name: "나리타 공항 이동", area: "나리타", indoor: true, locked: true },
];

const WEATHER_OPTIONS = [
  { value: "맑음", label: "맑음", emoji: "☀️" },
  { value: "흐림", label: "흐림", emoji: "☁️" },
  { value: "비", label: "비", emoji: "🌧️" },
  { value: "폭우", label: "폭우", emoji: "⛈️" },
  { value: "눈", label: "눈", emoji: "❄️" },
];

const TIME_OPTIONS = Array.from({ length: 25 }, (_, i) => {
  const h = String(Math.floor(i / 2) + 8).padStart(2, "0");
  const m = i % 2 === 0 ? "00" : "30";
  return `${h}:${m}`;
}).filter((t) => t <= "20:00");

const INITIAL_MESSAGE = `안녕하세요! AI 여행 Co-Pilot 입니다. 🤖

현재 도쿄 2박 3일 일정이 진행 중이에요.
돌발 상황이 발생하면 말씀해주세요.

예시:
• "비가 와서 야외 못 가"
• "늦잠 자서 12시에 일어남"
• "이 식당 1시간 대기"
• "메이지 신궁 대신 박물관 가고 싶어"`;

// ─── System prompt builder ─────────────────────────────────────────────────
function buildSystemPrompt(schedule, currentTime, weather, location) {
  return `당신은 AI 여행 Co-Pilot입니다. 사용자의 실시간 돌발 상황에 맞춰 여행 일정을 지능적으로 수정합니다.
모든 응답은 반드시 한국어로 작성하세요.

## 현재 상황
- 현재 시각: ${currentTime}
- 날씨: ${weather}
- 위치: ${location}

## 현재 일정 (TimeSlot 형식)
\`\`\`json
${JSON.stringify(schedule, null, 2)}
\`\`\`

## 핵심 규칙: 역질문 프로토콜 (Counter-Question Protocol)

사용자의 의도가 불분명하거나 여러 대응이 가능할 때는 **반드시 역질문**을 먼저 하세요.
직접 수정은 사용자가 명확한 지시를 내릴 때만 합니다.

### 역질문이 필요한 상황:
1. **날씨 변화** → "야외 일정을 실내로 전환할까요? 아니면 우산 쓰고 그대로 진행할까요?"
2. **늦잠/지각** → "놓친 일정을 건너뛸까요, 아니면 나머지를 압축할까요?"
3. **컨디션 불량** → "전체 일정을 취소하고 쉴까요? 아니면 가벼운 실내 일정으로 바꿀까요?"
4. **장소 폐쇄/만석** → "대체 장소를 추천할까요, 아니면 건너뛸까요?"

### 직접 수정하는 상황 (역질문 없이):
- 사용자가 "A 대신 B 가고 싶어"처럼 명확한 지시를 한 경우
- 사용자가 역질문에 대해 선택을 답변한 경우
- "압축해줘", "건너뛰어", "실내로 바꿔" 등 구체적 액션을 요청한 경우

## 응답 형식

### 역질문 시 (일정 수정 없음):
일반 텍스트로만 응답하세요. JSON 블록을 포함하지 마세요.

### 일정 수정 시:
텍스트 설명 후 반드시 아래 JSON 블록을 포함하세요:

\`\`\`json
{
  "modifiedSchedule": [... 수정된 전체 TimeSlot 배열 ...],
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
- locked: true인 숙소 슬롯은 절대 수정하지 마세요
- 시간 연속성을 유지하세요 (겹치는 시간 없이)
- 수정 시 area(지역) 기반 이동 동선을 고려하세요
- 대체 장소는 비슷한 지역/분류의 실제 존재하는 장소를 추천하세요
- duration은 분 단위입니다`;
}

// ─── LLM fetch (multi-provider) ────────────────────────────────────────────
const OLLAMA_URL = (typeof import.meta !== "undefined" && import.meta.env?.VITE_OLLAMA_URL) || "http://localhost:11434";

async function fetchLLM(systemPrompt, chatMessages) {
  const cfg = ACTIVE_LLM;
  if (!cfg.key) throw new Error("API key not configured");

  if (cfg.provider === "openai" || cfg.provider === "ollama") {
    const isOllama = cfg.provider === "ollama";
    const apiUrl = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
    const headers = { "Content-Type": "application/json" };
    if (!isOllama) headers.Authorization = `Bearer ${cfg.key}`;
    const messages = [{ role: "system", content: systemPrompt }, ...chatMessages];
    const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify({ model: cfg.model, messages, max_tokens: 4096, temperature: 0.7 }) });
    if (!res.ok) throw new Error(`${cfg.provider} ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  if (cfg.provider === "gemini") {
    const geminiMessages = chatMessages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const reqBody = { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: geminiMessages, generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
  }

  if (cfg.provider === "claude") {
    const claudeMessages = chatMessages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    const reqBody = { model: cfg.model, system: systemPrompt, max_tokens: 4096, temperature: 0.7, messages: claudeMessages };
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify(reqBody) });
    if (!res.ok) throw new Error(`claude ${res.status}`);
    const data = await res.json();
    return (data.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
  }

  throw new Error(`Unknown provider: ${cfg.provider}`);
}

// ─── Parse LLM response ───────────────────────────────────────────────────
function parseResponse(raw) {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) {
    return { text: raw.trim(), modifiedSchedule: null, changes: null };
  }
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

// ─── Diff helper: identify which slots changed ────────────────────────────
function computeSlotDiff(oldSchedule, newSchedule, changes) {
  const added = new Set();
  const removed = new Set();

  if (changes) {
    for (const c of changes) {
      if (c.action === "removed" && c.oldName) removed.add(c.oldName);
      if (c.action === "replaced") {
        if (c.oldName) removed.add(c.oldName);
        if (c.newName) added.add(c.newName);
      }
      if (c.action === "timeShift" && c.oldName) added.add(c.oldName);
    }
  }

  const oldNames = new Set(oldSchedule.map((s) => s.name));
  const newNames = new Set(newSchedule.map((s) => s.name));
  for (const s of newSchedule) {
    if (!oldNames.has(s.name)) added.add(s.name);
  }
  for (const s of oldSchedule) {
    if (!newNames.has(s.name)) removed.add(s.name);
  }

  return { added, removed };
}

// ─── Badge colors for change actions ──────────────────────────────────────
const ACTION_COLORS = {
  replaced: "var(--mgs-orange)",
  removed: "var(--mgs-red, #e85050)",
  timeShift: "var(--mgs-cyan)",
};

// ─── Main component ───────────────────────────────────────────────────────
export default function CopilotDemo() {
  const [schedule, setSchedule] = useState(INITIAL_SCHEDULE);
  const [removedSlots, setRemovedSlots] = useState([]);
  const [activeDay, setActiveDay] = useState(1);
  const [messages, setMessages] = useState([{ role: "assistant", content: INITIAL_MESSAGE }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState("10:00");
  const [weather, setWeather] = useState("맑음");
  const [changes, setChanges] = useState([]);
  const [slotDiff, setSlotDiff] = useState({ added: new Set(), removed: new Set() });

  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const daySlots = useMemo(() => {
    const active = schedule.filter((s) => s.day === activeDay);
    const removed = removedSlots.filter((s) => s.day === activeDay);
    return [...active, ...removed].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }, [schedule, removedSlots, activeDay]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const systemPrompt = buildSystemPrompt(schedule, currentTime, weather, "도쿄 신주쿠");
      const chatHistory = [...messages.filter((m) => m.role !== "system"), { role: "user", content: text }];
      const apiMessages = chatHistory.map((m) => ({ role: m.role, content: m.content }));
      const raw = await fetchLLM(systemPrompt, apiMessages);
      const parsed = parseResponse(raw);

      setMessages((prev) => [...prev, { role: "assistant", content: parsed.text }]);

      if (parsed.modifiedSchedule && Array.isArray(parsed.modifiedSchedule)) {
        const oldSchedule = schedule;
        const diff = computeSlotDiff(oldSchedule, parsed.modifiedSchedule, parsed.changes);
        setSlotDiff(diff);

        const removedNames = diff.removed;
        const newRemoved = oldSchedule.filter((s) => removedNames.has(s.name));
        setRemovedSlots(newRemoved);

        setSchedule(parsed.modifiedSchedule);
        if (parsed.changes) setChanges(parsed.changes);
      }
    } catch (err) {
      console.error("[CopilotDemo] LLM error:", err);
      setMessages((prev) => [...prev, { role: "assistant", content: `❌ LLM 요청 실패: ${err.message}\n\nAPI 키가 설정되어 있는지 확인해주세요. (${ACTIVE_LLM.provider} / ${ACTIVE_LLM.model})` }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, schedule, currentTime, weather]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const slotEmoji = (slot) => {
    if (slot.type === "lodging") return "🏨";
    if (slot.indoor) return "🏛️";
    return "🌿";
  };

  const activityIndex = useMemo(() => {
    let idx = 0;
    const map = {};
    for (const s of schedule.filter((s) => s.day === activeDay)) {
      if (s.type === "activity") {
        idx++;
        map[s.id] = idx;
      }
    }
    return map;
  }, [schedule, activeDay]);

  const isRemoved = (slot) => slotDiff.removed.has(slot.name);
  const isAdded = (slot) => slotDiff.added.has(slot.name);

  return (
    <div className="copilot-demo">
      {/* Header */}
      <header className="copilot-demo__header">
        <span className="copilot-demo__header-icon">🤖</span>
        <h1 className="copilot-demo__title">AI Co-Pilot Demo</h1>
        <span className="copilot-demo__header-badge">
          {ACTIVE_LLM.label} / {ACTIVE_LLM.model}
        </span>
      </header>

      {/* Main content */}
      <div className="copilot-demo__body">
        {/* Left: Timeline */}
        <div className="copilot-demo__timeline-panel">
          <div className="copilot-demo__panel-title">📋 타임라인</div>

          {/* Day tabs */}
          <div className="copilot-demo__day-tabs">
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                className={`copilot-demo__day-tab ${activeDay === d ? "copilot-demo__day-tab--active" : ""}`}
                onClick={() => setActiveDay(d)}
              >
                Day {d}
              </button>
            ))}
          </div>

          {/* Slot list */}
          <div className="copilot-demo__slot-list">
            {daySlots.map((slot) => {
              const removed = isRemoved(slot);
              const added = isAdded(slot);
              let cls = "copilot-demo__slot";
              if (removed) cls += " copilot-demo__slot--removed";
              if (added) cls += " copilot-demo__slot--added";
              if (slot.locked) cls += " copilot-demo__slot--locked";

              return (
                <div key={slot.id + (removed ? "-rm" : "")} className={cls}>
                  <div className="copilot-demo__slot-time">
                    {slot.startTime}
                  </div>
                  <div className="copilot-demo__slot-marker">
                    {slot.type === "activity" && !removed ? (
                      <span className="copilot-demo__slot-badge">
                        {activityIndex[slot.id] ?? "•"}
                      </span>
                    ) : (
                      <span className="copilot-demo__slot-dot" />
                    )}
                  </div>
                  <div className="copilot-demo__slot-content">
                    <div className="copilot-demo__slot-name">
                      {slotEmoji(slot)} {slot.name}
                    </div>
                    <div className="copilot-demo__slot-meta">
                      {slot.area} · {slot.duration}분
                      {slot.indoor ? " · 실내" : " · 야외"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Changes panel */}
          {changes.length > 0 && (
            <div className="copilot-demo__changes">
              <div className="copilot-demo__changes-title">🔄 변경 내역</div>
              {changes.map((c, i) => (
                <div key={i} className="copilot-demo__change-item">
                  <span
                    className="copilot-demo__change-badge"
                    style={{ background: ACTION_COLORS[c.action] || "var(--mgs-cyan)" }}
                  >
                    {c.action}
                  </span>
                  <span className="copilot-demo__change-text">
                    {c.action === "replaced"
                      ? `${c.oldName} → ${c.newName}`
                      : c.action === "removed"
                      ? c.oldName
                      : `${c.oldName} (시간 조정)`}
                  </span>
                  {c.reason && (
                    <span className="copilot-demo__change-reason">{c.reason}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Chat */}
        <div className="copilot-demo__chat-panel">
          <div className="copilot-demo__panel-title">💬 채팅</div>

          <div className="copilot-demo__messages">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`copilot-demo__msg copilot-demo__msg--${msg.role}`}
              >
                <div className="copilot-demo__msg-bubble">
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
              <div className="copilot-demo__msg copilot-demo__msg--assistant">
                <div className="copilot-demo__msg-bubble copilot-demo__msg-loading">
                  <span className="copilot-demo__dot" />
                  <span className="copilot-demo__dot" />
                  <span className="copilot-demo__dot" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="copilot-demo__input-row">
            <textarea
              ref={inputRef}
              className="copilot-demo__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="돌발 상황을 입력하세요..."
              rows={1}
              disabled={loading}
            />
            <button
              className="copilot-demo__send-btn"
              onClick={handleSend}
              disabled={loading || !input.trim()}
            >
              ▶
            </button>
          </div>
        </div>
      </div>

      {/* Context bar */}
      <footer className="copilot-demo__context-bar">
        <label className="copilot-demo__ctx-label">
          ⏰ 시간:
          <select
            className="copilot-demo__ctx-select"
            value={currentTime}
            onChange={(e) => setCurrentTime(e.target.value)}
          >
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="copilot-demo__ctx-label">
          🌤️ 날씨:
          <select
            className="copilot-demo__ctx-select"
            value={weather}
            onChange={(e) => setWeather(e.target.value)}
          >
            {WEATHER_OPTIONS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.emoji} {w.label}
              </option>
            ))}
          </select>
        </label>
        <span className="copilot-demo__ctx-location">
          📍 위치: 도쿄 신주쿠
        </span>
      </footer>
    </div>
  );
}
