import L from "leaflet";

export const STEP_LABELS = ["여행지", "일정", "여행 구성", "최종 플랜"];
export const RESULT_STEP = 3;
export const LAST_WIZARD_STEP = 2;
export const STAY_LOAD_TARGET = 36;
export const TRAVEL_TAGS = ["역사유적", "쇼핑", "미식", "야경", "자연", "카페투어", "전시체험", "로컬시장"];

export const DAY_PIN_COLORS = { 1: "#2563eb", 2: "#059669", 3: "#7c3aed" };

export const PLACE_TYPES = [
  { id: "tourist_attraction", label: "관광지", icon: "🏛️" },
  { id: "restaurant", label: "식당", icon: "🍽️" },
  { id: "cafe", label: "카페", icon: "☕" },
  { id: "hospital", label: "병원", icon: "🏥" },
  { id: "pharmacy", label: "약국", icon: "💊" },
  { id: "convenience_store", label: "편의점", icon: "🏪" },
];

export const LODGINGS = [
  { id: "lodging-shinjuku", name: "신주쿠 숙소 (베이스)", summary: "교통 허브 접근이 좋아 첫 도쿄 여행에 안정적", latlng: [35.6912, 139.6998], area: "신주쿠" },
  { id: "lodging-ueno", name: "우에노 숙소", summary: "박물관·공원 접근이 좋아 오전 일정 시작이 편함", latlng: [35.7138, 139.7774], area: "우에노" },
  { id: "lodging-shibuya", name: "시부야 숙소", summary: "쇼핑·야경 중심 동선에 유리한 트렌디한 베이스", latlng: [35.6595, 139.7005], area: "시부야" },
  { id: "lodging-ginza", name: "긴자 숙소", summary: "미식/비즈니스 중심지로 저녁 일정 마무리가 쉬움", latlng: [35.6717, 139.765], area: "긴자" },
];

export const SAVED_PLANS = [
  { id: "demo-tokyo", name: "도쿄 2박3일 · 풀코스", meta: "최근 수정 · 동선 최적화됨", detail: "아사쿠사→우에노→오다이바 전체 일정" },
  { id: "demo-osaka", name: "오사카 3박4일 · 미식투어", meta: "2주 전 생성", detail: "도톤보리→신사이바시→나라 당일치기" },
  { id: "demo-jeju", name: "제주도 2박3일 · 힐링", meta: "지난달 저장", detail: "성산일출봉→협재해변→한림공원" },
  { id: "demo-paris", name: "파리 4박5일 · 예술여행", meta: "3일 전 생성", detail: "루브르→오르세→몽마르뜨→베르사유" },
  { id: "demo-bangkok", name: "방콕 2박3일 · 가성비", meta: "1주 전 생성", detail: "왕궁→카오산로드→짜뚜짝 마켓" },
  { id: "demo-swiss", name: "스위스 5박6일 · 트레킹", meta: "2달 전 저장", detail: "체르마트→그린델발트→인터라켄" },
];

