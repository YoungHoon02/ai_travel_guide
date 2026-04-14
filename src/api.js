import { escapeHtml, simulateLLMResponse } from "./utils.js";
import {
  DEST_SYSTEM_PROMPT,
  TRANSPORT_PROMPT,
  LODGING_PROMPT,
  ITINERARY_PROMPT,
  buildRealtimeSystemPrompt,
} from "./prompts/index.js";

// ─── Local JSON DB loader ──────────────────────────────────────────────────────
export async function loadPlansDB() {
  try {
    const r = await fetch("/plans.json");
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── Weather (OpenWeatherMap or simulated) ────────────────────────────────────
export const OWM_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY;
export async function fetchWeather(lat, lng) {
  if (!OWM_KEY) {
    return { description: "맑음 (시뮬)", temp: "21°C", icon: "☀️", humidity: "52%", wind: "3m/s", raw: null };
  }
  const base = import.meta.env.DEV ? "/owm" : "https://api.openweathermap.org";
  try {
    const r = await fetch(
      `${base}/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${OWM_KEY}&units=metric&lang=kr`
    );
    if (!r.ok) throw new Error("owm");
    const d = await r.json();
    const iconMap = { "01": "☀️", "02": "⛅", "03": "☁️", "04": "☁️", "09": "🌧️", "10": "🌦️", "11": "⛈️", "13": "❄️", "50": "🌫️" };
    const code = d.weather?.[0]?.icon?.slice(0, 2) ?? "01";
    return {
      description: d.weather?.[0]?.description ?? "",
      temp: `${Math.round(d.main?.temp ?? 0)}°C`,
      icon: iconMap[code] ?? "🌡️",
      humidity: `${d.main?.humidity ?? "--"}%`,
      wind: `${d.wind?.speed ?? "--"}m/s`,
      raw: d,
    };
  } catch {
    return { description: "날씨 조회 실패", temp: "--", icon: "🌡️", humidity: "--", wind: "--", raw: null };
  }
}

// ─── Google Maps nearby places (New API) ─────────────────────────────────────
export async function fetchNearbyPlaces(lat, lng, type = "tourist_attraction", radius = 1500) {
  if (!window.google?.maps?.places?.Place) return [];
  try {
    const { places } = await window.google.maps.places.Place.searchNearby({
      locationRestriction: { center: { lat, lng }, radius },
      includedPrimaryTypes: [type],
      fields: ["displayName", "formattedAddress", "rating", "currentOpeningHours", "id"],
      maxResultCount: 6,
    });
    return (places ?? []).map((p) => ({
      name: p.displayName, vicinity: p.formattedAddress, rating: p.rating,
      openNow: p.currentOpeningHours?.isOpen?.() ?? null, id: p.id,
    }));
  } catch { return []; }
}

// ─── Google Maps Directions API ──────────────────────────────────────────────
export const GMAPS_TRAVEL_MODE_MAP = {
  public: "TRANSIT", taxi: "DRIVING", car: "DRIVING", walking: "WALKING", bicycle: "BICYCLING",
};

export function fetchGoogleDirections(originLatLng, destLatLng, travelMode = "DRIVING") {
  return new Promise((resolve) => {
    if (!window.google?.maps?.DirectionsService) { resolve(null); return; }
    const svc = new window.google.maps.DirectionsService();
    svc.route(
      {
        origin: { lat: originLatLng[0], lng: originLatLng[1] },
        destination: { lat: destLatLng[0], lng: destLatLng[1] },
        travelMode: window.google.maps.TravelMode[travelMode],
        language: "ko",
      },
      (result, status) => {
        if (status === window.google.maps.DirectionsStatus.OK) {
          const leg = result.routes?.[0]?.legs?.[0];
          resolve({
            duration: leg?.duration?.text ?? null,
            durationSecs: leg?.duration?.value ?? null,
            distance: leg?.distance?.text ?? null,
            steps: (leg?.steps ?? []).slice(0, 5).map((s) => ({
              instruction: escapeHtml((s.instructions ?? "").replace(/<[^>]*>/g, "").slice(0, 80)),
              duration: s.duration?.text ?? "",
              distance: s.distance?.text ?? "",
              travelMode: s.travel_mode ?? travelMode,
            })),
            polylinePath: result.routes?.[0]?.overview_path?.map((p) => [p.lat(), p.lng()]) ?? null,
          });
        } else { resolve(null); }
      }
    );
  });
}

export async function fetchScheduleDirections(schedule, moveId) {
  const travelMode = GMAPS_TRAVEL_MODE_MAP[moveId] ?? "DRIVING";
  if (!window.google?.maps?.DirectionsService || schedule.length < 2) return [];
  const results = await Promise.all(
    schedule.slice(0, -1).map((from, idx) => {
      const to = schedule[idx + 1];
      return fetchGoogleDirections(from.latlng, to.latlng, travelMode).then((dir) =>
        dir ? { fromId: from.id, toId: to.id, fromName: from.name, toName: to.name, ...dir } : null
      );
    })
  );
  return results.filter(Boolean);
}

// ─── Reverse geocode ────────────────────────────────────────────────────────
export function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.Geocoder) { resolve(null); return; }
    new window.google.maps.Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const locality = results[0].address_components?.find((c) => c.types.includes("locality"));
        resolve(locality?.long_name ?? results[0].formatted_address ?? null);
      } else { resolve(null); }
    });
  });
}

