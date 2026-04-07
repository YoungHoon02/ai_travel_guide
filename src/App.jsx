import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MapContainer, Marker, Polyline, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ─── Local JSON DB loader ──────────────────────────────────────────────────────
async function loadPlansDB() {
  try {
    const r = await fetch("/plans.json");
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ─── Weather (OpenWeatherMap or simulated) ────────────────────────────────────
const OWM_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY;
async function fetchWeather(lat, lng) {
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

// ─── Google Maps nearby places (requires window.google loaded) ────────────────
function fetchNearbyPlaces(lat, lng) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.places) {
      resolve([]);
      return;
    }
    const svc = new window.google.maps.places.PlacesService(document.createElement("div"));
    svc.nearbySearch(
      { location: { lat, lng }, radius: 1500, type: "tourist_attraction" },
      (results, status) => {
        if (status === window.google.maps.places.PlacesServiceStatus.OK) {
          resolve(
            (results ?? []).slice(0, 6).map((p) => ({
              name: p.name,
              vicinity: p.vicinity,
              rating: p.rating,
              id: p.place_id,
            }))
          );
        } else {
          resolve([]);
        }
      }
    );
  });
}

// ─── Reverse geocode via Google Maps (city name) ─────────────────────────────
function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    if (!window.google?.maps?.Geocoder) {
      resolve(null);
      return;
    }
    new window.google.maps.Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const locality = results[0].address_components?.find((c) =>
          c.types.includes("locality")
        );
        resolve(locality?.long_name ?? results[0].formatted_address ?? null);
      } else {
        resolve(null);
      }
    });
  });
}

// ─── LLM call (OpenAI or rule-based simulation) ───────────────────────────────
const OPENAI_KEY = import.meta.env.VITE_OPENAI_API_KEY;

function buildSystemPrompt({ plan, currentTime, location, weather, progress }) {
  const planText = plan
    .map(
      (item) =>
        `DAY${item.assignedDay} ${item.time} [${item.area}] ${item.name} (${item.type}) 체류점수:${item.visitScore}`
    )
    .join("\n");
  const doneNames = progress.done.map((i) => i.name).join(", ") || "없음";
  const remainNames = progress.remaining.map((i) => i.name).join(", ") || "없음";
  return `당신은 AI 여행 도우미입니다. 사용자의 도쿄 2박3일 여행 일정을 실시간으로 관리합니다.

현재 정보:
- 현재 시간: ${currentTime}
- 현재 위치: ${location ?? "위치 미확인"}
- 날씨: ${weather ? `${weather.icon} ${weather.description} ${weather.temp} 습도${weather.humidity} 바람${weather.wind}` : "정보 없음"}
- 완료된 일정: ${doneNames}
- 남은 일정: ${remainNames}

전체 여행 계획:
${planText}

사용자가 변수 상황(늦잠, 날씨, 일정 취소 등)을 알려주면:
1. 상황을 간결히 분석하세요.
2. 영향받는 일정을 파악하세요.
3. 수정된 일정을 제안하고, 마지막에 반드시 아래 JSON 블록을 포함하세요:
\`\`\`json
{"modifiedSchedule":[{"id":"...","name":"...","time":"HH:MM","assignedDay":1,"area":"...","type":"...","visitScore":0},...]}
\`\`\`
수정이 불필요하면 \`{"modifiedSchedule":null}\` 를 출력하세요.
추가 정보가 필요하면 재질문하세요. 항상 한국어로 응답하세요.`;
}

function simulateLLMResponse(userMessage, plan, currentTimeStr) {
  const msg = userMessage;
  const hourMatch = msg.match(/(\d{1,2})\s*시/);
  const mentionedHour = hourMatch ? parseInt(hourMatch[1], 10) : null;

  const isDelay = /늦잠|늦게|늦어|출발|지각|12시|오후|지연/.test(msg);
  const isRain = /비|우천|날씨|폭우|우산/.test(msg);
  const isCancellation = /취소|못|안|빠질|건너|skip/.test(msg);
  const mentionedSpot = plan.find((item) => msg.includes(item.name));

  if (isDelay && mentionedHour !== null) {
    const cutHHMM = `${String(mentionedHour).padStart(2, "0")}:00`;
    const remaining = plan.filter((item) => item.time >= cutHHMM);
    const skipped = plan.filter((item) => item.time < cutHHMM);
    const skippedNames = skipped.map((i) => i.name).join(", ");
    const modifiedSchedule = remaining.length ? remaining : plan;
    return {
      text: `✅ **상황 분석**: 현재 ${mentionedHour}시 출발로 인해 ${skippedNames ? `**${skippedNames}**` : "일부 오전 일정"}은 시간상 불가능합니다.\n\n📋 **수정 제안**: ${cutHHMM} 이후 일정부터 시작합니다. ${remaining.length === 0 ? "남은 일정이 없습니다 — 자유 여행을 즐기세요 😊" : `총 ${remaining.length}개 장소가 유지됩니다.`}`,
      modifiedSchedule,
    };
  }

  if (isRain) {
    const outdoorSpots = plan.filter((item) => !item.indoor);
    const indoorSpots = plan.filter((item) => item.indoor);
    if (outdoorSpots.length === 0) {
      return {
        text: "☔ **날씨 분석**: 현재 일정은 모두 실내 위주입니다. 비가 오더라도 일정 변동 없이 진행 가능합니다!",
        modifiedSchedule: null,
      };
    }
    const outdoorNames = outdoorSpots.map((i) => i.name).join(", ");
    return {
      text: `☔ **날씨 분석**: **${outdoorNames}**는 야외 일정입니다. 비가 올 경우 이동 시 우산 필수이며, 특히 야외 공원·신사는 관람이 불편할 수 있습니다.\n\n💡 **제안**: 실내 일정(${indoorSpots.map((i) => i.name).join(", ")})을 먼저 배치하고, 날씨 호전 시 야외로 이동하는 것을 추천합니다. 일정 순서를 조정할까요?`,
      modifiedSchedule: null,
    };
  }

  if (isCancellation && mentionedSpot) {
    const modified = plan.filter((item) => item.id !== mentionedSpot.id);
    return {
      text: `✅ **${mentionedSpot.name}** 일정을 제거했습니다. 남은 ${modified.length}개 일정으로 여행을 진행합니다. 해당 시간(${mentionedSpot.time})에 주변 장소를 탐방하거나 휴식을 취할 수 있습니다.`,
      modifiedSchedule: modified,
    };
  }

  return {
    text: `🤔 **상황 파악 중**: "${userMessage.slice(0, 40)}..." — 현재 일정(${plan.length}개 장소)을 분석했습니다.\n\n현재 시간 ${currentTimeStr} 기준으로 일정 조정이 필요하신가요? 구체적인 상황을 알려주시면 더 정확한 도움을 드릴 수 있습니다.\n\n예: "늦잠 자서 12시에 출발", "비가 와서 야외 일정 변경", "팀랩 예약 취소"`,
    modifiedSchedule: null,
  };
}

async function callLLM({ userMessage, plan, currentTime, location, weather, progress, history }) {
  if (!OPENAI_KEY) {
    await new Promise((r) => setTimeout(r, 700));
    return simulateLLMResponse(userMessage, plan, currentTime);
  }
  try {
    const systemContent = buildSystemPrompt({ plan, currentTime, location, weather, progress });
    const messages = [
      { role: "system", content: systemContent },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens: 1200, temperature: 0.7 }),
    });
    if (!res.ok) throw new Error("openai");
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/);
    let modifiedSchedule = null;
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        modifiedSchedule = parsed.modifiedSchedule ?? null;
      } catch (e) { console.error("[LLM] JSON parse error:", e); }
    }
    return { text: raw.replace(/```json[\s\S]*?```/g, "").trim(), modifiedSchedule };
  } catch {
    return simulateLLMResponse(userMessage, plan, currentTime);
  }
}

