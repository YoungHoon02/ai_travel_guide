import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  emptyParsed,
  parseHeuristic,
  buildParserPrompt,
  mergeParsed,
  detectMode,
} from "../store/planInputParser.js";
import { callGenericLLM } from "../api.js";

function recomputeDerived(p) {
  const next = { ...p };
  if (next.startDate && next.endDate) {
    const nights = Math.round((new Date(next.endDate).getTime() - new Date(next.startDate).getTime()) / 86400000);
    if (!Number.isNaN(nights) && nights >= 0) {
      next.nights = nights;
      next.days = nights + 1;
    }
  }
  return next;
}

/**
 * AutoDetect plan input — single textbox that figures out whether the user is
 * entering structured (dates, nights) or natural language, and shows an inline
 * preview of what we understood. Emits structured result via onParsed.
 *
 * Props:
 *   value:       controlled raw string
 *   onChange:    (raw) => void
 *   onParsed:    (ParsedPlanInput) => void — fires whenever parse state changes
 *   onLog:       (log) => void             — forwarded to LLM call for log sidebar
 *   placeholder: optional placeholder override
 */
export default function AutoDetectPlanInput({
  value,
  onChange,
  onParsed,
  onLog,
  context,
  placeholder = "예: 2026/04/02 · 3박4일 · '따뜻할 때 3박4일 가고 싶어'",
}) {
  const [internal, setInternal] = useState(value ?? "");
  const [parsed, setParsed] = useState(emptyParsed());
  const [llmState, setLlmState] = useState("idle"); // idle | detecting | parsed | error
  const debounceRef = useRef(null);
  const requestIdRef = useRef(0);

  // Keep internal state synced when parent controls value
  useEffect(() => {
    if (value != null && value !== internal) setInternal(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const currentMode = useMemo(() => detectMode(internal), [internal]);

  const runLLMParse = useCallback(async (text) => {
    const myReq = ++requestIdRef.current;
    setLlmState("detecting");
    try {
      const { systemPrompt, userMessage } = buildParserPrompt(text, context);
      const result = await callGenericLLM(systemPrompt, userMessage, onLog, "parser");
      if (myReq !== requestIdRef.current) return; // stale
      if (!result || typeof result !== "object") {
        setLlmState("error");
        return;
      }
      const llmParsed = {
        mode: "natural",
        startDate: result.startDate ?? null,
        endDate: result.endDate ?? null,
        nights: result.nights ?? null,
        days: result.days ?? null,
        monthHint: result.monthHint ?? null,
        seasonHint: result.seasonHint ?? null,
        priceHint: result.priceHint ?? null,
        confidence: typeof result.confidence === "number" ? result.confidence : 0.5,
        interpretation: result.interpretation ?? "",
        tip: result.tip ?? null,
        enrichment: result.enrichment ?? null,
        source: "llm",
      };
      const heuristic = parseHeuristic(text);
      const merged = mergeParsed(heuristic, llmParsed);
      setParsed(merged);
      setLlmState("parsed");
      onParsed?.(merged);
    } catch (err) {
      if (myReq !== requestIdRef.current) return;
      console.warn("[AutoDetectPlanInput] LLM parse failed", err);
      setLlmState("error");
    }
  }, [onLog, onParsed, context]);

  const handleChange = useCallback((raw) => {
    setInternal(raw);
    onChange?.(raw);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestIdRef.current++; // invalidate any in-flight LLM request

    if (!raw.trim()) {
      const empty = emptyParsed();
      setParsed(empty);
      setLlmState("idle");
      onParsed?.(empty);
      return;
    }

    // Heuristic runs immediately → instant chip feedback without waiting for LLM
    const heuristic = parseHeuristic(raw);
    setParsed(heuristic);
    onParsed?.(heuristic);

    // LLM always runs in the background after the user pauses typing (1200ms
    // idle). It enriches the heuristic result with destination-aware
    // interpretation, tip, and the full enrichment object (weather, visa, etc).
    setLlmState("detecting");
    debounceRef.current = setTimeout(() => runLLMParse(raw), 1200);
  }, [onChange, onParsed, runLLMParse]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestIdRef.current++;
  }, []);

  return (
    <div className="plan-input">
      <div className={`plan-input__box plan-input__box--${currentMode}`}>
        <span className="plan-input__badge">
          {currentMode === "empty" && "AUTO"}
          {currentMode === "structured" && "NUM"}
          {currentMode === "natural" && "한글"}
        </span>
        <input
          type="text"
          className="plan-input__field"
          value={internal}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
        />
        <span className={`plan-input__status plan-input__status--${llmState}`}>
          {llmState === "idle" && ""}
          {llmState === "detecting" && (
            <span className="plan-input__dots"><span /><span /><span /></span>
          )}
          {llmState === "parsed" && "✓"}
          {llmState === "error" && "!"}
        </span>
      </div>
    </div>
  );
}

// ─── Large preview panel ─────────────────────────────────────────────────────
const TRIP_DATE_MODES = {
  destination: {
    startLabel: "여행 시작",
    endLabel: "여행 끝",
    desc: "여행지에서 활동을 시작하는 첫날 / 마지막날. 이동일은 별도 계산.",
  },
  home: {
    startLabel: "출국일",
    endLabel: "귀국일",
    desc: "본국 공항을 떠나는 날 / 돌아오는 날. 야간편이면 현지 도착이 다음날일 수 있음.",
  },
};

/**
 * Renders the parsed plan input as a wide, readable preview card. Designed
 * for the step0-b showbox. Supports inline date editing + trip-date mode
 * switch + LLM enrichment panel.
 *
 * Props:
 *   parsed:                ParsedPlanInput | null
 *   onParsedChange:        (next) => void — emitted when user edits a field
 *   tripDateMode:          "destination" | "home"
 *   onTripDateModeChange:  (mode) => void
 */
export function PlanInputPreview({ parsed, onParsedChange, tripDateMode = "destination", onTripDateModeChange }) {
  const [editingField, setEditingField] = useState(null);
  const modeConfig = TRIP_DATE_MODES[tripDateMode] ?? TRIP_DATE_MODES.destination;

  if (!parsed || parsed.mode === "empty") {
    return (
      <div className="plan-preview-large plan-preview-large--empty">
        <div className="plan-preview-large__empty-icon">✎</div>
        <p className="plan-preview-large__empty-title">여행 조건을 입력해주세요</p>
        <p className="plan-preview-large__empty-hint">
          좌측 입력창에 자연어 또는 날짜를 입력하면<br />
          AI 가 해석한 결과가 여기에 크게 표시됩니다.
        </p>
      </div>
    );
  }

  const updateField = (field, v) => {
    const next = recomputeDerived({ ...parsed, [field]: v || null, mode: parsed.mode === "empty" ? "structured" : parsed.mode });
    onParsedChange?.(next);
    setEditingField(null);
  };

  const sourceLabel = parsed.source === "heuristic" ? "즉시" : parsed.source === "llm" ? "LLM" : "AUTO";

  return (
    <div className="plan-preview-large">
      <div className="plan-preview-large__header">
        <span className="plan-preview-large__ai-badge">AI 이해</span>
        <TripDateModeSwitch
          mode={tripDateMode}
          onChange={onTripDateModeChange}
        />
        <span className="plan-preview-large__source">{sourceLabel}</span>
      </div>
      <p className="plan-preview-large__interpretation">
        {parsed.interpretation || "해석 대기 중…"}
      </p>

      <div className="plan-preview-large__grid">
        <LargeDateChip
          label={modeConfig.startLabel}
          value={parsed.startDate}
          editing={editingField === "start"}
          onToggle={() => setEditingField(editingField === "start" ? null : "start")}
          onChange={(v) => updateField("startDate", v)}
        />
        <LargeDateChip
          label={modeConfig.endLabel}
          value={parsed.endDate}
          editing={editingField === "end"}
          onToggle={() => setEditingField(editingField === "end" ? null : "end")}
          onChange={(v) => updateField("endDate", v)}
          min={parsed.startDate || undefined}
        />
        <LargeNightsChip
          value={parsed.nights}
          displayText={fmtNightsDays(parsed)}
          editing={editingField === "nights"}
          onToggle={() => setEditingField(editingField === "nights" ? null : "nights")}
          onChange={(n) => {
            const nights = Math.max(0, Math.min(60, Number(n) || 0));
            const patch = { nights, days: nights + 1 };
            if (parsed.startDate) patch.endDate = null;
            const next = { ...parsed, ...patch };
            if (parsed.startDate && nights > 0) {
              const d = new Date(parsed.startDate);
              d.setDate(d.getDate() + nights);
              next.endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            }
            onParsedChange?.(next);
            setEditingField(null);
          }}
        />
        <LargeField label="월 / 계절" value={parsed.monthHint || seasonKo(parsed.seasonHint)} />
      </div>

      {parsed.priceHint && (
        <div className="plan-preview-large__price">
          <span className="plan-preview-large__price-badge">가격 의도</span>
          <span className="plan-preview-large__price-text">{priceKo(parsed.priceHint)}</span>
        </div>
      )}

      <AnimatePresence initial={false}>
        {parsed.tip && (
          <motion.div
            className="plan-preview-large__tip"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.25 }}
          >
            <span className="plan-preview-large__tip-badge">!</span>
            <span className="plan-preview-large__tip-text">{parsed.tip}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <EnrichmentPanel enrichment={parsed.enrichment} />
    </div>
  );
}

function TripDateModeSwitch({ mode, onChange }) {
  return (
    <div className="trip-date-mode" role="group" aria-label="날짜 해석 모드">
      <button
        type="button"
        className={`trip-date-mode__btn${mode === "destination" ? " active" : ""}`}
        onClick={() => onChange?.("destination")}
        title={TRIP_DATE_MODES.destination.desc}
      >
        체류 기준
      </button>
      <button
        type="button"
        className={`trip-date-mode__btn${mode === "home" ? " active" : ""}`}
        onClick={() => onChange?.("home")}
        title={TRIP_DATE_MODES.home.desc}
      >
        항공 기준
      </button>
    </div>
  );
}

function EnrichmentPanel({ enrichment }) {
  if (!enrichment || typeof enrichment !== "object") return null;
  const fields = [
    { key: "weatherSummary", icon: "☀️", label: "평년 날씨" },
    { key: "seasonStatus", icon: "📊", label: "시즌" },
    { key: "crowdLevel", icon: "👥", label: "혼잡도" },
    { key: "visaNote", icon: "🛂", label: "비자" },
    { key: "flightNote", icon: "✈️", label: "항공권", disclaimer: true },
    { key: "packingTip", icon: "🎒", label: "짐 팁" },
  ];
  const events = Array.isArray(enrichment.events) ? enrichment.events.filter(Boolean) : [];
  const hasAny = fields.some((f) => enrichment[f.key]) || events.length > 0;
  if (!hasAny) return null;

  return (
    <motion.div
      className="plan-enrichment"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
    >
      <div className="plan-enrichment__header">
        <span className="plan-enrichment__title">여행 인사이트</span>
        <span className="plan-enrichment__source">AI 추정</span>
      </div>
      <div className="plan-enrichment__grid">
        {fields.map((f) => {
          const v = enrichment[f.key];
          if (!v) return null;
          return (
            <div key={f.key} className="plan-enrichment__item">
              <span className="plan-enrichment__icon" aria-hidden="true">{f.icon}</span>
              <div className="plan-enrichment__body">
                <span className="plan-enrichment__label">{f.label}{f.disclaimer && <span className="plan-enrichment__warn"> · 추정</span>}</span>
                <span className="plan-enrichment__value">{v}</span>
              </div>
            </div>
          );
        })}
      </div>
      {events.length > 0 && (
        <div className="plan-enrichment__events">
          <span className="plan-enrichment__icon" aria-hidden="true">🎉</span>
          <div className="plan-enrichment__body">
            <span className="plan-enrichment__label">현지 이벤트</span>
            <ul className="plan-enrichment__events-list">
              {events.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function LargeField({ label, value }) {
  return (
    <div className="plan-preview-large__chip">
      <span className="plan-preview-large__chip-label">{label}</span>
      <span className="plan-preview-large__chip-value">{value || "—"}</span>
    </div>
  );
}

function LargeDateChip({ label, value, editing, onToggle, onChange, min }) {
  return (
    <div
      className={`plan-preview-large__chip plan-preview-large__chip--editable${editing ? " editing" : ""}`}
      onClick={editing ? undefined : onToggle}
      role="button"
      tabIndex={0}
    >
      <span className="plan-preview-large__chip-label">{label}</span>
      {!editing && <span className="plan-preview-large__chip-edit-icon" aria-hidden="true">✎</span>}
      {editing ? (
        <input
          type="date"
          className="plan-preview-large__date-picker"
          value={value || ""}
          min={min}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => onChange(value || "")}
          onKeyDown={(e) => { if (e.key === "Escape") onToggle(); }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="plan-preview-large__chip-value">{value || "—"}</span>
      )}
    </div>
  );
}

function LargeNightsChip({ value, displayText, editing, onToggle, onChange }) {
  return (
    <div
      className={`plan-preview-large__chip plan-preview-large__chip--editable${editing ? " editing" : ""}`}
      onClick={editing ? undefined : onToggle}
      role="button"
      tabIndex={0}
    >
      <span className="plan-preview-large__chip-label">박일</span>
      {!editing && <span className="plan-preview-large__chip-edit-icon" aria-hidden="true">✎</span>}
      {editing ? (
        <div className="plan-preview-large__nights-edit">
          <input
            type="number"
            min={0}
            max={60}
            className="plan-preview-large__nights-input"
            defaultValue={value ?? ""}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") onToggle();
              if (e.key === "Enter") onChange(e.currentTarget.value);
            }}
            onBlur={(e) => onChange(e.currentTarget.value)}
          />
          <span className="plan-preview-large__nights-suffix">박</span>
        </div>
      ) : (
        <span className="plan-preview-large__chip-value">{displayText || "—"}</span>
      )}
    </div>
  );
}

function fmtNightsDays(p) {
  if (p.nights != null && p.days != null) return `${p.nights}박 ${p.days}일`;
  if (p.days != null) return `${p.days}일`;
  return null;
}

function seasonKo(s) {
  if (!s) return null;
  return { spring: "봄", summer: "여름", fall: "가을", winter: "겨울" }[s] ?? s;
}

function priceKo(s) {
  return { budget: "최저가 지향", peak: "성수기", off_peak: "비수기", shoulder: "간절기" }[s] ?? s;
}