// ─── Forward geocode (city name → lat/lng via Google Maps) ───────────────────
export function forwardGeocode(query) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.Geocoder) { resolve(null); return; }
    new window.google.maps.Geocoder().geocode({ address: query }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const loc = results[0].geometry.location;
        resolve([loc.lat(), loc.lng()]);
      } else { resolve(null); }
    });
  });
}

// ─── Place photo (Google Places API New) ─────────────────────────────────────
// maxWidth caps at 4800 on Google side. 1600 gives a sharp hi-res image for
// full-bleed backgrounds without blowing out bandwidth on dest-card grids.
export async function fetchPlacePhoto(query, { maxWidth = 1600 } = {}) {
  if (!window.google?.maps?.places?.Place) return null;
  try {
    const { places } = await window.google.maps.places.Place.searchByText({ textQuery: query, fields: ["photos"], maxResultCount: 1 });
    if (places?.[0]?.photos?.[0]) {
      return places[0].photos[0].getURI({ maxWidth });
    }
  } catch {}
  return null;
}

// ─── OSRM geometry ──────────────────────────────────────────────────────────
export async function fetchOsrmGeometry(fromLatLng, toLatLng, profile) {
  const a = `${fromLatLng[1]},${fromLatLng[0]}`;
  const b = `${toLatLng[1]},${toLatLng[0]}`;
  const base = import.meta.env.DEV ? "/osrm" : "https://router.project-osrm.org";
  const url = `${base}/route/v1/${profile}/${a};${b}?overview=full&geometries=geojson`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const coords = data?.routes?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    return coords.map(([lng, lat]) => [lat, lng]);
  } catch { return null; }
}