// ─── Utility: parse "HH:MM" to minutes since midnight ────────────────────────
function timeToMinutes(hhmm) {
  const [h, m] = (hhmm ?? "00:00").split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ─── Calculate plan progress based on current time ───────────────────────────
function calcProgress(schedule, currentTimeStr) {
  const nowMins = timeToMinutes(currentTimeStr);
  const done = schedule.filter((item) => timeToMinutes(item.time) < nowMins);
  const remaining = schedule.filter((item) => timeToMinutes(item.time) >= nowMins);
  const next = remaining[0] ?? null;
  return { done, remaining, next, nowMins };
}

const STEP_LABELS = ["계정/플랜", "나라/지역/일정", "여행 성향", "이동 옵션", "숙소 선택", "LLM 컨텐츠", "최종 플랜"];

const RESULT_STEP = 6;
const LAST_WIZARD_STEP = 5;
const STAY_LOAD_TARGET = 36;
const TRAVEL_TAGS = ["역사유적", "쇼핑", "미식", "야경", "자연", "카페투어", "전시체험", "로컬시장"];

const DAY_PIN_COLORS = {
  1: "#2563eb",
  2: "#059669",
  3: "#7c3aed",
};

const LODGINGS = [
  {
    id: "lodging-shinjuku",
    name: "신주쿠 숙소 (베이스)",
    summary: "교통 허브 접근이 좋아 첫 도쿄 여행에 안정적",
    latlng: [35.6912, 139.6998],
    area: "신주쿠",
  },
  {
    id: "lodging-ueno",
    name: "우에노 숙소",
    summary: "박물관·공원 접근이 좋아 오전 일정 시작이 편함",
    latlng: [35.7138, 139.7774],
    area: "우에노",
  },
  {
    id: "lodging-shibuya",
    name: "시부야 숙소",
    summary: "쇼핑·야경 중심 동선에 유리한 트렌디한 베이스",
    latlng: [35.6595, 139.7005],
    area: "시부야",
  },
  {
    id: "lodging-ginza",
    name: "긴자 숙소",
    summary: "미식/비즈니스 중심지로 저녁 일정 마무리가 쉬움",
    latlng: [35.6717, 139.765],
    area: "긴자",
  },
];

function dayNumberIcon(day, num) {
  const bg = DAY_PIN_COLORS[day] || "#3f63ff";
  return L.divIcon({
    className: "leaflet-day-pin",
    html: `<div class="day-pin-inner" style="background:${bg}"><span>${num}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 32],
    popupAnchor: [0, -28],
  });
}

const lodgingMapIcon = L.divIcon({
  className: "leaflet-lodging-pin",
  html: `<div class="lodging-pin-inner" title="숙소"><span aria-hidden="true">🏨</span></div>`,
  iconSize: [48, 48],
  iconAnchor: [24, 46],
  popupAnchor: [0, -40],
});

const SAVED_PLANS = [
  {
    id: "demo-tokyo",
    name: "도쿄 2박3일 · 풀코스",
    meta: "최근 수정 · 동선 최적화됨",
    detail: "아사쿠사→우에노→오다이바까지 데모용 전체 일정",
  },
];

const CONTENTS = [
  { id: "sensoji", name: "센소지 사원", type: "역사 유적", summary: "아침 방문 추천, 전통 골목 연계", time: "09:00", latlng: [35.7148, 139.7967], img: "https://images.unsplash.com/photo-1549693578-d683be217e58?auto=format&fit=crop&w=300&q=70", day: 1, seq: 1, area: "아사쿠사", visitScore: 4, llmStayNote: "예배·둘러보기·사원가 대기행렬까지 약 2~2.5h 상당" },
  { id: "ameyoko", name: "아메요코 시장", type: "쇼핑/로컬", summary: "간식, 로컬 쇼핑, 길거리 음식", time: "10:50", latlng: [35.7099, 139.7741], img: "https://images.unsplash.com/photo-1492571350019-22de08371fd3?auto=format&fit=crop&w=300&q=70", day: 1, seq: 2, area: "우에노", visitScore: 3, llmStayNote: "시장 구경·간식·짧은 쇼핑에 약 1~1.5h" },
  { id: "ueno", name: "우에노 공원", type: "자연/산책", summary: "점심 전후 산책 코스", time: "12:10", latlng: [35.7156, 139.7731], img: "https://images.unsplash.com/photo-1528360983277-13d401cdc186?auto=format&fit=crop&w=300&q=70", day: 1, seq: 3, area: "우에노", visitScore: 3, llmStayNote: "넓은 공원 산책·벤치 휴식 포함 1~1.5h" },
  { id: "tokyo-museum", name: "도쿄국립박물관", type: "역사/전시", summary: "일본문화 핵심 전시", time: "14:00", latlng: [35.7188, 139.7765], img: "https://images.unsplash.com/photo-1518998053901-5348d3961a04?auto=format&fit=crop&w=300&q=70", day: 1, seq: 4, area: "우에노", visitScore: 5, llmStayNote: "전시 동선 길고 해설 위주 시 3h+ 가능 → 5점" },
  { id: "akihabara", name: "아키하바라", type: "쇼핑/서브컬처", summary: "테마샵 탐방 및 저녁 식사", time: "18:30", latlng: [35.6984, 139.7731], img: "https://images.unsplash.com/photo-1480796927426-f609979314bd?auto=format&fit=crop&w=300&q=70", day: 1, seq: 5, area: "아키하바라", visitScore: 4, llmStayNote: "매장 탐방·굿즈 구매에 2h 전후 부담 큼" },
  { id: "meiji", name: "메이지 신궁", type: "역사 유적", summary: "오전 숲길 산책", time: "09:00", latlng: [35.6764, 139.6993], img: "https://images.unsplash.com/photo-1490806843957-31f4c9a91c65?auto=format&fit=crop&w=300&q=70", day: 2, seq: 1, area: "하라주쿠", visitScore: 3, llmStayNote: "참배·숲길 산책 1~1.5h" },
  { id: "takeshita", name: "다케시타 거리", type: "쇼핑/트렌드", summary: "디저트와 스트리트 패션", time: "10:40", latlng: [35.6702, 139.7026], img: "https://images.unsplash.com/photo-1526481280695-3c4696d52e58?auto=format&fit=crop&w=300&q=70", day: 2, seq: 2, area: "하라주쿠", visitScore: 4, llmStayNote: "줄 서는 디저트·골목 쇼핑으로 2h 내외" },
  { id: "omotesando", name: "오모테산도", type: "카페/디자인", summary: "브런치와 편집숍", time: "12:00", latlng: [35.6655, 139.7123], img: "https://images.unsplash.com/photo-1467269204594-9661b134dd2b?auto=format&fit=crop&w=300&q=70", day: 2, seq: 3, area: "오모테산도", visitScore: 3, llmStayNote: "브런치+편집숍 둘러보기 1~1.5h" },
  { id: "shibuya", name: "시부야 스카이", type: "쇼핑/전망", summary: "일몰 시간대 뷰포인트", time: "17:30", latlng: [35.6595, 139.7005], img: "https://images.unsplash.com/photo-1536098561742-ca998e48cbcc?auto=format&fit=crop&w=300&q=70", day: 2, seq: 4, area: "시부야", visitScore: 4, llmStayNote: "입장·전망·굿즈 대기 포함 약 2h" },
  { id: "shinjuku", name: "신주쿠 골든가이", type: "야경/미식", summary: "저녁 바 거리 탐방", time: "20:00", latlng: [35.6938, 139.7046], img: "https://images.unsplash.com/photo-1533929736458-ca588d08c8be?auto=format&fit=crop&w=300&q=70", day: 2, seq: 5, area: "신주쿠", visitScore: 4, llmStayNote: "바 호핑·야경 카페까지 2h 이상 여유 권장" },
  { id: "tsukiji", name: "츠키지 장외시장", type: "미식/로컬", summary: "아침 해산물 브런치", time: "08:30", latlng: [35.6654, 139.7707], img: "https://images.unsplash.com/photo-1544481923-a6918bd997bc?auto=format&fit=crop&w=300&q=70", day: 3, seq: 1, area: "긴자", visitScore: 3, llmStayNote: "시장 돌며 브런치 1~1.5h" },
  { id: "teamlab", name: "팀랩 플래닛", type: "전시/체험", summary: "몰입형 디지털 아트 체험", time: "10:30", latlng: [35.6492, 139.7898], img: "https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=300&q=70", day: 3, seq: 2, area: "토요스", visitScore: 5, llmStayNote: "입장 예약·체험 동선 길면 3h 가깝게 소요" },
  { id: "odaiba", name: "오다이바 해변공원", type: "자연/뷰포인트", summary: "도쿄만 산책과 사진 스팟", time: "13:00", latlng: [35.6298, 139.7753], img: "https://images.unsplash.com/photo-1471623432079-b009d30b6729?auto=format&fit=crop&w=300&q=70", day: 3, seq: 3, area: "오다이바", visitScore: 3, llmStayNote: "산책·촬영 위주 1~1.5h" },
  { id: "ginza", name: "긴자", type: "쇼핑/미식", summary: "기념품 쇼핑 및 디너", time: "17:00", latlng: [35.6717, 139.765], img: "https://images.unsplash.com/photo-1513407030348-c983a97b98d8?auto=format&fit=crop&w=300&q=70", day: 3, seq: 4, area: "긴자", visitScore: 4, llmStayNote: "백화점·디너·쇼핑 2h 전후" },
  { id: "tokyo-station", name: "도쿄역 마루노우치", type: "야경/마무리", summary: "마지막 야경과 귀환 동선", time: "19:30", latlng: [35.6812, 139.7671], img: "https://images.unsplash.com/photo-1554797589-7241bb691973?auto=format&fit=crop&w=300&q=70", day: 3, seq: 5, area: "마루노우치", visitScore: 2, llmStayNote: "야경·사진·짧은 산책 45분~1h" },
];

const METRO_LINES = [
  { id: "ginza", name: "긴자선", color: "#f4b400" },
  { id: "yamanote", name: "야마노테선", color: "#32a852" },
  { id: "hanzomon", name: "한조몬선", color: "#8f6ad8" },
  { id: "yurikamome", name: "유리카모메", color: "#2f9edb" },
  { id: "marunouchi", name: "마루노우치선", color: "#e34d4d" },
];

const LINE_SEQUENCE = ["ginza", "yamanote", "hanzomon", "ginza", "marunouchi", "ginza", "yurikamome", "yurikamome", "ginza", "marunouchi", "yamanote", "ginza", "hanzomon", "ginza"];

const MOVES = [
  {
    id: "public",
    name: "대중교통",
    detail: "JR·지하철·버스 조합, 정시성과 비용 균형",
    score: "추천도 96%",
    line: "긴자선 · 야마노테선 · 유리카모메 등",
    fare: "약 1,980엔~ (3일 통행권 활용 시 절감)",
    duration: "3일 합산 이동 약 4시간 10분",
    transfer: "우에노 · 시부야 · 신바시 등 환승",
    note: "러시아워(07:30~09:30) 구간은 여유 15분 권장",
  },
  {
    id: "taxi",
    name: "택시",
    detail: "문앞 픽업, 짐·동선 부담 최소",
    score: "추천도 78%",
    line: "도로 주행 (데모 시각화)",
    fare: "구간당 약 1,200~3,800엔 (예상)",
    duration: "3일 합산 이동 약 3시간 20분",
    transfer: "환승 없음, 정체 시 시간 변동",
    note: "심야 할증 구간은 LLM이 별도 표기 가능",
  },
  {
    id: "car",
    name: "렌터카",
    detail: "이동 자유도 높음, 주차·ETC 반영",
    score: "추천도 72%",
    line: "간선도로 위주 (데모 시각화)",
    fare: "렌트+주차+연료 약 28,000엔대 (예상)",
    duration: "3일 합산 이동 약 3시간 50분",
    transfer: "주차장 이동 포함",
    note: "도심은 역세권 주차 후 도보 연계 추천",
  },
];

function findDayInBuckets(buckets, id) {
  if (!buckets) return null;
  for (let d = 1; d <= 3; d += 1) {
    if (buckets[d]?.includes(id)) return d;
  }
  return null;
}

function distSq(a, b) {
  const dy = a[0] - b[0];
  const dx = a[1] - b[1];
  return dx * dx + dy * dy;
}

function orderNearestNeighborFrom(spots, originLatLng) {
  if (spots.length === 0) return [];
  const remaining = [...spots];
  const ordered = [];
  let cur = originLatLng;
  while (remaining.length) {
    let bestI = 0;
    let bestD = Infinity;
    remaining.forEach((p, i) => {
      const d = distSq(cur, p.latlng);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    const next = remaining.splice(bestI, 1)[0];
    ordered.push(next);
    cur = next.latlng;
  }
  return ordered;
}

/**
 * 숙소→가까운 순 NN으로 방문 순서를 만든 뒤,
 * LLM 체류 부하(1~5점) 누적이「3일 평균 부하」(총점÷3)에 도달하면 다음 일차로 넘깁니다.
 */
function assignOptimalDays(ids, lodgingLatLng) {
  const spots = ids.map((id) => CONTENTS.find((c) => c.id === id)).filter(Boolean);
  if (spots.length === 0) return { 1: [], 2: [], 3: [] };
  const ordered = orderNearestNeighborFrom(spots, lodgingLatLng);
  const totalScore = ordered.reduce((s, p) => s + (p.visitScore ?? 3), 0);
  const targetPerDay = totalScore / 3;
  const buckets = { 1: [], 2: [], 3: [] };
  let day = 1;
  let daySum = 0;
  for (const p of ordered) {
    const sc = p.visitScore ?? 3;
    if (day < 3 && daySum >= targetPerDay && buckets[day].length > 0) {
      day += 1;
      daySum = 0;
    }
    buckets[day].push(p.id);
    daySum += sc;
  }
  return buckets;
}

function sumVisitScores(ids) {
  return ids.reduce((s, id) => s + (CONTENTS.find((c) => c.id === id)?.visitScore ?? 0), 0);
}

function normalizeSelectionForDemo(ids, targetLoad) {
  const selected = Array.from(new Set(ids)).filter((id) => CONTENTS.some((c) => c.id === id));
  if (!selected.length) return [];

  const scoreById = new Map(CONTENTS.map((c) => [c.id, c.visitScore ?? 0]));
  const selectedSet = new Set(selected);
  let sum = selected.reduce((acc, id) => acc + (scoreById.get(id) ?? 0), 0);

  const remaining = CONTENTS.filter((c) => !selectedSet.has(c.id));

  // 부족하면 목표에 가장 가깝게 수렴하도록 자동 추가
  while (sum < targetLoad && remaining.length) {
    const bestIdx = remaining.reduce((best, cur, idx, arr) => {
      const curDiff = Math.abs(targetLoad - (sum + (cur.visitScore ?? 0)));
      const bestItem = arr[best];
      const bestDiff = Math.abs(targetLoad - (sum + (bestItem.visitScore ?? 0)));
      return curDiff < bestDiff ? idx : best;
    }, 0);
    const pick = remaining.splice(bestIdx, 1)[0];
    selected.push(pick.id);
    sum += pick.visitScore ?? 0;
  }

  // 초과하면 목표에 가깝게 자동 제거(최소 1개는 유지)
  while (sum > targetLoad && selected.length > 1) {
    const removeIdx = selected.reduce((best, id, idx, arr) => {
      const curDiff = Math.abs(targetLoad - (sum - (scoreById.get(id) ?? 0)));
      const bestId = arr[best];
      const bestDiff = Math.abs(targetLoad - (sum - (scoreById.get(bestId) ?? 0)));
      return curDiff < bestDiff ? idx : best;
    }, 0);
    const removed = selected.splice(removeIdx, 1)[0];
    sum -= scoreById.get(removed) ?? 0;
  }

  return selected;
}

function categoriesForContent(content) {
  const text = `${content.type} ${content.summary}`.replace(/\s+/g, "");
  const out = [];
  if (text.includes("역사") || text.includes("유적")) out.push("역사유적");
  if (text.includes("쇼핑") || text.includes("트렌드")) out.push("쇼핑");
  if (text.includes("미식")) out.push("미식");
  if (text.includes("야경") || text.includes("전망")) out.push("야경");
  if (text.includes("자연") || text.includes("산책") || text.includes("뷰포인트")) out.push("자연");
  if (text.includes("카페") || text.includes("브런치") || text.includes("디저트")) out.push("카페투어");
  if (text.includes("전시") || text.includes("체험")) out.push("전시체험");
  if (text.includes("로컬") || text.includes("시장")) out.push("로컬시장");
  return out.length ? out : ["기타"];
}

async function fetchOsrmGeometry(fromLatLng, toLatLng, profile) {
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
  } catch {
    return null;
  }
}

function ScoreStars({ value }) {
  const n = Math.min(5, Math.max(1, Number(value) || 3));
  const percent = (n / 5) * 100;
  return (
    <span className="stamina" title={`LLM 예측 체류 스테미나 ${n}/5`}>
      <span className="stamina-bar">
        <span className="stamina-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="stamina-label">{n}/5</span>
    </span>
  );
}

function osrmProfileForMove(moveId) {
  return moveId === "public" ? "foot" : "driving";
}

const transitionSpring = { type: "spring", stiffness: 280, damping: 30, mass: 0.85 };
const fadeSlide = {
  initial: { opacity: 0, x: 28, filter: "blur(6px)" },
  animate: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: { opacity: 0, x: -22, filter: "blur(4px)" },
};

function StepShell({ stepIndex, title, children, onPrev, onNext, nextDisabled = false, nextLabel }) {
  return (
    <motion.section
      key={stepIndex}
      className="wizard-card"
      variants={fadeSlide}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={transitionSpring}
      layout
    >
      <div className="wizard-top">
        <span className="badge">STEP {stepIndex + 1}</span>
        <h2>{title}</h2>
      </div>
      <div className="wizard-body">{children}</div>
      <div className="wizard-actions">
        {stepIndex > 0 ? (
          <motion.button type="button" className="btn ghost" onClick={onPrev} whileTap={{ scale: 0.98 }}>
            이전
          </motion.button>
        ) : (
          <div />
        )}
        <motion.button
          type="button"
          className="btn primary"
          onClick={onNext}
          disabled={nextDisabled}
          whileTap={{ scale: nextDisabled ? 1 : 0.98 }}
        >
          {nextLabel ?? (stepIndex < LAST_WIZARD_STEP ? "다음" : "완료")}
        </motion.button>
      </div>
    </motion.section>
  );
}

export default function App() {
  const [step, setStep] = useState(0);
  const [selectedPlanId, setSelectedPlanId] = useState("demo-tokyo");

  // ── Local JSON DB ──────────────────────────────────────────────────────────
  const [dbData, setDbData] = useState(null);
  useEffect(() => {
    loadPlansDB().then((data) => {
      if (data) setDbData(data);
    });
  }, []);
  const savedPlans = dbData?.savedPlans ?? SAVED_PLANS;

  const [country, setCountry] = useState("일본");
  const [region, setRegion] = useState("도쿄");
  const [days, setDays] = useState("2박 3일");
  const [tags, setTags] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [selectedSpotIds, setSelectedSpotIds] = useState([]);
  const [optimizedDayPicks, setOptimizedDayPicks] = useState(null);
  const [move, setMove] = useState("public");
  const [selectedLodgingId, setSelectedLodgingId] = useState(LODGINGS[0].id);
  const [mapInfo, setMapInfo] = useState("핀 또는 이동 경로를 클릭하면 해당 일정이 강조됩니다.");
  const [transitPopup, setTransitPopup] = useState(null);
  const [highlightIds, setHighlightIds] = useState([]);
  const [activeCategory, setActiveCategory] = useState("전체");

  // ── Real-time clock ────────────────────────────────────────────────────────
  const [nowDate, setNowDate] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNowDate(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const currentTimeStr = `${String(nowDate.getHours()).padStart(2, "0")}:${String(nowDate.getMinutes()).padStart(2, "0")}`;
  const currentDateStr = nowDate.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

  // ── Browser Geolocation ────────────────────────────────────────────────────
  const [userLocation, setUserLocation] = useState(null);
  const [locationName, setLocationName] = useState(null);
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        const name = await reverseGeocode(loc.lat, loc.lng);
        setLocationName(name);
      },
      () => setUserLocation({ lat: 35.6812, lng: 139.7671 })
    );
  }, []);

  // ── Weather ────────────────────────────────────────────────────────────────
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    if (!userLocation) return;
    fetchWeather(userLocation.lat, userLocation.lng).then(setWeather);
  }, [userLocation]);

  // ── Nearby places (Google Maps) ────────────────────────────────────────────
  const [nearbyPlaces, setNearbyPlaces] = useState([]);
  useEffect(() => {
    if (!userLocation) return;
    const handler = () => {
      fetchNearbyPlaces(userLocation.lat, userLocation.lng).then(setNearbyPlaces);
    };
    if (window.__googleMapsLoaded) handler();
    else window.addEventListener("googlemapsloaded", handler, { once: true });
    return () => window.removeEventListener("googlemapsloaded", handler);
  }, [userLocation]);

  // ── Variable Handler (AI 변수 조치) ─────────────────────────────────────────
  const [showVarHandler, setShowVarHandler] = useState(false);
  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isLLMLoading, setIsLLMLoading] = useState(false);
  const [modifiedSchedule, setModifiedSchedule] = useState(null);

  const moveProfile = MOVES.find((m) => m.id === move);
  const selectedLodging = LODGINGS.find((l) => l.id === selectedLodgingId) ?? LODGINGS[0];

  const requiredStayLoad = STAY_LOAD_TARGET;
  const selectedScoreSum = useMemo(() => sumVisitScores(selectedSpotIds), [selectedSpotIds]);
  const stayLoadRemaining = Math.max(0, requiredStayLoad - selectedScoreSum);

  const liveRoutePreview = useMemo(() => {
    if (selectedSpotIds.length === 0) return null;
    return assignOptimalDays(selectedSpotIds, selectedLodging.latlng);
  }, [selectedSpotIds, selectedLodging]);

  const canNext = useMemo(() => {
    if (step === 0) return Boolean(selectedPlanId);
    if (step === 2) return tags.length > 0;
    if (step === 3) return Boolean(move);
    if (step === 4) return Boolean(selectedLodgingId);
    if (step === 5) return selectedSpotIds.length > 0;
    return true;
  }, [step, selectedPlanId, tags.length, move, selectedLodgingId, selectedSpotIds.length]);

  const pickedContents = useMemo(() => {
    if (!optimizedDayPicks) return [];
    const out = [];
    [1, 2, 3].forEach((d) => {
      optimizedDayPicks[d].forEach((id) => {
        const c = CONTENTS.find((item) => item.id === id);
        if (c) out.push({ ...c, assignedDay: d });
      });
    });
    return out;
  }, [optimizedDayPicks]);

  const spotNumberById = useMemo(() => {
    if (!optimizedDayPicks) return new Map();
    const map = new Map();
    let n = 0;
    [1, 2, 3].forEach((d) => {
      optimizedDayPicks[d].forEach((id) => {
        n += 1;
        map.set(id, n);
      });
    });
    return map;
  }, [optimizedDayPicks]);

  const segmentDefs = useMemo(() => buildMoveSegmentDefs(pickedContents, move), [pickedContents, move]);

  const scheduleByDay = useMemo(() => {
    // When modifiedSchedule is active, use it (it's a flat array with assignedDay)
    if (modifiedSchedule) {
      const days = [1, 2, 3];
      return days
        .map((d) => ({
          day: d,
          items: modifiedSchedule
            .filter((item) => item.assignedDay === d)
            .sort((a, b) => a.time.localeCompare(b.time)),
        }))
        .filter((g) => g.items.length > 0);
    }
    if (!optimizedDayPicks) return [];
    return [1, 2, 3]
      .map((d) => ({
        day: d,
        items: optimizedDayPicks[d].map((id) => {
          const c = CONTENTS.find((item) => item.id === id);
          return c ? { ...c, assignedDay: d } : null;
        }).filter(Boolean),
      }))
      .filter((g) => g.items.length > 0);
  }, [optimizedDayPicks, modifiedSchedule]);

  const groupedPickContents = useMemo(() => {
    const base = recommended.length ? recommended : CONTENTS;
    const selectedOrder = tags.length ? tags : TRAVEL_TAGS;
    const grouped = new Map(selectedOrder.map((tag) => [tag, []]));
    const etc = [];
    base.forEach((item) => {
      const cats = categoriesForContent(item);
      const matched = selectedOrder.find((tag) => cats.includes(tag));
      if (matched) grouped.get(matched).push(item);
      else etc.push(item);
    });
    const groups = selectedOrder
      .map((tag) => ({ tag, items: grouped.get(tag) ?? [] }))
      .filter((g) => g.items.length > 0);
    if (etc.length) groups.push({ tag: "기타", items: etc });
    return groups;
  }, [recommended, tags]);

  useEffect(() => {
    if (!groupedPickContents.length) return;
    const first = groupedPickContents[0].tag;
    setActiveCategory((prev) => (prev === "전체" || groupedPickContents.some((g) => g.tag === prev) ? prev : first));
  }, [groupedPickContents]);

  const visiblePickContents = useMemo(() => {
    if (!groupedPickContents.length) return [];
    if (activeCategory === "전체") return groupedPickContents.flatMap((g) => g.items);
    return groupedPickContents.find((g) => g.tag === activeCategory)?.items ?? [];
  }, [groupedPickContents, activeCategory]);

  const toggleSpotSelection = (id) => {
    setSelectedSpotIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  };

  const dayFromPreview = (id) => findDayInBuckets(liveRoutePreview, id);

  const handleNext = () => {
    if (step === 2 && recommended.length === 0) setRecommended(CONTENTS);
    if (step === LAST_WIZARD_STEP) {
      const normalized = normalizeSelectionForDemo(selectedSpotIds, requiredStayLoad);
      setSelectedSpotIds(normalized);
      setOptimizedDayPicks(assignOptimalDays(normalized, selectedLodging.latlng));
      setStep(RESULT_STEP);
      return;
    }
    if (step < LAST_WIZARD_STEP) setStep((s) => s + 1);
  };

  const handlePrev = () => setStep((s) => Math.max(0, s - 1));

  const restartScenario = () => {
    setStep(0);
    setSelectedSpotIds([]);
    setSelectedLodgingId(LODGINGS[0].id);
    setOptimizedDayPicks(null);
    setHighlightIds([]);
    setTransitPopup(null);
    setMapInfo("핀 또는 이동 경로를 클릭하면 해당 일정이 강조됩니다.");
    setShowVarHandler(false);
    setChatHistory([]);
    setModifiedSchedule(null);
  };

  const toggleTag = (tag) => setTags((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));

  // ── LLM send handler ────────────────────────────────────────────────────────
  const activeSchedule = modifiedSchedule ?? pickedContents;
  const planProgress = useMemo(
    () => calcProgress(activeSchedule, currentTimeStr),
    [activeSchedule, currentTimeStr]
  );

  const handleSendToLLM = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || isLLMLoading) return;
    const userMsg = { role: "user", content: text };
    setChatHistory((h) => [...h, userMsg]);
    setChatInput("");
    setIsLLMLoading(true);
    try {
      const result = await callLLM({
        userMessage: text,
        plan: activeSchedule,
        currentTime: currentTimeStr,
        location: locationName ?? (userLocation ? `${userLocation.lat.toFixed(4)},${userLocation.lng.toFixed(4)}` : null),
        weather,
        progress: planProgress,
        history: chatHistory,
      });
      setChatHistory((h) => [...h, { role: "assistant", content: result.text, modifiedSchedule: result.modifiedSchedule }]);
      if (result.modifiedSchedule && result.modifiedSchedule.length > 0) {
        const enriched = result.modifiedSchedule.map((item) => {
          const original = CONTENTS.find((c) => c.id === item.id);
          // Merge: start with original data (for display fields), then apply LLM-provided scheduling fields
          return original
            ? { ...original, time: item.time, assignedDay: item.assignedDay }
            : item;
        });
        setModifiedSchedule(enriched);
      }
    } finally {
      setIsLLMLoading(false);
    }
  }, [chatInput, isLLMLoading, activeSchedule, currentTimeStr, locationName, userLocation, weather, planProgress, chatHistory]);

  const progressActiveIndex = step >= RESULT_STEP ? STEP_LABELS.length - 1 : step;

  return (
    <div className="app">
      <AnimatePresence mode="wait">
        {step < RESULT_STEP ? (
          <motion.div
            key="wizard"
            className="wizard-wrap"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="header">
              <h1>AI 여행 플래너/가이드</h1>
              <p>2박3일 데모 · 플랜 선택 후 단계별 맞춤 설정</p>
              <div className="progress">
                {STEP_LABELS.map((label, idx) => (
                  <div key={label} className={`dot ${idx <= progressActiveIndex ? "active" : ""}`}>
                    <span>{idx + 1}</span>
                    <small>{label}</small>
                  </div>
                ))}
              </div>
            </header>

            <AnimatePresence mode="wait">
              {step === 0 && (
                <StepShell
                  stepIndex={0}
                  title="저장된 플랜"
                  onPrev={() => {}}
                  onNext={handleNext}
                  nextDisabled={!canNext}
                >
                  <div>
                    <p className="plan-picker-title">플랜 선택</p>
                    <div className="plan-list">
                      {savedPlans.map((plan) => (
                        <button
                          key={plan.id}
                          type="button"
                          className={`plan-card ${selectedPlanId === plan.id ? "active" : ""}`}
                          onClick={() => setSelectedPlanId(plan.id)}
                        >
                          <strong>{plan.name}</strong>
                          <span className="plan-meta">{plan.meta}</span>
                          <p>{plan.detail}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                </StepShell>
              )}

              {step === 1 && (
                <StepShell stepIndex={1} title="나라, 지역, 일정" onPrev={handlePrev} onNext={handleNext} nextDisabled={!country || !region || !days}>
                  <div className="grid-3">
                    <Select label="나라" value={country} onChange={setCountry} options={["일본"]} />
                    <Select label="지역" value={region} onChange={setRegion} options={["도쿄"]} />
                    <Select label="일정" value={days} onChange={setDays} options={["2박 3일"]} />
                  </div>
                </StepShell>
              )}

              {step === 2 && (
                <StepShell stepIndex={2} title="여행 성향 선택" onPrev={handlePrev} onNext={handleNext} nextDisabled={!canNext}>
                  <div className="chip-wrap">
                    {TRAVEL_TAGS.map((tag) => (
                      <button key={tag} type="button" className={`chip ${tags.includes(tag) ? "active" : ""}`} onClick={() => toggleTag(tag)}>
                        {tag}
                      </button>
                    ))}
                  </div>
                  <p className="hint">다채로운 데모를 위해 4개 이상 선택 권장</p>
                </StepShell>
              )}

              {step === 3 && (
                <StepShell stepIndex={3} title="이동 옵션 선택" onPrev={handlePrev} onNext={handleNext} nextDisabled={!canNext}>
                  <div className="content-list">
                    {MOVES.map((item) => (
                      <button key={item.id} type="button" className={`move-card ${move === item.id ? "active" : ""}`} onClick={() => setMove(item.id)}>
                        <strong>{item.name}</strong>
                        <p>{item.detail}</p>
                        <span>{item.score}</span>
                      </button>
                    ))}
                  </div>
                  <p className="hint">다음 단계에서 숙소를 고르고, 그 다음 단계에서 스팟을 선택하면 숙소·좌표 기준으로 동선을 자동 배정합니다.</p>
                </StepShell>
              )}

              {step === 4 && (
                <StepShell stepIndex={4} title="숙소 선택" onPrev={handlePrev} onNext={handleNext} nextDisabled={!canNext}>
                  <div className="content-list">
                    {LODGINGS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`move-card ${selectedLodgingId === item.id ? "active" : ""}`}
                        onClick={() => setSelectedLodgingId(item.id)}
                      >
                        <div>
                          <strong>{item.name}</strong>
                          <p>{item.summary}</p>
                          <span>{item.area}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                  <p className="hint">예시 숙소 4개 중 1개를 선택하면 이후 동선 최적화의 기준점으로 사용됩니다.</p>
                </StepShell>
              )}

              {step === 5 && (
                <StepShell
                  stepIndex={5}
                  title="체류 부하 채우기 · 일자는 자동 배치"
                  onPrev={handlePrev}
                  onNext={handleNext}
                  nextDisabled={!canNext}
                  nextLabel="플랜 완성 보기"
                >
                  <div className="day-picker-intro">
                    <div className={`optimize-banner ${liveRoutePreview ? "optimize-banner--ready" : ""}`}>
                      <strong>체류 부하(1~5점) 균형 · 동선 기준 일자 배정</strong>
                      <p>
                        <strong>클릭 순서는 DAY와 무관합니다.</strong> 숙소(🏨)에서 가까운 순으로 방문 순서를 만든 뒤, 각 장소의{" "}
                        <strong>LLM 예측 체류 점수 합이 3일 평균(총점÷3)에 맞춰지도록</strong> 일자를 나눕니다. 날마다 스팟 개수는 달라질 수 있습니다.
                      </p>
                      <div className="selection-count-bar">
                        <span className="selection-count">
                          체류 합 <strong className="selection-score-sum">{selectedScoreSum}</strong> / {requiredStayLoad}점
                          {liveRoutePreview ? ` (목표/일 ${(selectedScoreSum / 3).toFixed(1)}점)` : ` · 남은 부하 ${stayLoadRemaining}점`}
                        </span>
                        {liveRoutePreview ? <span className="preview-ready-badge">동선·부하 미리보기 반영됨</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="day-slots-overview">
                    {[1, 2, 3].map((d) => {
                      const ids = liveRoutePreview ? liveRoutePreview[d] : [];
                      const filled = ids.length;
                      const dayScore = ids.reduce((s, id) => s + (CONTENTS.find((c) => c.id === id)?.visitScore ?? 0), 0);
                      return (
                        <div key={d} className={`day-slot-column day-slot-column--${d} ${liveRoutePreview ? "has-preview" : ""}`}>
                          <div className="day-slot-column-head">
                            <span>DAY {d}</span>
                            <span className="day-slot-count">
                              {liveRoutePreview ? `${filled}곳 · 부하 ${dayScore}점` : "—"}
                            </span>
                          </div>
                          <div className="day-slot-chips">
                            {liveRoutePreview && filled > 0
                              ? ids.map((id) => {
                                  const spot = CONTENTS.find((c) => c.id === id);
                                  return (
                                    <div key={id} className="day-slot-pill filled">
                                      {spot ? (
                                        <>
                                          <span className="day-slot-pill-name">{spot.name}</span>
                                          <ScoreStars value={spot.visitScore} />
                                        </>
                                      ) : (
                                        id
                                      )}
                                    </div>
                                  );
                                })
                              : Array.from({ length: 2 }).map((_, i) => (
                                  <div key={i} className="day-slot-pill empty">
                                    체류 목표 달성 시 자동 배치
                                  </div>
                                ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="category-tabs">
                    <button
                      type="button"
                      className={`category-tab ${activeCategory === "전체" ? "active" : ""}`}
                      onClick={() => setActiveCategory("전체")}
                    >
                      전체
                    </button>
                    {groupedPickContents.map((group) => (
                      <button
                        key={group.tag}
                        type="button"
                        className={`category-tab ${activeCategory === group.tag ? "active" : ""}`}
                        onClick={() => setActiveCategory(group.tag)}
                      >
                        {group.tag} ({group.items.length})
                      </button>
                    ))}
                  </div>

                  <div className="content-list content-list--pick">
                    {visiblePickContents.map((item) => {
                      const isSelected = selectedSpotIds.includes(item.id);
                      const assigned = dayFromPreview(item.id);
                      const blockNew = false;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          disabled={blockNew}
                          className={`content-card content-card--pick ${isSelected ? "is-spot-selected" : ""} ${assigned ? `picked-on-day picked-on-day-${assigned}` : ""} ${blockNew ? "card-disabled" : ""}`}
                          onClick={() => toggleSpotSelection(item.id)}
                        >
                          <img src={item.img} alt={item.name} />
                          <div>
                            <div className="content-card-title-row">
                              <strong>{item.name}</strong>
                              <ScoreStars value={item.visitScore} />
                            </div>
                            <p>
                              LLM 참고 DAY{item.day} · {item.type} / {item.area}
                            </p>
                            {item.llmStayNote ? <p className="llm-stay-note">{item.llmStayNote}</p> : null}
                            <span>{item.summary}</span>
                            {isSelected && !assigned ? <span className="picked-badge">선택됨</span> : null}
                            {assigned ? (
                              <span className="picked-badge picked-badge--day">
                                자동 배정 DAY{assigned}
                              </span>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <p className="hint">step3에서 선택한 분류 탭으로 콘텐츠를 확인하고, 체류 부하 목표를 채우면 「플랜 완성 보기」로 확정됩니다.</p>
                </StepShell>
              )}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key="result"
            className="result-page"
            initial={{ opacity: 0, y: 28, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          >
            {/* ── Real-time Status Bar ─────────────────────────────────────── */}
            <div className="realtime-bar">
              <span className="realtime-bar__item">
                🕐 <strong>{currentTimeStr}</strong>
                <span className="realtime-bar__sub">{currentDateStr}</span>
              </span>
              <span className="realtime-bar__item">
                📍 {locationName ?? (userLocation ? `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}` : "위치 확인 중…")}
              </span>
              {weather && (
                <span className="realtime-bar__item">
                  {weather.icon} {weather.description} {weather.temp}
                  <span className="realtime-bar__sub">습도 {weather.humidity} · 바람 {weather.wind}</span>
                </span>
              )}
              <span className="realtime-bar__item realtime-bar__progress">
                ✅ 완료 {planProgress.done.length}곳 · 남은 {planProgress.remaining.length}곳
                {planProgress.next && <span className="realtime-bar__sub">다음: {planProgress.next.name} ({planProgress.next.time})</span>}
              </span>
              {modifiedSchedule && (
                <span className="realtime-bar__badge--modified">🔄 AI 수정 일정 적용 중</span>
              )}
            </div>

            <div className="result-layout">
              <aside className="panel sidebar">
                <div className="panel-header">
                  <h3>
                    {country} · {region} · {days}
                  </h3>
                  <p>
                    {moveProfile?.name} · 숙소: {selectedLodging.name}
                  </p>
                </div>
                <div className="panel-body panel-body--schedule">
                  <div className={`lodging-strip ${highlightIds.includes(selectedLodging.id) ? "lodging-strip--highlight" : ""}`}>
                    <span className="lodging-strip-icon" aria-hidden="true">
                      🏨
                    </span>
                    <div>
                      <strong>숙소 (베이스)</strong>
                      <p>{selectedLodging.name} · {selectedLodging.area}</p>
                    </div>
                  </div>
                  <table className="schedule-table">
                    <thead>
                      <tr>
                        <th>DAY</th>
                        <th>시간</th>
                        <th>일정</th>
                        <th>체류</th>
                        <th>이미지</th>
                      </tr>
                    </thead>
                    {scheduleByDay.map((group) => (
                      <tbody key={group.day} className={`schedule-day-group schedule-day-group--${group.day}`}>
                        <tr className="day-separator-row">
                          <td colSpan={5}>
                            <span className="day-separator-label">DAY {group.day}</span>
                          </td>
                        </tr>
                        {group.items.map((p) => {
                          const isDone = planProgress.done.some((d) => d.id === p.id);
                          const isNext = planProgress.next?.id === p.id;
                          return (
                            <tr key={p.id} className={`${highlightIds.includes(p.id) ? "row-highlight" : ""} ${isDone ? "row-done" : ""} ${isNext ? "row-next" : ""}`}>
                              <td>DAY{p.assignedDay}</td>
                              <td>{p.time}</td>
                              <td>
                                {p.name}
                                {isDone && <span className="schedule-done-badge">✓ 완료</span>}
                                {isNext && <span className="schedule-next-badge">▶ 다음</span>}
                                <br />
                                <small>
                                  {p.type} · {p.area}
                                </small>
                                {p.llmStayNote ? (
                                  <small className="schedule-stay-note">{p.llmStayNote}</small>
                                ) : null}
                              </td>
                              <td className="schedule-stay-cell">
                                <ScoreStars value={p.visitScore} />
                              </td>
                              <td>
                                <img className={`thumb ${highlightIds.includes(p.id) ? "thumb-highlight" : ""}`} src={p.img} alt={p.name} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    ))}
                  </table>
                </div>
              </aside>

              <section className="panel map-area">
                <div className="map-top">
                  <h3>지도 · {moveProfile?.name} 경로</h3>
                  <button type="button" className="btn ghost" onClick={restartScenario}>
                    처음부터
                  </button>
                </div>
                <div className="map-box">
                  <MapContainer center={[35.6804, 139.769]} zoom={12} style={{ height: "100%", width: "100%" }}>
                    <TileLayer
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>'
                      url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                    />
                    <Marker
                      key={selectedLodging.id}
                      position={selectedLodging.latlng}
                      icon={lodgingMapIcon}
                      zIndexOffset={800}
                      eventHandlers={{
                        click: () => {
                          setMapInfo(`숙소 · ${selectedLodging.name} — ${selectedLodging.summary}`);
                          setHighlightIds([selectedLodging.id]);
                        },
                      }}
                    >
                      <Popup>{selectedLodging.name}</Popup>
                    </Marker>

                    {pickedContents.map((p) => {
                      const num = spotNumberById.get(p.id) ?? 0;
                      return (
                        <Marker
                          key={p.id}
                          position={p.latlng}
                          icon={dayNumberIcon(p.assignedDay, num)}
                          zIndexOffset={400}
                          eventHandlers={{
                            click: () => {
                              setMapInfo(`DAY${p.assignedDay} · ${num}. ${p.name} — ${p.summary}`);
                              setHighlightIds([p.id]);
                            },
                          }}
                        >
                          <Popup>{p.name}</Popup>
                        </Marker>
                      );
                    })}

                    <RoutedPolylines
                      defs={segmentDefs}
                      moveId={move}
                      onSegmentClick={(segment, e) => {
                        setMapInfo(`${segment.modeLabel} · ${segment.from.name} → ${segment.to.name} (${segment.duration})`);
                        setHighlightIds([segment.from.id, segment.to.id]);
                        setTransitPopup({ position: e.latlng, segment, moveProfile });
                      }}
                    />

                    {transitPopup && moveProfile && (
                      <Popup position={transitPopup.position} eventHandlers={{ remove: () => setTransitPopup(null) }}>
                        <div className="transit-popup-inner">{renderMovePopup(transitPopup.segment, moveProfile)}</div>
                      </Popup>
                    )}
                  </MapContainer>
                  <div className="map-info">{mapInfo}</div>
                  {move === "public" && (
                    <div className="line-legend">
                      {METRO_LINES.map((line) => (
                        <span key={line.id}>
                          <b style={{ background: line.color }} />
                          {line.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* ── AI 변수 조치 Panel ────────────────────────────────────────── */}
            <VariableHandlerPanel
              show={showVarHandler}
              onToggle={() => setShowVarHandler((v) => !v)}
              chatHistory={chatHistory}
              chatInput={chatInput}
              onChatInputChange={setChatInput}
              onSend={handleSendToLLM}
              isLoading={isLLMLoading}
              currentTime={currentTimeStr}
              location={locationName ?? (userLocation ? `${userLocation.lat.toFixed(3)}, ${userLocation.lng.toFixed(3)}` : null)}
              weather={weather}
              progress={planProgress}
              modifiedSchedule={modifiedSchedule}
              onApplyOriginal={() => setModifiedSchedule(null)}
              nearbyPlaces={nearbyPlaces}
              hasGoogleMaps={Boolean(window.__googleMapsLoaded)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function renderMovePopup(segment, moveProfile) {
  const { from, to, duration, lineLabel } = segment;
  return (
    <>
      <strong>{moveProfile.name} 구간 안내</strong>
      <div>
        구간: {from.name} {"→"} {to.name}
      </div>
      <div>예상 소요: {duration}</div>
      <div>경로 유형: {lineLabel}</div>
      <hr className="popup-hr" />
      <div>이동 방식 요약: {moveProfile.detail}</div>
      <div>비용 참고: {moveProfile.fare}</div>
      <div>3일 합산 이동: {moveProfile.duration}</div>
      <div>환승·참고: {moveProfile.transfer}</div>
      <div>안내: {moveProfile.note}</div>
    </>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  );
}

function buildTransitLikeRoute(points, moveId) {
  if (points.length < 2) return points;
  const route = [];
  const bendScale = moveId === "taxi" ? 0.0035 : moveId === "car" ? 0.0052 : 0.0045;

  for (let i = 0; i < points.length - 1; i += 1) {
    const [lat1, lng1] = points[i];
    const [lat2, lng2] = points[i + 1];
    const midLat = (lat1 + lat2) / 2;
    const midLng = (lng1 + lng2) / 2;
    const bend = bendScale * (i + 1);
    const phase = moveId === "car" ? 0.35 : 0.2;

    route.push(
      [lat1, lng1],
      [lat1, midLng - bend],
      [midLat + bend * phase, midLng - bend * (1 + phase)],
      [midLat + bend * 0.5, lng2 + bend * 0.25],
      [lat2, lng2]
    );
  }
  return route;
}

function buildMoveSegmentDefs(contents, moveId) {
  if (contents.length < 2) return [];

  const mode = MOVES.find((m) => m.id === moveId) || MOVES[0];

  return contents.slice(0, -1).map((from, idx) => {
    const to = contents[idx + 1];
    let color;
    let lineLabel;
    let weight = 7;

    if (moveId === "public") {
      const lineId = LINE_SEQUENCE[idx % LINE_SEQUENCE.length];
      const line = METRO_LINES.find((item) => item.id === lineId) || METRO_LINES[0];
      color = line.color;
      lineLabel = `${line.name} 구간 · 보행/도로 경로(근사)`;
    } else if (moveId === "taxi") {
      color = "#ea580c";
      lineLabel = "택시 · 도로 경로 (OSRM)";
      weight = 6;
    } else {
      color = "#1e40af";
      lineLabel = "렌터카 · 도로 경로 (OSRM)";
      weight = 7;
    }

    return {
      id: `${from.id}-${to.id}-${moveId}-${idx}`,
      from,
      to,
      color,
      lineLabel,
      duration: moveId === "taxi" ? `${10 + (idx % 5) * 3}분` : `${12 + (idx % 4) * 4}분`,
      modeLabel: mode.name,
      weight,
    };
  });
}

function RoutedPolylines({ defs, moveId, onSegmentClick }) {
  const [geoms, setGeoms] = useState({});

  useEffect(() => {
    let cancelled = false;
    if (!defs.length) {
      setGeoms({});
      return undefined;
    }
    const seed = Object.fromEntries(defs.map((d) => [d.id, buildTransitLikeRoute([d.from.latlng, d.to.latlng], moveId)]));
    setGeoms(seed);
    const profile = osrmProfileForMove(moveId);
    (async () => {
      const entries = await Promise.all(
        defs.map(async (def) => {
          const g = await fetchOsrmGeometry(def.from.latlng, def.to.latlng, profile);
          return [def.id, g && g.length >= 2 ? g : seed[def.id]];
        })
      );
      if (cancelled) return;
      setGeoms(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [defs, moveId]);

  return (
    <>
      {defs.map((def) => (
        <Polyline
          key={def.id}
          pathOptions={{
            color: def.color,
            weight: def.weight ?? 7,
            opacity: 0.9,
            lineCap: "round",
            lineJoin: "round",
          }}
          positions={geoms[def.id] ?? [def.from.latlng, def.to.latlng]}
          eventHandlers={{
            click: (e) => onSegmentClick(def, e),
          }}
        />
      ))}
    </>
  );
}

// ─── VariableHandlerPanel ────────────────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function renderMarkdownLike(text) {
  return text.split("\n").map((line, i) => {
    const formatted = escapeHtml(line)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
    return <p key={i} dangerouslySetInnerHTML={{ __html: formatted || "&nbsp;" }} style={{ margin: "3px 0" }} />;
  });
}

function VariableHandlerPanel({
  show, onToggle,
  chatHistory, chatInput, onChatInputChange, onSend, isLoading,
  currentTime, location, weather, progress,
  modifiedSchedule, onApplyOriginal,
  nearbyPlaces, hasGoogleMaps,
}) {
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (show) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
      inputRef.current?.focus();
    }
  }, [show, chatHistory.length]);

  const suggestions = [
    "늦잠 자서 12시에 출발하는데 일정 변동 있나요?",
    "비가 오는데 야외 일정 조정해주세요",
    "팀랩 예약이 취소됐어요",
  ];

  return (
    <div className={`var-handler ${show ? "var-handler--open" : ""}`}>
      <button type="button" className="var-handler__toggle" onClick={onToggle}>
        <span className="var-handler__toggle-icon">🤖</span>
        AI 변수 조치 {show ? "▲ 접기" : "▼ 열기"}
        {modifiedSchedule && <span className="var-handler__modified-dot" title="수정된 일정 적용 중" />}
      </button>

      {show && (
        <div className="var-handler__body">
          {/* Context strip */}
          <div className="var-ctx">
            <div className="var-ctx__col">
              <span className="var-ctx__label">현재 시간</span>
              <span className="var-ctx__val">{currentTime}</span>
            </div>
            <div className="var-ctx__col">
              <span className="var-ctx__label">현재 위치</span>
              <span className="var-ctx__val">{location ?? "확인 중…"}</span>
            </div>
            <div className="var-ctx__col">
              <span className="var-ctx__label">날씨</span>
              <span className="var-ctx__val">
                {weather ? `${weather.icon} ${weather.temp} ${weather.description}` : "로딩…"}
              </span>
            </div>
            <div className="var-ctx__col">
              <span className="var-ctx__label">진행 상황</span>
              <span className="var-ctx__val">완료 {progress.done.length} / 남은 {progress.remaining.length}</span>
            </div>
            {modifiedSchedule && (
              <div className="var-ctx__col var-ctx__col--modified">
                <span className="var-ctx__label">일정 상태</span>
                <span className="var-ctx__val">🔄 AI 수정 적용 중 ({modifiedSchedule.length}곳)</span>
                <button type="button" className="var-ctx__revert-btn" onClick={onApplyOriginal}>
                  원래 일정으로
                </button>
              </div>
            )}
          </div>

          {/* Nearby places (Google Maps) */}
          {hasGoogleMaps && nearbyPlaces.length > 0 && (
            <div className="var-nearby">
              <span className="var-nearby__label">📍 현재 위치 주변 (Google Maps)</span>
              <div className="var-nearby__list">
                {nearbyPlaces.map((p, idx) => (
                  <span key={p.id ? `${p.id}-${idx}` : idx} className="var-nearby__chip" title={p.vicinity}>
                    {p.name} {p.rating ? `★${p.rating}` : ""}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Chat history */}
          <div className="var-chat">
            {chatHistory.length === 0 && (
              <div className="var-chat__empty">
                <p>✨ 예상치 못한 상황을 알려주세요. LLM이 현재 일정을 분석해 수정안을 제안합니다.</p>
                <div className="var-chat__suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="var-chat__suggestion-chip"
                      onClick={() => { onChatInputChange(s); inputRef.current?.focus(); }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`var-chat__msg var-chat__msg--${msg.role}`}>
                <span className="var-chat__role">{msg.role === "user" ? "👤 나" : "🤖 AI"}</span>
                <div className="var-chat__content">
                  {msg.role === "assistant" ? renderMarkdownLike(msg.content) : <p>{msg.content}</p>}
                  {msg.modifiedSchedule && msg.modifiedSchedule.length > 0 && (
                    <div className="var-chat__modified-schedule">
                      <strong>📋 수정된 일정 ({msg.modifiedSchedule.length}곳)</strong>
                      <ol>
                        {msg.modifiedSchedule.map((item, idx) => (
                           <li key={item.id != null ? `${item.id}-${idx}` : idx}>{item.time} {item.name} ({item.area ?? item.type})</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="var-chat__msg var-chat__msg--assistant">
                <span className="var-chat__role">🤖 AI</span>
                <div className="var-chat__content var-chat__thinking">
                  <span>분석 중</span>
                  <span className="var-chat__dots"><span /><span /><span /></span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="var-input-row">
            <textarea
              ref={inputRef}
              className="var-input"
              rows={2}
              placeholder="상황을 입력하세요 (예: 늦잠 자서 12시에 출발, 비가 와서 야외 취소…)"
              value={chatInput}
              onChange={(e) => onChatInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
            />
            <button
              type="button"
              className="btn primary var-send-btn"
              disabled={!chatInput.trim() || isLoading}
              onClick={onSend}
            >
              {isLoading ? "분석 중…" : "전송"}
            </button>
          </div>
          <p className="var-hint">
            {OPENAI_KEY ? "OpenAI GPT 연결됨" : "시뮬레이션 모드 (VITE_OPENAI_API_KEY 미설정)"}
            {" · "}
            {OWM_KEY ? "날씨 API 연결됨" : "날씨 시뮬레이션"}
            {" · "}
            {hasGoogleMaps ? "Google Maps 연결됨" : "Google Maps 미연결"}
          </p>
        </div>
      )}
    </div>
  );
}
