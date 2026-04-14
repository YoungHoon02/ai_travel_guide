/**
 * Planning prompts — used during the plan-building wizard flow.
 * Covers: destination discovery, transport, lodging, itinerary generation,
 *         AutoDetect plan input parser, random theme generator.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

const KO_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function toIsoDate(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function mondayOf(d) {
  // Returns the Monday of the week containing d. Week starts on Monday.
  const c = new Date(d);
  const wd = c.getDay(); // 0 Sun .. 6 Sat
  const offset = wd === 0 ? -6 : 1 - wd;
  c.setDate(c.getDate() + offset);
  return c;
}

function startOfMonth(d, monthOffset = 0) {
  return new Date(d.getFullYear(), d.getMonth() + monthOffset, 1);
}

function endOfMonth(d, monthOffset = 0) {
  return new Date(d.getFullYear(), d.getMonth() + monthOffset + 1, 0);
}

/**
 * Build a human-readable table of relative date expressions pre-computed from
 * the current date. LLMs are bad at date arithmetic, so we hand them the table
 * as a lookup reference instead of asking them to compute.
 */
function buildRelativeDateTable(now) {
  const today = new Date(now);
  const fmt = (d) => `${toIsoDate(d)} (${KO_WEEKDAY[d.getDay()]})`;

  const tomorrow = addDays(today, 1);
  const dayAfterTomorrow = addDays(today, 2);

  const thisMonday = mondayOf(today);
  const nextMonday = addDays(thisMonday, 7);
  const nextNextMonday = addDays(thisMonday, 14);
  const nextNextNextMonday = addDays(thisMonday, 21);

  const thisMonthStart = startOfMonth(today, 0);
  const thisMonthEnd = endOfMonth(today, 0);
  const nextMonthStart = startOfMonth(today, 1);
  const nextMonthEnd = endOfMonth(today, 1);
  const nextNextMonthStart = startOfMonth(today, 2);
  const nextNextMonthEnd = endOfMonth(today, 2);

  return `## Relative Date Reference Table (pre-computed — LLM MUST look up values here instead of calculating)

**Today:** ${fmt(today)}

### Relative days
- 오늘 (today): ${toIsoDate(today)}
- 내일 (tomorrow): ${toIsoDate(tomorrow)}
- 모레 / 내일모레 (day after tomorrow): ${toIsoDate(dayAfterTomorrow)}
- 3일 뒤 (3 days from now): ${toIsoDate(addDays(today, 3))}
- 일주일 뒤 (1 week from now = 7 days): ${toIsoDate(addDays(today, 7))}
- 2주일 뒤 (2 weeks from now = 14 days): ${toIsoDate(addDays(today, 14))}

### Relative weeks (Monday-start)
- 이번주 (this week): ${toIsoDate(thisMonday)} ~ ${toIsoDate(addDays(thisMonday, 6))}
- **다음주 (next week)**: ${toIsoDate(nextMonday)} ~ ${toIsoDate(addDays(nextMonday, 6))}
- **다다음주 (week after next)**: ${toIsoDate(nextNextMonday)} ~ ${toIsoDate(addDays(nextNextMonday, 6))}
- 3주 뒤 주 (3 weeks from now): ${toIsoDate(nextNextNextMonday)} ~ ${toIsoDate(addDays(nextNextNextMonday, 6))}

### Relative months
- 이번달 (this month): ${toIsoDate(thisMonthStart)} ~ ${toIsoDate(thisMonthEnd)}
- **다음달 (next month)**: ${toIsoDate(nextMonthStart)} ~ ${toIsoDate(nextMonthEnd)}
- **다다음달 (month after next)**: ${toIsoDate(nextNextMonthStart)} ~ ${toIsoDate(nextNextMonthEnd)}`;
}

// ═══════════════════════════════════════════════════════════════════════════