// ─── LLM configuration ──────────────────────────────────────────────────────
const LLM_PROVIDER = (import.meta.env.VITE_LLM_PROVIDER || "openai").trim().toLowerCase();
const OLLAMA_URL = (import.meta.env.VITE_OLLAMA_URL || "http://localhost:11434").trim();
const LLM_SETTINGS = {
  openai: { provider: "openai", label: "OpenAI", key: import.meta.env.VITE_OPENAI_API_KEY, model: (import.meta.env.VITE_OPENAI_MODEL || "gpt-4o-mini").trim(), keyEnv: "VITE_OPENAI_API_KEY" },
  gemini: { provider: "gemini", label: "Gemini", key: import.meta.env.VITE_GEMINI_API_KEY, model: (import.meta.env.VITE_GEMINI_MODEL || "gemini-2.5-flash-lite").trim(), keyEnv: "VITE_GEMINI_API_KEY" },
  claude: { provider: "claude", label: "Claude", key: import.meta.env.VITE_CLAUDE_API_KEY, model: (import.meta.env.VITE_CLAUDE_MODEL || "claude-3-5-sonnet-latest").trim(), keyEnv: "VITE_CLAUDE_API_KEY" },
  ollama: { provider: "ollama", label: "Ollama (local)", key: "ollama", model: (import.meta.env.VITE_OLLAMA_MODEL || "bjoernb/gemma4-31b-think").trim(), keyEnv: "VITE_OLLAMA_MODEL" },
};
export const ACTIVE_LLM = LLM_SETTINGS[LLM_PROVIDER] ?? LLM_SETTINGS.openai;

/**
 * Per-function LLM routing.
 *
 * Allows each LLM function to run on a different provider/model via env vars.
 * Motivation: AutoDetect parser needs sub-2s response (cloud flash), while
 * heavy generations (dest, itinerary) can run on local Ollama for privacy and
 * cost. Defaults to ACTIVE_LLM when no override is set.
 *
 * Env var pattern: VITE_{FN}_PROVIDER + VITE_{FN}_MODEL
 *   Fn names: PARSER | GEOGRAPHY | DEST | TRANSPORT | LODGING | ITINERARY | LUCKY | REALTIME
 *
 * Example .env for hybrid mode:
 *   VITE_LLM_PROVIDER=ollama
 *   VITE_OLLAMA_MODEL=gemma4:latest
 *   VITE_PARSER_PROVIDER=gemini
 *   VITE_PARSER_MODEL=gemini-2.5-flash-lite
 *   VITE_GEOGRAPHY_PROVIDER=gemini
 *   VITE_GEOGRAPHY_MODEL=gemini-2.5-flash-lite
 */
function resolveFnConfig(fnName) {
  if (!fnName || fnName === "default") return ACTIVE_LLM;
  const upper = fnName.toUpperCase();
  const providerRaw = import.meta.env[`VITE_${upper}_PROVIDER`];
  const modelRaw = import.meta.env[`VITE_${upper}_MODEL`];
  if (!providerRaw && !modelRaw) return ACTIVE_LLM;
  const providerKey = (providerRaw ?? LLM_PROVIDER).trim().toLowerCase();
  const base = LLM_SETTINGS[providerKey] ?? ACTIVE_LLM;
  return {
    ...base,
    model: modelRaw ? modelRaw.trim() : base.model,
    fnName,
  };
}

function sanitizeGeminiResponse(data) {
  if (!data?.candidates) return data;
  return { ...data, candidates: data.candidates.map((c) => ({ ...c, content: c.content ? { ...c.content, parts: (c.content.parts ?? []).map(({ thoughtSignature, ...rest }) => rest) } : c.content })) };
}