export const CONTENTS = [
  { id: "sensoji", name: "센소지 사원", type: "역사 유적", summary: "아침 방문 추천, 전통 골목 연계", time: "09:00", latlng: [35.7148, 139.7967], img: "https://images.unsplash.com/photo-1549693578-d683be217e58?auto=format&fit=crop&w=300&q=70", day: 1, seq: 1, area: "아사쿠사", visitScore: 4, llmStayNote: "예배·둘러보기·사원가 대기행렬까지 약 2~2.5h 상당", indoor: false },
  { id: "ameyoko", name: "아메요코 시장", type: "쇼핑/로컬", summary: "간식, 로컬 쇼핑, 길거리 음식", time: "10:50", latlng: [35.7099, 139.7741], img: "https://images.unsplash.com/photo-1492571350019-22de08371fd3?auto=format&fit=crop&w=300&q=70", day: 1, seq: 2, area: "우에노", visitScore: 3, llmStayNote: "시장 구경·간식·짧은 쇼핑에 약 1~1.5h", indoor: false },
  { id: "ueno", name: "우에노 공원", type: "자연/산책", summary: "점심 전후 산책 코스", time: "12:10", latlng: [35.7156, 139.7731], img: "https://images.unsplash.com/photo-1528360983277-13d401cdc186?auto=format&fit=crop&w=300&q=70", day: 1, seq: 3, area: "우에노", visitScore: 3, llmStayNote: "넓은 공원 산책·벤치 휴식 포함 1~1.5h", indoor: false },
  { id: "tokyo-museum", name: "도쿄국립박물관", type: "역사/전시", summary: "일본문화 핵심 전시", time: "14:00", latlng: [35.7188, 139.7765], img: "https://images.unsplash.com/photo-1518998053901-5348d3961a04?auto=format&fit=crop&w=300&q=70", day: 1, seq: 4, area: "우에노", visitScore: 5, llmStayNote: "전시 동선 길고 해설 위주 시 3h+ 가능 → 5점", indoor: true },
  { id: "akihabara", name: "아키하바라", type: "쇼핑/서브컬처", summary: "테마샵 탐방 및 저녁 식사", time: "18:30", latlng: [35.6984, 139.7731], img: "https://images.unsplash.com/photo-1480796927426-f609979314bd?auto=format&fit=crop&w=300&q=70", day: 1, seq: 5, area: "아키하바라", visitScore: 4, llmStayNote: "매장 탐방·굿즈 구매에 2h 전후 부담 큼", indoor: true },
  { id: "meiji", name: "메이지 신궁", type: "역사 유적", summary: "오전 숲길 산책", time: "09:00", latlng: [35.6764, 139.6993], img: "https://images.unsplash.com/photo-1490806843957-31f4c9a91c65?auto=format&fit=crop&w=300&q=70", day: 2, seq: 1, area: "하라주쿠", visitScore: 3, llmStayNote: "참배·숲길 산책 1~1.5h", indoor: false },
  { id: "takeshita", name: "다케시타 거리", type: "쇼핑/트렌드", summary: "디저트와 스트리트 패션", time: "10:40", latlng: [35.6702, 139.7026], img: "https://images.unsplash.com/photo-1526481280695-3c4696d52e58?auto=format&fit=crop&w=300&q=70", day: 2, seq: 2, area: "하라주쿠", visitScore: 4, llmStayNote: "줄 서는 디저트·골목 쇼핑으로 2h 내외", indoor: false },
  { id: "omotesando", name: "오모테산도", type: "카페/디자인", summary: "브런치와 편집숍", time: "12:00", latlng: [35.6655, 139.7123], img: "https://images.unsplash.com/photo-1467269204594-9661b134dd2b?auto=format&fit=crop&w=300&q=70", day: 2, seq: 3, area: "오모테산도", visitScore: 3, llmStayNote: "브런치+편집숍 둘러보기 1~1.5h", indoor: true },
  { id: "shibuya", name: "시부야 스카이", type: "쇼핑/전망", summary: "일몰 시간대 뷰포인트", time: "17:30", latlng: [35.6595, 139.7005], img: "https://images.unsplash.com/photo-1536098561742-ca998e48cbcc?auto=format&fit=crop&w=300&q=70", day: 2, seq: 4, area: "시부야", visitScore: 4, llmStayNote: "입장·전망·굿즈 대기 포함 약 2h", indoor: true },
  { id: "shinjuku", name: "신주쿠 골든가이", type: "야경/미식", summary: "저녁 바 거리 탐방", time: "20:00", latlng: [35.6938, 139.7046], img: "https://images.unsplash.com/photo-1533929736458-ca588d08c8be?auto=format&fit=crop&w=300&q=70", day: 2, seq: 5, area: "신주쿠", visitScore: 4, llmStayNote: "바 호핑·야경 카페까지 2h 이상 여유 권장", indoor: false },
  { id: "tsukiji", name: "츠키지 장외시장", type: "미식/로컬", summary: "아침 해산물 브런치", time: "08:30", latlng: [35.6654, 139.7707], img: "https://images.unsplash.com/photo-1544481923-a6918bd997bc?auto=format&fit=crop&w=300&q=70", day: 3, seq: 1, area: "긴자", visitScore: 3, llmStayNote: "시장 돌며 브런치 1~1.5h", indoor: false },
  { id: "teamlab", name: "팀랩 플래닛", type: "전시/체험", summary: "몰입형 디지털 아트 체험", time: "10:30", latlng: [35.6492, 139.7898], img: "https://images.unsplash.com/photo-1501612780327-45045538702b?auto=format&fit=crop&w=300&q=70", day: 3, seq: 2, area: "토요스", visitScore: 5, llmStayNote: "입장 예약·체험 동선 길면 3h 가깝게 소요", indoor: true },
  { id: "odaiba", name: "오다이바 해변공원", type: "자연/뷰포인트", summary: "도쿄만 산책과 사진 스팟", time: "13:00", latlng: [35.6298, 139.7753], img: "https://images.unsplash.com/photo-1471623432079-b009d30b6729?auto=format&fit=crop&w=300&q=70", day: 3, seq: 3, area: "오다이바", visitScore: 3, llmStayNote: "산책·촬영 위주 1~1.5h", indoor: false },
  { id: "ginza", name: "긴자", type: "쇼핑/미식", summary: "기념품 쇼핑 및 디너", time: "17:00", latlng: [35.6717, 139.765], img: "https://images.unsplash.com/photo-1513407030348-c983a97b98d8?auto=format&fit=crop&w=300&q=70", day: 3, seq: 4, area: "긴자", visitScore: 4, llmStayNote: "백화점·디너·쇼핑 2h 전후", indoor: true },
  { id: "tokyo-station", name: "도쿄역 마루노우치", type: "야경/마무리", summary: "마지막 야경과 귀환 동선", time: "19:30", latlng: [35.6812, 139.7671], img: "https://images.unsplash.com/photo-1554797589-7241bb691973?auto=format&fit=crop&w=300&q=70", day: 3, seq: 5, area: "마루노우치", visitScore: 2, llmStayNote: "야경·사진·짧은 산책 45분~1h", indoor: false },
];

