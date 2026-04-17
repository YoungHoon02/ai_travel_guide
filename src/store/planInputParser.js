/**
 * AutoDetect parser for plan date/duration input.
 *
 * Two-stage detection:
 * 1. Local heuristics (regex) — fast, no LLM call for obvious structured input
 * 2. LLM fallback — for natural language / ambiguous input
 *
 * Output shape is always the same, so consumers don't care which path was used.
 *
 * @typedef {Object} ParsedPlanInput
 * @property {"empty" | "structured" | "natural" | "mixed"} mode
 * @property {string | null} startDate    // "YYYY-MM-DD"
 * @property {string | null} endDate
 * @property {number | null} nights
 * @property {number | null} days
 * @property {string | null} monthHint    // "2026-04"
 * @property {string | null} seasonHint   // "spring" | "summer" | "fall" | "winter"
 * @property {string | null} priceHint    // "budget" | "peak" | "off_peak" | "shoulder"
 * @property {number} confidence          // 0..1
 * @property {boolean} requiresLLM        // true if destination context is needed (season/price hints)
 * @property {string} interpretation      // human-readable summary
 * @property {string | null} tip          // LLM-generated short contextual tip (destination-aware)
 * @property {object | null} enrichment   // LLM-generated rich insights (weather/season/events/visa/etc)
 * @property {string} source              // "heuristic" | "llm" | "mixed"
 */

const KOREAN_REGEX = /[\uAC00-\uD7AF]/;
const DIGIT_DATE_REGEX = /^\s*(\d{2,4})[./-](\d{1,2})[./-](\d{1,2})/;
const NIGHTS_REGEX = /(\d+)\s*박\s*(\d+)\s*일/;
const DAYS_ONLY_REGEX = /(\d+)\s*일/;
const MONTH_REGEX = /(\d{1,2})\s*월/;

// Season keywords — DETECTION ONLY (presence triggers requiresLLM).
// We intentionally do NOT map to spring/summer/fall/winter here because the
// correct mapping depends on the destination's climate and hemisphere:
//   "시원할 때" in Korea/Japan  → fall (Sep~Oct)
//   "시원할 때" in Russia       → short summer (Jun~Aug)
//   "따뜻할 때" in Australia    → Dec~Feb (southern hemisphere)
//   "따뜻할 때" in Thailand     → year-round warm, what matters is dry season
// The LLM receives destination context and assigns the final seasonHint.
const SEASON_KEYWORDS = [
  // Spring-ish
  "봄", "따뜻", "따듯", "벚꽃", "꽃구경",
  // Summer-ish
  "여름", "더울", "무더울", "바다", "휴양지",
  // Fall-ish
  "가을", "선선", "시원", "쌀쌀", "서늘", "단풍",
  // Winter-ish
  "겨울", "추울", "눈", "스키", "스노우",
];

// Price keywords — intent IS destination-agnostic ("저렴" always means budget),
// so we CAN set priceHint locally. LLM still resolves the specific month.
// Order matters — longer/more-specific keys must come FIRST (matched before
// shorter keys that would otherwise overshadow them).
const PRICE_MAP = [
  // Peak-explicit first (so "성수기 피해" isn't misread as "성수기")
  { keys: ["성수기 피", "성수기 제외", "비성수기"], value: "off_peak" },
  { keys: ["성수기"], value: "peak" },
  { keys: ["비수기"], value: "off_peak" },
  // Shoulder season
  { keys: ["간절기", "중간 시즌", "어깨 시즌"], value: "shoulder" },
  // Budget — loose prefix-style matching catches 저렴/저렴한/저렴할/저렴하게 etc.
  { keys: ["저렴", "저가", "싸게", "최저가", "가장 싸", "제일 싸", "가성비", "혜자", "알뜰"], value: "budget" },
];

/** @returns {ParsedPlanInput} */
export function emptyParsed() {
  return {
    mode: "empty",
    startDate: null,
    endDate: null,
    nights: null,
    days: null,
    monthHint: null,
    seasonHint: null,
    priceHint: null,
    confidence: 0,
    requiresLLM: false,
    interpretation: "",
    tip: null,
    enrichment: null,
    source: "heuristic",
  };
}