export async function callLLM({ userMessage, plan, currentTime, location, weather, progress, history, directions, onLog }) {
  if (!ACTIVE_LLM.key) {
    const reqLog = { provider: "simulation", model: "rule-based", userMessage, timestamp: new Date().toISOString() };
    await new Promise((r) => setTimeout(r, 700));
    const result = simulateLLMResponse(userMessage, plan, currentTime);
    if (onLog) onLog({ ...reqLog, responseText: result.text, modifiedSchedule: result.modifiedSchedule });
    return result;
  }
  const systemContent = buildRealtimeSystemPrompt({ plan, currentTime, location, weather, progress, directions });
  const chatMessages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: userMessage }];
  let reqBody = null; let resData = null; let raw = "";

  try {
    if (ACTIVE_LLM.provider === "openai" || ACTIVE_LLM.provider === "ollama") {
      const isOllama = ACTIVE_LLM.provider === "ollama";
      const apiUrl = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
      const headers = { "Content-Type": "application/json" };
      if (!isOllama) headers.Authorization = `Bearer ${ACTIVE_LLM.key}`;
      const messages = [{ role: "system", content: systemContent }, ...chatMessages];
      reqBody = { model: ACTIVE_LLM.model, messages, max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error(ACTIVE_LLM.provider);
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (ACTIVE_LLM.provider === "gemini") {
      const geminiMessages = chatMessages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      reqBody = { systemInstruction: { parts: [{ text: systemContent }] }, contents: geminiMessages, generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ACTIVE_LLM.model)}:generateContent?key=${encodeURIComponent(ACTIVE_LLM.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("gemini");
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (ACTIVE_LLM.provider === "claude") {
      const claudeMessages = chatMessages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      reqBody = { model: ACTIVE_LLM.model, system: systemContent, max_tokens: 1200, temperature: 0.7, messages: claudeMessages };
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ACTIVE_LLM.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("claude");
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    }
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
    let modifiedSchedule = null;
    if (jsonMatch) { try { modifiedSchedule = JSON.parse(jsonMatch[1]).modifiedSchedule ?? null; } catch (e) { console.error("[LLM] JSON parse error:", e); } }
    const result = { text: raw.replace(/```json[\s\S]*?```/g, "").trim(), modifiedSchedule };
    const logResData = ACTIVE_LLM.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: ACTIVE_LLM.provider, model: ACTIVE_LLM.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: result.text, modifiedSchedule, timestamp: new Date().toISOString() });
    return result;
  } catch {
    const fallback = simulateLLMResponse(userMessage, plan, currentTime);
    if (onLog) onLog({ provider: ACTIVE_LLM.provider + " (fallback)", model: "rule-based", userMessage, requestBody: reqBody, responseText: fallback.text, modifiedSchedule: fallback.modifiedSchedule, error: true, timestamp: new Date().toISOString() });
    return fallback;
  }
}

// ─── Destination LLM ─────────────────────────────────────────────────────────
// chatHistory: [{role: "user"|"assistant", content: string}, ...]
export async function callDestinationLLM(userMessage, chatHistory, onLog, count = 4) {
  const prefixed = `[${count}개 추천해줘] ${userMessage}`;
  const messages = [...chatHistory, { role: "user", content: prefixed }];
  const timestamp = new Date().toISOString();
  if (!ACTIVE_LLM.key) {
    await new Promise((r) => setTimeout(r, 500));
    const fallback = {
      destinations: [
        { trav_loc: "도쿄 (Tokyo)", trav_loc_sum: "시부야 쇼핑, 아사쿠사 사원, 하라주쿠 트렌드 탐방", trav_loc_reason: "다양한 문화 체험과 맛집이 풍부한 도시", trav_loc_depth: { continent: "아시아", country: "일본", region: "도쿄도", city: "시부야구", detail: "시부야 스크램블 교차로 일대" } },
        { trav_loc: "방콕 (Bangkok)", trav_loc_sum: "왕궁 관광, 카오산로드 야시장, 짜뚜짝 마켓 쇼핑", trav_loc_reason: "가성비 좋은 동남아 대표 여행지", trav_loc_depth: { continent: "아시아", country: "태국", region: "방콕특별시", city: "프라나콘구", detail: "왕궁 및 왓프라깨우 사원 일대" } },
        { trav_loc: "파리 (Paris)", trav_loc_sum: "에펠탑, 루브르 박물관, 몽마르뜨 카페 산책", trav_loc_reason: "예술과 미식의 유럽 대표 도시", trav_loc_depth: { continent: "유럽", country: "프랑스", region: "일드프랑스", city: "파리", detail: "샹젤리제 거리 및 에펠탑 일대" } },
        { trav_loc: "바르셀로나 (Barcelona)", trav_loc_sum: "사그라다 파밀리아, 람블라스 거리, 해변 산책", trav_loc_reason: "건축과 지중해를 동시에 즐기는 도시", trav_loc_depth: { continent: "유럽", country: "스페인", region: "카탈루냐", city: "바르셀로나", detail: "고딕 지구 및 람블라스 거리" } },
      ],
      follow_up_questions: ["여행 기간은 며칠 정도 생각하고 계신가요?", "혼자 여행인가요, 동행이 있나요?", "예산 범위가 어느 정도인가요?"],
    };
    if (onLog) onLog({ provider: "simulation", model: "rule-based", userMessage, requestBody: { messages }, responseText: JSON.stringify(fallback), timestamp });
    return fallback;
  }
  let reqBody = null; let resData = null; let raw = "";
  try {
    if (ACTIVE_LLM.provider === "openai" || ACTIVE_LLM.provider === "ollama") {
      const isOllama = ACTIVE_LLM.provider === "ollama";
      const apiUrl = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
      const headers = { "Content-Type": "application/json" };
      if (!isOllama) headers.Authorization = `Bearer ${ACTIVE_LLM.key}`;
      const apiMsgs = [{ role: "system", content: DEST_SYSTEM_PROMPT }, ...messages];
      reqBody = { model: ACTIVE_LLM.model, messages: apiMsgs, max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error(ACTIVE_LLM.provider);
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (ACTIVE_LLM.provider === "gemini") {
      // Gemini requires alternating user/model roles — merge consecutive same-role messages
      const merged = [];
      for (const m of messages) {
        const role = m.role === "assistant" ? "model" : "user";
        if (merged.length > 0 && merged[merged.length - 1].role === role) {
          merged[merged.length - 1].parts[0].text += "\n" + m.content;
        } else {
          merged.push({ role, parts: [{ text: m.content }] });
        }
      }
      // Gemini must start with user role
      if (merged.length > 0 && merged[0].role === "model") {
        merged.unshift({ role: "user", parts: [{ text: "여행지를 추천해주세요." }] });
      }
      reqBody = { systemInstruction: { parts: [{ text: DEST_SYSTEM_PROMPT }] }, contents: merged, generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json" } };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ACTIVE_LLM.model)}:generateContent?key=${encodeURIComponent(ACTIVE_LLM.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[Gemini Dest]", res.status, errText);
        throw new Error(`gemini ${res.status}: ${errText.slice(0, 300)}`);
      }
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (ACTIVE_LLM.provider === "claude") {
      const claudeMsgs = messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
      reqBody = { model: ACTIVE_LLM.model, system: DEST_SYSTEM_PROMPT, max_tokens: 1500, temperature: 0.7, messages: claudeMsgs };
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ACTIVE_LLM.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("claude");
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    }
    let cleaned = raw.trim();
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1].trim();
    const parsed = JSON.parse(cleaned);
    const logResData = ACTIVE_LLM.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: ACTIVE_LLM.provider, model: ACTIVE_LLM.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: raw, timestamp });
    if (Array.isArray(parsed)) return { destinations: parsed, follow_up_questions: [], raw };
    return { destinations: parsed.destinations ?? [], follow_up_questions: parsed.follow_up_questions ?? [], raw };
  } catch (e) {
    console.error("[Destination LLM] error:", e);
    const logResData = ACTIVE_LLM.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: ACTIVE_LLM.provider + " (error)", model: ACTIVE_LLM.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: raw || e.message, error: true, timestamp });
    return { destinations: [], follow_up_questions: [] };
  }
}