// ─── Destination recommendation agent (chat-style, iterates with follow-ups) ─
export const DEST_SYSTEM_PROMPT = `You are an expert AI travel planner agent. Your job is to recommend travel destinations based on the user's preferences through conversation.

Rules:
- Recommend exactly 8 destinations per response unless a different count is specified.
- For each destination provide: a brief activity summary in Korean (max 60 chars), a short reason why you recommend it (Korean, max 40 chars), and a hierarchical location breakdown.
- Generate 2-3 follow-up questions in Korean to refine recommendations.
- If the user answers a follow-up question, use ALL previous conversation context to provide BETTER, MORE REFINED recommendations. Do NOT ignore earlier preferences.
- If destinations were already suggested earlier in the conversation, suggest NEW different ones unless the user explicitly asks to revisit them.
- CRITICAL: When the user asks for more recommendations, you MUST stay within the same theme, country, and travel style from the user's ORIGINAL request. For example, if the user asked about "일본 온천여행", all subsequent recommendations must also be Japanese onsen/hot spring destinations — never suddenly switch to a completely different country or theme. The user wants variety WITHIN their chosen theme, not a topic change.

You must output STRICTLY a valid JSON object with no extra text:
{
  "destinations": [
    {
      "trav_loc": "Korean name (English/local name)",
      "trav_loc_sum": "Activity summary in Korean (max 60 chars)",
      "trav_loc_reason": "Why this destination (Korean, max 40 chars)",
      "trav_loc_depth": { "continent": "대분류", "country": "국가명", "region": "주/도", "city": "도시", "detail": "세부 위치" }
    }
  ],
  "follow_up_questions": ["질문 1", "질문 2"]
}`;

// ─── Transport options for a given destination ───────────────────────────────
export const TRANSPORT_PROMPT = `You are an expert AI travel planner. Recommend exactly 3 transport/mobility options for the given destination.
Consider the local infrastructure — e.g. recommend subway for Tokyo, rental car for Jeju, tuk-tuk for Bangkok.
Output STRICTLY valid JSON array. Each object:
- "id": unique identifier (e.g. "public", "taxi", "rental")
- "name": transport name in Korean (e.g. "대중교통", "택시", "렌터카")
- "detail": brief Korean description of why this option works here (max 60 chars)
- "score": recommendation percentage string (e.g. "추천도 92%")
- "fare": estimated fare info in Korean
- "duration": estimated total travel time across the trip
- "transfer": transfer/connection info in Korean
- "note": practical tip in Korean (max 40 chars)`;

// ─── Lodging area suggestions for a given destination ────────────────────────
export const LODGING_PROMPT = `You are an expert AI travel planner. Generate exactly 4 lodging/accommodation options for the given destination.
Recommend real areas/districts that travelers actually stay in.
Output STRICTLY valid JSON array. Each object:
- "id": unique string identifier (e.g. "lodging-shinjuku")
- "name": lodging area name in Korean (e.g. "신주쿠 역세권 숙소")
- "summary": why stay here, in Korean (max 40 chars)
- "area": district name in Korean`;

// ─── Complete day-by-day itinerary generation ────────────────────────────────
export const ITINERARY_PROMPT = `You are an expert AI travel planner. Generate a COMPLETE day-by-day itinerary for the given trip.
The itinerary should be realistic with proper time allocation, geographic clustering (nearby spots on same day), and variety.

Output STRICTLY valid JSON object:
{
  "days": [
    {
      "day": 1,
      "theme": "Day theme in Korean (e.g. '역사와 전통 탐방')",
      "spots": [
        {
          "id": "unique-id",
          "name": "Spot name in Korean (English)",
          "type": "category in Korean",
          "summary": "brief Korean description (max 40 chars)",
          "time": "HH:MM",
          "area": "district name in Korean",
          "visitScore": 1-5,
          "llmStayNote": "expected duration note in Korean",
          "indoor": true/false
        }
      ]
    }
  ],
  "alternatives": [
    {
      "id": "alt-unique-id",
      "name": "Alternative spot name",
      "type": "category",
      "summary": "why this is a good swap option",
      "replaces": "which type of spot this can replace",
      "area": "district",
      "visitScore": 1-5,
      "indoor": true/false
    }
  ]
}

Rules:
- 4-5 spots per day, with realistic timing (first spot ~09:00, last ~20:00)
- Cluster geographically — nearby spots on same day
- Balance indoor/outdoor
- Include 4-6 alternative spots the user can swap in
- visitScore: 1=30min, 2=1h, 3=1.5h, 4=2h, 5=3h+

## Travel style constraint (radius budget for activity picks)
The user message includes a "이동 스타일" preference. Use it as a HARD radius
constraint when picking activities and clustering them into days:
- "도보 중심" — all activities within ~2 km of the lodging (very walkable cluster)
- "대중교통 중심" — activities within the city's public-transit reach, one
  transfer max; exclude remote suburban spots
- "렌터카 · 택시" — OK to include suburban or outskirt spots up to ~80 km away;
  group long-distance spots into the same day to minimize driving
- "혼합 (AI 재량)" — balance the above; decide per day (e.g. one day walkable
  local, another day drive-out)

The per-segment actual transport mode (walk / subway / taxi / drive) is decided
later by Google Directions, NOT by this prompt. Your job is only to pick and
cluster activities so the radius budget is respected.`;