export const METRO_LINES = [
  { id: "ginza", name: "긴자선", color: "#f4b400" },
  { id: "yamanote", name: "야마노테선", color: "#32a852" },
  { id: "hanzomon", name: "한조몬선", color: "#8f6ad8" },
  { id: "yurikamome", name: "유리카모메", color: "#2f9edb" },
  { id: "marunouchi", name: "마루노우치선", color: "#e34d4d" },
];

export const LINE_SEQUENCE = ["ginza", "yamanote", "hanzomon", "ginza", "marunouchi", "ginza", "yurikamome", "yurikamome", "ginza", "marunouchi", "yamanote", "ginza", "hanzomon", "ginza"];

// Travel style preferences — NOT fixed transport choices. Each entry describes
// how the user wants to move around; the actual per-segment transport is
// decided by the LLM / Google Directions based on the chosen style.
// Shape preserved for result-page backward compat (fare/duration/transfer/note).
export const MOVES = [
  {
    id: "walking",
    name: "도보 중심",
    icon: "🚶",
    detail: "숙소 반경 ~2km 내에서 느긋하게, 로컬 몰입도 ↑",
    score: "반경 2km",
    line: "도보 경로 위주",
    fare: "이동 비용 거의 없음",
    duration: "세그먼트당 5~15분",
    transfer: "환승 없음",
    note: "액티비티가 숙소 근처에 집중됨",
  },
  {
    id: "public",
    name: "대중교통 중심",
    icon: "🚇",
    detail: "JR · 지하철 · 버스로 시내 전역 효율적으로",
    score: "도시 전체",
    line: "주요 노선 + 환승",
    fare: "1일권/패스 권장",
    duration: "세그먼트당 10~30분",
    transfer: "주요 역 환승",
    note: "외곽은 제외, 시내 전역 커버",
  },
  {
    id: "car",
    name: "렌터카 · 택시",
    icon: "🚗",
    detail: "외곽·근교까지 자유롭게, 이동 부담 최소",
    score: "반경 80km",
    line: "간선도로 · 고속도로",
    fare: "렌트비 + 연료 또는 택시 구간별",
    duration: "세그먼트당 15~60분",
    transfer: "환승 없음 · 주차만",
    note: "외곽 스팟 포함 가능",
  },
  {
    id: "mixed",
    name: "혼합 (AI 재량)",
    icon: "🔀",
    detail: "거리 · 시간 · 피로도 기반 세그먼트별 자동 최적화",
    score: "자동",
    line: "AI 최적화",
    fare: "상황별 혼합",
    duration: "세그먼트별 최적",
    transfer: "자동 결정",
    note: "각 이동 구간마다 도보/대중교통/차 중 최적 선택",
  },
];