// ─── Generic LLM call (system + user message → JSON response) ────────────────
/**
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {Function} [onLog]
 * @param {string} [fnName] — optional per-function routing key (e.g., "parser",
 *   "dest", "geography"). Looks up VITE_{FN}_PROVIDER/MODEL from env to pick a
 *   different provider/model than the default. See resolveFnConfig.
 */
export async function callGenericLLM(systemPrompt, userMessage, onLog, fnName) {
  const cfg = resolveFnConfig(fnName);
  const timestamp = new Date().toISOString();
  if (!cfg.key) {
    if (onLog) onLog({ provider: "simulation", model: "rule-based", userMessage, timestamp, error: true, responseText: "No API key" });
    return null;
  }
  let reqBody = null; let resData = null; let raw = "";
  try {
    if (cfg.provider === "openai" || cfg.provider === "ollama") {
      const isOllama = cfg.provider === "ollama";
      const apiUrl = isOllama ? `${OLLAMA_URL}/v1/chat/completions` : "https://api.openai.com/v1/chat/completions";
      const headers = { "Content-Type": "application/json" };
      if (!isOllama) headers.Authorization = `Bearer ${cfg.key}`;
      reqBody = { model: cfg.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }], max_tokens: 4096, temperature: 0.7 };
      const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error(cfg.provider);
      resData = await res.json();
      raw = resData.choices?.[0]?.message?.content ?? "";
    } else if (cfg.provider === "gemini") {
      reqBody = { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: "user", parts: [{ text: userMessage }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json" } };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("gemini");
      resData = await res.json();
      raw = (resData.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join("\n");
    } else if (cfg.provider === "claude") {
      reqBody = { model: cfg.model, system: systemPrompt, max_tokens: 4096, temperature: 0.7, messages: [{ role: "user", content: userMessage }] };
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(reqBody) });
      if (!res.ok) throw new Error("claude");
      resData = await res.json();
      raw = (resData.content ?? []).map((item) => item.text).filter(Boolean).join("\n");
    }
    let cleaned = raw.trim();
    const codeBlock = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) cleaned = codeBlock[1].trim();
    const parsed = JSON.parse(cleaned);
    const logResData = cfg.provider === "gemini" ? sanitizeGeminiResponse(resData) : resData;
    if (onLog) onLog({ provider: cfg.provider, model: cfg.model, userMessage, requestBody: reqBody, responseData: logResData, responseText: raw, timestamp, fn: fnName ?? "default" });
    return parsed;
  } catch (e) {
    console.error(`[GenericLLM:${fnName ?? "default"}] error:`, e);
    if (onLog) onLog({ provider: cfg.provider + " (error)", model: cfg.model, userMessage, requestBody: reqBody, responseText: raw || e.message, error: true, timestamp, fn: fnName ?? "default" });
    return null;
  }
}