/**
 * Detect which detection mode the input belongs to, WITHOUT running the LLM.
 * Used for UI hints (e.g., show calendar vs show natural-language preview).
 */
export function detectMode(input) {
  const s = (input ?? "").trim();
  if (!s) return "empty";
  if (DIGIT_DATE_REGEX.test(s)) return "structured";
  if (KOREAN_REGEX.test(s)) return "natural";
  if (/^[\d\s./-]+$/.test(s)) return "structured";
  return "natural";
}

/**
 * Pure heuristic parser — no LLM. Catches obvious patterns:
 *   - "2026/04/02"          → start date
 *   - "2026/04/02 ~ 2026/04/05" → start/end
 *   - "3박4일"                → nights + days
 *   - "4월 3박4일"            → month hint + nights/days
 *
 * Returns confidence 0..1. Low confidence means the caller should fall back
 * to the LLM parser for natural language.
 *
 * @param {string} input
 * @returns {ParsedPlanInput}
 */
export function parseHeuristic(input) {
  const s = (input ?? "").trim();
  if (!s) return emptyParsed();

  const result = emptyParsed();
  result.source = "heuristic";
  let score = 0;

  // Explicit date(s): "YYYY/MM/DD", "YY/MM/DD", "YYYY-MM-DD", "YYYY.MM.DD"
  // 2-digit year (e.g. "26") is interpreted as 20XX in toIsoDate.
  const dateMatches = [...s.matchAll(/(\d{2,4})[./-](\d{1,2})[./-](\d{1,2})/g)];
  if (dateMatches.length > 0) {
    const first = dateMatches[0];
    result.startDate = toIsoDate(first[1], first[2], first[3]);
    score += 0.6;
    if (dateMatches.length >= 2) {
      const second = dateMatches[1];
      result.endDate = toIsoDate(second[1], second[2], second[3]);
      score += 0.3;
      const nights = diffDays(result.startDate, result.endDate);
      if (nights != null && nights > 0) {
        result.nights = nights;
        result.days = nights + 1;
      }
    }
  }

  // "N박N일"
  const nightsMatch = s.match(NIGHTS_REGEX);
  if (nightsMatch) {
    result.nights = Number(nightsMatch[1]);
    result.days = Number(nightsMatch[2]);
    score += 0.6;
  } else {
    // Only "N일" (no 박)
    const daysMatch = s.match(DAYS_ONLY_REGEX);
    if (daysMatch && !dateMatches.length) {
      result.days = Number(daysMatch[1]);
      result.nights = Math.max(0, result.days - 1);
      score += 0.3;
    }
  }

  // If we have startDate + nights but no endDate yet, derive it
  if (result.startDate && !result.endDate && result.nights != null && result.nights > 0) {
    result.endDate = addDaysIso(result.startDate, result.nights);
  }

  // Month hint "4월"
  const monthMatch = s.match(MONTH_REGEX);
  if (monthMatch) {
    const month = Number(monthMatch[1]);
    if (month >= 1 && month <= 12) {
      const year = new Date().getFullYear();
      result.monthHint = `${year}-${String(month).padStart(2, "0")}`;
      score += 0.25;
    }
  }

  // Season keyword — DETECTION ONLY. We don't set seasonHint here because the
  // "warm / cool / cold" mapping is destination-dependent (see SEASON_KEYWORDS
  // comment). Just flag requiresLLM so the LLM can resolve with country context.
  for (const kw of SEASON_KEYWORDS) {
    if (s.includes(kw)) {
      result.requiresLLM = true;
      break;
    }
  }

  // Price hint — also destination-dependent (cheap season varies by country).
  for (const entry of PRICE_MAP) {
    if (entry.keys.some((k) => s.includes(k))) {
      result.priceHint = entry.value;
      result.requiresLLM = true;
      break;
    }
  }

  result.confidence = Math.min(1, score);
  result.mode = pickMode(s, result);
  result.interpretation = buildInterpretation(result);
  return result;
}