// ─── Map icons ───────────────────────────────────────────────────────────────
export function dayNumberIcon(day, num) {
  const bg = DAY_PIN_COLORS[day] || "#3f63ff";
  return L.divIcon({
    className: "leaflet-day-pin",
    html: `<div class="day-pin-inner" style="background:${bg}"><span>${num}</span></div>`,
    iconSize: [34, 34], iconAnchor: [17, 32], popupAnchor: [0, -28],
  });
}

export const lodgingMapIcon = L.divIcon({
  className: "leaflet-lodging-pin",
  html: `<div class="lodging-pin-inner" title="숙소"><span aria-hidden="true">🏨</span></div>`,
  iconSize: [48, 48], iconAnchor: [24, 46], popupAnchor: [0, -40],
});

// ─── Helper functions ────────────────────────────────────────────────────────
export function findDayInBuckets(buckets, id) {
  if (!buckets) return null;
  for (const [day, ids] of Object.entries(buckets)) {
    if ((ids ?? []).includes(id)) return Number(day);
  }
  return null;
}

export function categoriesForContent(content) {
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

export function normalizeSelectionForDemo(ids, targetLoad) {
  const selected = Array.from(new Set(ids)).filter((id) => CONTENTS.some((c) => c.id === id));
  if (!selected.length) return [];
  const scoreById = new Map(CONTENTS.map((c) => [c.id, c.visitScore ?? 0]));
  let sum = selected.reduce((acc, id) => acc + (scoreById.get(id) ?? 0), 0);
  const remaining = CONTENTS.filter((c) => !new Set(selected).has(c.id));
  while (sum < targetLoad && remaining.length) {
    const bestIdx = remaining.reduce((best, cur, idx, arr) => Math.abs(targetLoad - (sum + (cur.visitScore ?? 0))) < Math.abs(targetLoad - (sum + (arr[best].visitScore ?? 0))) ? idx : best, 0);
    const pick = remaining.splice(bestIdx, 1)[0];
    selected.push(pick.id);
    sum += pick.visitScore ?? 0;
  }
  while (sum > targetLoad && selected.length > 1) {
    const removeIdx = selected.reduce((best, id, idx, arr) => Math.abs(targetLoad - (sum - (scoreById.get(id) ?? 0))) < Math.abs(targetLoad - (sum - (scoreById.get(arr[best]) ?? 0))) ? idx : best, 0);
    sum -= scoreById.get(selected.splice(removeIdx, 1)[0]) ?? 0;
  }
  return selected;
}

export function osrmProfileForMove(moveId) {
  return moveId === "public" ? "foot" : "driving";
}

export function buildMoveSegmentDefs(contents, moveId) {
  if (contents.length < 2) return [];
  const mode = MOVES.find((m) => m.id === moveId) || MOVES[0];
  return contents.slice(0, -1).map((from, idx) => {
    const to = contents[idx + 1];
    let color, lineLabel, weight = 7;
    if (moveId === "public") {
      const lineId = LINE_SEQUENCE[idx % LINE_SEQUENCE.length];
      const line = METRO_LINES.find((item) => item.id === lineId) || METRO_LINES[0];
      color = line.color;
      lineLabel = `${line.name} 구간 · 보행/도로 경로(근사)`;
    } else if (moveId === "taxi") {
      color = "#ea580c"; lineLabel = "택시 · 도로 경로 (OSRM)"; weight = 6;
    } else {
      color = "#1e40af"; lineLabel = "렌터카 · 도로 경로 (OSRM)"; weight = 7;
    }
    return { id: `${from.id}-${to.id}-${moveId}-${idx}`, from, to, color, lineLabel, duration: moveId === "taxi" ? `${10 + (idx % 5) * 3}분` : `${12 + (idx % 4) * 4}분`, modeLabel: mode.name, weight };
  });
}

// ─── Animation config ────────────────────────────────────────────────────────
export const transitionSpring = { type: "spring", stiffness: 280, damping: 30, mass: 0.85 };
export const fadeSlide = {
  initial: { opacity: 0, x: 28 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -22 },
};