// ─── Generate transport options ──────────────────────────────────────────────
export async function generateTransports(country, city, days, onLog) {
  const result = await callGenericLLM(TRANSPORT_PROMPT, `${country} ${city} ${days} 여행 시 이동수단 3가지 추천`, onLog, "transport");
  if (Array.isArray(result) && result.length > 0) return result;
  return null; // null = use hardcoded MOVES fallback
}

// ─── Generate lodgings ───────────────────────────────────────────────────────
export async function generateLodgings(country, city, onLog) {
  const result = await callGenericLLM(LODGING_PROMPT, `${country} ${city} 여행 숙소 지역 4곳 추천`, onLog, "lodging");
  if (Array.isArray(result) && result.length > 0) return result;
  return [
    { id: "lodging-1", name: `${city} 중심가 숙소`, summary: "교통 접근성이 좋은 중심지 숙소", area: city },
    { id: "lodging-2", name: `${city} 역세권 숙소`, summary: "역 근처 편리한 위치", area: city },
  ];
}

// ─── Generate hotel insights (pros / cons / tags / price range) ────────────
/**
 * Batch-infer traveler-facing insights for a list of hotels. One LLM call
 * for the whole array — returns per-hotel tags, pros, cons, and an estimated
 * Korean nightly price range. Used by HotelBrowseModal to power filter chips
 * and card descriptions. Tags come from a closed set so the filter UI stays
 * predictable.
 *
 * Returns: [{ id, tags: [string], pros: [string], cons: [string], priceRange: string }]
 * or null on failure (modal just skips the insights row).
 */