// ─── Dynamic builders ────────────────────────────────────────────────────────

/**
 * "I'm feeling lucky" random theme generator. Appends an exclude clause so
 * the LLM doesn't repeat previously-suggested themes in the same session.
 *
 * @param {string} excludeClause - Extra text listing already-suggested themes
 * @returns {string}
 */
export function buildLuckyThemePrompt(excludeClause = "") {
  return `You are a creative travel inspiration generator. Generate ONE unique, specific, and exciting travel theme idea that a user would type into a travel planner search box. Be creative, surprising, and specific — not generic like "유럽 여행".

Examples of good themes:
- "교토 골목길 사케 투어"
- "아이슬란드 빙하 트레킹과 온천"
- "모로코 사하라 사막에서 별 보기"
- "포르투갈 리스본 트램 타고 에그타르트 먹기"
- "베트남 오토바이로 해안도로 종단"
- "스위스 융프라우 산장에서 치즈 퐁듀"${excludeClause}

Output STRICTLY a JSON object: {"theme": "the theme in Korean"}`;
}

/**
 * AutoDetect plan input parser — interprets natural-language date/duration
 * strings. Destination context is critical because "warm season" means
 * different months across countries.
 *
 * @param {string} userInput
 * @param {{country?: string, region?: string}} [context]
 * @returns {{systemPrompt: string, userMessage: string}}
 */