function pickMode(input, parsed) {
  const hasKorean = KOREAN_REGEX.test(input);
  const hasDate = parsed.startDate != null;
  const hasNights = parsed.nights != null;
  if (hasKorean && hasDate) return "mixed";
  if (hasKorean) return "natural";
  if (hasDate || hasNights) return "structured";
  return "empty";
}

function toIsoDate(y, m, d) {
  const yy = y.length === 2 ? `20${y}` : y;
  return `${yy}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

function diffDays(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86400000);
}

function addDaysIso(iso, days) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function buildInterpretation(p) {
  const parts = [];
  if (p.startDate && p.endDate) parts.push(`${p.startDate} → ${p.endDate}`);
  else if (p.startDate) parts.push(`출발: ${p.startDate}`);
  else if (p.monthHint) parts.push(`${p.monthHint.split("-")[1]}월`);
  if (p.nights != null && p.days != null) parts.push(`${p.nights}박 ${p.days}일`);
  else if (p.days != null) parts.push(`${p.days}일`);
  if (p.seasonHint) parts.push(`(${seasonKo(p.seasonHint)})`);
  if (p.priceHint) parts.push(`[${priceKo(p.priceHint)}]`);
  return parts.join(" · ");
}

function priceKo(s) {
  return { budget: "최저가", peak: "성수기", off_peak: "비수기", shoulder: "간절기" }[s] ?? s;
}

function seasonKo(s) {
  return { spring: "봄", summer: "여름", fall: "가을", winter: "겨울" }[s] ?? s;
}

/**
 * Merge heuristic result + LLM parsed result. LLM takes precedence for
 * fields the heuristic couldn't determine; heuristic wins when confident.
 */
export function mergeParsed(heuristic, llm) {
  if (!llm) return heuristic;
  const merged = { ...heuristic };
  if (!merged.startDate && llm.startDate) merged.startDate = llm.startDate;
  if (!merged.endDate && llm.endDate) merged.endDate = llm.endDate;
  if (merged.nights == null && llm.nights != null) merged.nights = llm.nights;
  if (merged.days == null && llm.days != null) merged.days = llm.days;
  if (!merged.monthHint && llm.monthHint) merged.monthHint = llm.monthHint;
  if (!merged.seasonHint && llm.seasonHint) merged.seasonHint = llm.seasonHint;
  if (!merged.priceHint && llm.priceHint) merged.priceHint = llm.priceHint;
  if (llm.tip) merged.tip = llm.tip;
  if (llm.enrichment) merged.enrichment = llm.enrichment;
  if (llm.interpretation && (!merged.interpretation || heuristic.confidence < 0.5)) {
    merged.interpretation = llm.interpretation;
  }
  merged.confidence = Math.max(heuristic.confidence, llm.confidence ?? 0);
  merged.source = heuristic.confidence >= 0.6 ? "mixed" : "llm";
  return merged;
}

// Re-export the prompt builder from the central prompts module so existing
// imports from this file keep working. New code should import directly from
// `../prompts/index.js`.
export { buildPlanParserPrompt as buildParserPrompt } from "../prompts/index.js";

/**
 * Parse the LLM's JSON response into our ParsedPlanInput shape.
 * Robust to minor formatting slips (markdown code fences, trailing text).
 */
export function parseLLMResponse(responseText) {
  if (!responseText) return null;
  const jsonText = extractJson(responseText);
  if (!jsonText) return null;
  try {
    const obj = JSON.parse(jsonText);
    return {
      mode: "natural",
      startDate: obj.startDate ?? null,
      endDate: obj.endDate ?? null,
      nights: obj.nights ?? null,
      days: obj.days ?? null,
      monthHint: obj.monthHint ?? null,
      seasonHint: obj.seasonHint ?? null,
      priceHint: obj.priceHint ?? null,
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
      requiresLLM: false,
      interpretation: obj.interpretation ?? "",
      tip: obj.tip ?? null,
      enrichment: obj.enrichment ?? null,
      source: "llm",
    };
  } catch {
    return null;
  }
}

function extractJson(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return null;
}