export async function generateHotelInsights(hotels, { country, region } = {}, onLog) {
  if (!Array.isArray(hotels) || hotels.length === 0) return null;
  const payload = hotels.slice(0, 20).map((h) => ({
    id: h.id,
    name: h.name,
    address: h.address,
    rating: h.rating ?? null,
    ratingCount: h.ratingCount ?? null,
    priceLevel: h.priceLevel ?? null,
  }));
  const systemPrompt = `You analyze hotels for Korean travelers. For each hotel in the input array, infer realistic traveler-facing insights based on name, location, rating, and price level. Output JSON:

{ "hotels": [{ "id": "...", "tags": ["..."], "pros": ["..."], "cons": ["..."], "priceRange": "..." }] }

Strict rules:
- tags: pick 1-3 from this EXACT closed set — ["역세권", "가성비", "시설좋음", "비즈니스", "럭셔리", "조용함", "관광중심"]. Do NOT invent new tags.
- pros: 2-3 very short Korean phrases (각 12자 이내). Concrete traveler benefits: "역 3분", "조식 포함", "넓은 객실" etc.
- cons: 1-2 very short Korean phrases (각 12자 이내). Honest drawbacks: "방 좁음", "관광지 멀어", "가격대 높음" etc.
- priceRange: estimated Korean nightly range. Format: "n만원대" or "n만원대+" (e.g. "8만원대", "15만원대", "30만원대+")
- Price level inference:
  - PRICE_LEVEL_INEXPENSIVE → 5-10만원대
  - PRICE_LEVEL_MODERATE → 10-20만원대
  - PRICE_LEVEL_EXPENSIVE → 20-35만원대
  - PRICE_LEVEL_VERY_EXPENSIVE → 35만원대+
  - null/missing priceLevel → infer from name & rating
- Brand heuristics (apply when name matches):
  - Toyoko Inn / Dormy Inn / Super Hotel / APA / Route Inn / 비즈니스 → tags include ["가성비", "비즈니스"], pros like ["역 근처", "저렴"], cons include ["방 크기 작음"]
  - Hyatt / Marriott / Hilton / Ritz / Four Seasons / Conrad / Mandarin → tags include ["럭셔리", "시설좋음"], pros ["최고급 시설", "넓은 객실"], cons ["가격대 높음"]
  - Hostel / Guesthouse → tags ["가성비"], pros ["저렴"], cons ["사생활 제한"]
- 역세권 tag: only if name or address clearly suggests station proximity (contains 역/Station/駅 nearby, or business chain brand).
- Return the hotels in the SAME order and with the SAME id strings as the input.`;

  const userMessage = `Country: ${country || "?"}, Region: ${region || "?"}\n\nHotels:\n${JSON.stringify(payload, null, 2)}`;
  const result = await callGenericLLM(systemPrompt, userMessage, onLog, "hotel_insights");
  if (!result) return null;
  const list = Array.isArray(result) ? result : result.hotels;
  return Array.isArray(list) ? list : null;
}

// ─── Generate complete itinerary (spots pre-assigned to days) ────────────────
export async function generateItinerary(country, city, tags, days, transportName, onLog) {
  const dayCount = parseInt(days) || 3;
  const tagStr = tags.length > 0 ? tags.join(", ") : "전체";
  const msg = `${country} ${city} ${dayCount - 1}박${dayCount}일 여행 일정 생성.\n선호 성향: ${tagStr}\n이동수단: ${transportName}\n${dayCount}일간의 완벽한 일정을 만들어줘.`;
  const result = await callGenericLLM(ITINERARY_PROMPT, msg, onLog, "itinerary");
  if (result?.days && result.days.length > 0) return result;
  return null;
}