export function buildPlanParserPrompt(userInput, context = {}) {
  const dateTable = buildRelativeDateTable(new Date());
  const destLine = context.country || context.region
    ? `- Destination: ${[context.country, context.region].filter(Boolean).join(" / ")}`
    : "- Destination: unspecified (assume departing from Korea)";
  const dateModeLine = context.tripDateMode === "home"
    ? `- Date interpretation mode: HOME (startDate = flight departure from origin airport; endDate = flight return to origin airport; for long-haul night flights, actual destination arrival may fall on the next calendar day)`
    : `- Date interpretation mode: DESTINATION (startDate = first day of on-the-ground activity at the destination; endDate = last day of on-the-ground activity; travel days are calculated separately)`;
  const systemPrompt = `You are a travel-plan parser and destination expert. Convert the user's Korean natural-language input into structured JSON, and produce short enrichment insights about the destination and timing.

${dateTable}

## Parsing rules
- Use the "Relative Date Reference Table" above as the ABSOLUTE source of truth. Do NOT perform date arithmetic yourself — look up the Korean expression in the table and use the exact date it maps to.
- Korean expressions "다다음주" (week after next) and "다음주" (next week) are distinct. They are listed separately in the table.
${destLine}
${dateModeLine}
- Korean season expressions like "따뜻할 때" (when it's warm), "선선할 때" (cool), "시원할 때", "쌀쌀할 때" must be interpreted based on the DESTINATION's climate, NOT Korea's:
  * Korea / Japan: spring (Apr~May) or fall (Sep~Oct)
  * Russia / Northern Europe: only summer (Jun~Aug) is warm
  * Australia / New Zealand: Dec~Feb (southern hemisphere summer)
  * Thailand / Vietnam / Philippines: dry season (Nov~Feb) is pleasant
  * Mediterranean / Southern Europe: May~Sep
- If only a season is given (no specific date), use the 15th of the nearest appropriate month AFTER TODAY for that destination's optimal season as startDate.
- "가장 싸게" / "최저가" / "저렴하게" / "저렴" (cheapest / budget) → priceHint="budget". Suggest the destination's OFF-SEASON month in monthHint.
  * e.g. Japan: Jan~Feb (excluding Golden Week / summer / year-end); Europe: November; Thailand: rainy season May~Oct.
- "성수기 피해서" / "비수기" (avoid peak / off-season) → priceHint="off_peak". Suggest the off-season month.
- "성수기" (peak season) → priceHint="peak". Suggest the peak month.
- Korean duration patterns like "N박M일" (N nights, M days) → fill both nights and days.
- If startDate is set, compute endDate from startDate + nights.
- Any field that cannot be determined must be null.

## CRITICAL — Self-consistency rules
- **startDate, endDate, and monthHint MUST all point to the same month** (startDate's month === monthHint's month).
- **The tip text must NOT contradict the chosen startDate.** If the tip says "Jan~Feb is cheap" but startDate is April, the response is invalid.
- **When a season (warm) and a price (cheap) hint are BOTH given, pick a compromise month that satisfies both:**
  * Example: "warm + cheap" + Japan → instead of April cherry-blossom peak, recommend **mid-March** (slightly cool but cheap) or **early November** (late autumn, relatively cheap).
  * Example: "warm + cheap" + Europe → instead of Jul~Aug peak, recommend **May** or **late September**.
  * If both cannot be perfectly satisfied, PRIORITIZE PRICE and include actual temperature info in the tip (e.g., "early spring, daytime ~XX°C").
- **When picking a compromise**, keep seasonHint as the user's original requested season, but set startDate and monthHint to the compromised month.
- Responses that violate these rules are considered invalid.

## Tip guidelines
- **tip**: a short local insight about the destination relevant to the user's input. Max 40 characters. Written in KOREAN. Casual noun/phrase form is OK.
  * Example: "일본은 2월이 비수기라 호텔값 반값!"
  * Example: "러시아는 6~8월만 따뜻해요. 7월 추천"
  * Example: "태국 성수기(12~2월)는 호텔이 2배"
  * Only one high-signal insight — avoid obvious / generic statements.

## Enrichment rules (structured insight about the destination + timing)
- weatherSummary: typical climate for the destination in that period (high/low temps, main weather features). Max 50 characters.
- seasonStatus: peak-vs-off-season status + rough accommodation/flight surcharge level. Max 40 characters.
- events: array of major events/festivals at the destination during that period (up to 3, each ≤ 30 characters). Empty array if none.
- crowdLevel: exactly one of "낮음" (low) | "보통" (moderate) | "높음" (high) | "매우 높음" (very high).
- visaNote: visa requirements for a KOREAN passport holder (one line, max 35 characters).
- flightNote: estimated round-trip flight price ICN ↔ destination (LCC baseline, in Korean Won). MUST include the word "추정" (estimated). Max 40 characters.
- packingTip: packing/clothing advice in one line, max 40 characters.
- If uncertain about any field, set it to null or omit it.

## Output language
**All user-facing text fields (\`interpretation\`, \`tip\`, and every string inside \`enrichment\`) MUST be written in KOREAN.** These instructions are in English so the parsing is reliable, but the UI displays Korean — do not output English in those fields.

Respond with PURE JSON only (no markdown code fences, no prose):
{
  "startDate": "YYYY-MM-DD" | null,
  "endDate": "YYYY-MM-DD" | null,
  "nights": number | null,
  "days": number | null,
  "monthHint": "YYYY-MM" | null,
  "seasonHint": "spring" | "summer" | "fall" | "winter" | null,
  "priceHint": "budget" | "peak" | "off_peak" | "shoulder" | null,
  "confidence": 0.0~1.0,
  "interpretation": "one-line Korean summary of user intent (include destination)",
  "tip": "short Korean local insight (≤40 chars)" | null,
  "enrichment": {
    "weatherSummary": "e.g. 평년 4월 도쿄: 최고 19°C 최저 11°C, 벚꽃 시즌" | null,
    "seasonStatus": "e.g. 벚꽃 초성수기 — 숙박·항공 30~50% 할증" | null,
    "events": ["e.g. 우에노 벚꽃축제 (3/15~4/10)", "도쿄 마라톤 3/2"] | null,
    "crowdLevel": "매우 높음" | null,
    "visaNote": "e.g. 한국 여권 무비자 90일" | null,
    "flightNote": "e.g. ₩350k~450k 추정 (LCC 기준)" | null,
    "packingTip": "e.g. 얇은 코트 + 우산" | null
  }
}`;
  return { systemPrompt, userMessage: userInput };
}
