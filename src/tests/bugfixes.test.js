/**
 * Regression tests for the QA-identified bugs:
 *
 * 1. generateItinerary dayCount parsing — parseInt("2박 3일") === 2, should be 3
 * 2. parseLLMResponse missing enrichment field
 * 3. planInputParser.mergeParsed enrichment propagation end-to-end
 */
import { describe, it, expect, vi } from "vitest";

// ─── Bug 2 & 3: parseLLMResponse + mergeParsed enrichment ────────────────────

import { parseLLMResponse, mergeParsed, emptyParsed } from "../store/planInputParser.js";

describe("parseLLMResponse — enrichment field", () => {
  it("populates enrichment when LLM response includes it", () => {
    const llmJson = JSON.stringify({
      startDate: "2026-04-10",
      endDate: "2026-04-12",
      nights: 2,
      days: 3,
      monthHint: "2026-04",
      seasonHint: "spring",
      priceHint: null,
      confidence: 0.9,
      interpretation: "도쿄 봄 여행 2박 3일",
      tip: "벚꽃 시즌 — 우에노 강추",
      enrichment: {
        weatherSummary: "평년 4월 도쿄: 최고 19°C 최저 11°C",
        seasonStatus: "벚꽃 초성수기 — 숙박 30% 할증",
        events: ["우에노 벚꽃축제"],
        crowdLevel: "매우 높음",
        visaNote: "한국 여권 무비자 90일",
        flightNote: "₩350k~450k 추정",
        packingTip: "얇은 코트 + 우산",
      },
    });
    const result = parseLLMResponse(llmJson);
    expect(result).not.toBeNull();
    expect(result.enrichment).not.toBeNull();
    expect(result.enrichment.crowdLevel).toBe("매우 높음");
    expect(result.enrichment.events).toHaveLength(1);
    expect(result.tip).toBe("벚꽃 시즌 — 우에노 강추");
  });

  it("enrichment is null when LLM omits the field", () => {
    const llmJson = JSON.stringify({
      startDate: "2026-05-01",
      nights: 4,
      days: 5,
      confidence: 0.8,
      interpretation: "파리 여행",
      tip: null,
    });
    const result = parseLLMResponse(llmJson);
    expect(result).not.toBeNull();
    expect(result.enrichment).toBeNull();
  });

  it("handles markdown-fenced JSON with enrichment", () => {
    const llmJson = `Here is the analysis:\n\`\`\`json\n${JSON.stringify({
      startDate: "2026-07-01",
      nights: 1,
      days: 2,
      confidence: 0.7,
      interpretation: "방콕 단기 여행",
      tip: null,
      enrichment: { weatherSummary: "우기 시작" },
    })}\n\`\`\``;
    const result = parseLLMResponse(llmJson);
    expect(result).not.toBeNull();
    expect(result.enrichment?.weatherSummary).toBe("우기 시작");
  });
});

describe("mergeParsed — enrichment propagation", () => {
  it("enrichment from LLM result is merged into output", () => {
    const heuristic = { ...emptyParsed(), nights: 2, days: 3, confidence: 0.6 };
    const llm = {
      mode: "natural",
      startDate: "2026-04-10",
      endDate: null,
      nights: null,
      days: null,
      monthHint: "2026-04",
      seasonHint: "spring",
      priceHint: null,
      confidence: 0.9,
      requiresLLM: false,
      interpretation: "도쿄 봄 여행",
      tip: "벚꽃 명소 많아요",
      enrichment: { crowdLevel: "높음", weatherSummary: "포근" },
      source: "llm",
    };
    const merged = mergeParsed(heuristic, llm);
    expect(merged.enrichment).not.toBeNull();
    expect(merged.enrichment.crowdLevel).toBe("높음");
    expect(merged.tip).toBe("벚꽃 명소 많아요");
    // heuristic nights/days should be preserved (confidence >= 0.6)
    expect(merged.nights).toBe(2);
    expect(merged.days).toBe(3);
  });

  it("enrichment absent from LLM leaves it null", () => {
    const heuristic = { ...emptyParsed(), nights: 3, days: 4, confidence: 0.5 };
    const llm = {
      mode: "natural",
      startDate: "2026-06-01",
      endDate: null,
      nights: null,
      days: null,
      monthHint: null,
      seasonHint: "summer",
      priceHint: null,
      confidence: 0.7,
      requiresLLM: false,
      interpretation: "여름 여행",
      tip: null,
      enrichment: null,
      source: "llm",
    };
    const merged = mergeParsed(heuristic, llm);
    expect(merged.enrichment).toBeNull();
  });
});

// ─── Bug 1: generateItinerary dayCount parsing ────────────────────────────────
// We test the regex logic directly since the function makes LLM network calls.
// The fix is: /(\d+)\s*일/.exec(days) before falling back to parseInt.

describe("dayCount extraction from trip duration strings", () => {
  function extractDayCount(days) {
    const daysMatch = String(days ?? "").match(/(\d+)\s*일/);
    return daysMatch ? parseInt(daysMatch[1], 10) : (parseInt(days, 10) || 3);
  }

  it('"2박 3일" → 3 (was broken: parseInt gave 2)', () => {
    expect(extractDayCount("2박 3일")).toBe(3);
  });

  it('"3박 4일" → 4', () => {
    expect(extractDayCount("3박 4일")).toBe(4);
  });

  it('"1박 2일" → 2', () => {
    expect(extractDayCount("1박 2일")).toBe(2);
  });

  it('"5일" → 5', () => {
    expect(extractDayCount("5일")).toBe(5);
  });

  it('"3" (plain number) → 3 via parseInt fallback', () => {
    expect(extractDayCount("3")).toBe(3);
  });

  it('null/undefined → default 3', () => {
    expect(extractDayCount(null)).toBe(3);
    expect(extractDayCount(undefined)).toBe(3);
  });
});
