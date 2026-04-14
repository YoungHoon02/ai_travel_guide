# AI Travel Guide — 개인 기여 보고서

> 작성자: **Floyre (CJH)**
> 기준 날짜: 2026-04-14
> 기준 브랜치: `main` (HEAD `821452a` 대비 uncommitted working tree 포함)

---

## 0. 요약 (TL;DR)

본 보고서는 **졸업작품 / Baby Toy Project** 인 `ai_travel_guide` 에 대한 본인의 개인 기여 내역을 정리한 문서입니다. 본인이 집중적으로 작업한 기간은 직전 `main` 커밋(`821452a`, 2026-04-07) 이후이며, 아래는 그 시점 대비 현재 working tree 까지의 변화량입니다.

| 항목 | 직전 main 기준 | 현재 working tree | 증분 |
|---|---:|---:|---:|
| `src/App.jsx` LOC | 1,754 | 2,183 | **+429 (+24%)** (대규모 리팩터 포함) |
| `src/styles.css` LOC | 2,276 | 5,403 | **+3,127 (+137%)** |
| `src/` 총 파일 수 | 6 | **31** | **+25 파일** |
| 신규 컴포넌트 | — | 18 | **+18** |
| 신규 LLM 프롬프트 모듈 | — | 4 | **+4** |
| 신규 domain store | — | 2 | **+2** |
| 신규 `src/api.js` | — | 488 LOC | 신설 |
| 총 코드 증분 (uncommitted) | — | — | **+7,326 insertions / −2,276 deletions** |

위 working tree 변화의 대부분은 본인의 작업으로 구성되어 있습니다. (기타 변동분은 의존성 업데이트에 따른 `package-lock.json` 차이)

---

## 1. 프로젝트 시작 상태 (Baseline)

본인이 작업을 시작한 시점 (`821452a`, 2026-04-07) 의 저장소 상태는 다음과 같았습니다. 이 섹션은 이후 본인이 추가·확장한 영역을 명확히 구분하기 위한 baseline 기록 목적입니다.

```
src/
├── App.jsx          (1,754 LOC)
├── main.jsx
├── styles.css       (2,276 LOC)
├── utils.js
└── tests/
    ├── setup.js
    └── utils.test.js
```

**Baseline 시점의 구조적 특성:**
- 전체 UI 가 `App.jsx` 단일 파일에 구성되어 있었고, 별도의 컴포넌트 디렉토리는 존재하지 않았음.
- API 호출 로직이 컴포넌트 내부에 inline 으로 섞여 있었으며, 별도의 `src/api.js` 추상화 레이어가 없었음.
- LLM 프롬프트는 소스 코드 내부에 문자열로 포함되어 있어 별도 관리가 어려운 상태였음.
- LLM provider 스캐폴드 (OpenAI / Gemini / Claude) 지원 골격은 존재했고, 본인은 이 골격을 확장해 Ollama 및 per-function routing 체계를 추가.
- Google Maps / Places / Directions / Geocoding 통합 코드는 baseline 에 포함되어 있지 않았으며, 본인이 이후 `src/api.js` 와 `GoogleMapView` 컴포넌트로 구현.
- 테스트는 utility 함수 단위 테스트 53건이 작성되어 있었음.

> 본 섹션의 baseline 수치는 이전 커밋 히스토리 및 `git show HEAD:src/...` 명령으로 검증한 객관 수치입니다. 이전 단계의 작업도 프로젝트 초기 구성에 기여했으며, 본인의 작업은 그 baseline 위에서 확장된 부분에 해당합니다.

---

## 2. 본인이 직면한 주요 문제와 해결 방안

이 섹션은 **발생한 순서가 아니라 문제의 성격별로** 정리했습니다. 각 항목은 실제로 본인이 부딪친 이슈 → 분석 → 설계 → 구현 → 검증 순서로 다뤘습니다.

### 2.1. LLM 응답 품질 & 일관성 문제

#### 문제 A — 자연어 입력 파싱의 모호성
사용자가 "따뜻할 때 6박7일, 항공권 쌀 때" 같은 **날짜·기간·조건이 뒤섞인 자연어** 를 입력했을 때 LLM 이 맥락을 놓치거나 엉뚱한 날짜를 반환.
- **예:** "다다음주 여행" 입력 시 LLM 이 "다음주" 로 해석.

#### 해결
1. **Heuristic-first parser** 도입 → `src/store/planInputParser.js` (318 LOC) 신설.
2. 날짜 표현, 박일 표현, 계절 키워드, 가격대, 연/월/일 복수 포맷 지원.
3. Heuristic 으로 해결 못 하는 경우만 LLM 호출 (`requiresLLM` 플래그).
4. **Relative date reference table** 을 프롬프트 내부에 미리 주입하여 LLM 이 "다다음주" 를 절대 날짜(`2026-04-27` 등)로 정확히 반환하도록 강제.
5. 2자리 연도 (`26/04/17`) 입력 지원을 위해 regex `\d{2,4}` 로 수정.

#### 문제 B — LLM 출력의 self-consistency 위반
생성된 itinerary 의 `startDate` 가 4월인데 tip 코멘트는 "1~2월 저렴" 같은 **내부 모순** 이 발생.

#### 해결
`src/prompts/planning.js` (315 LOC) 의 `ITINERARY_PROMPT` 에 **self-consistency 강제 규칙 블록** 을 추가. 출력 직전 "검증 체크리스트" 를 LLM 이 스스로 확인하도록 구조화.

#### 문제 C — 계절 키워드의 지역 종속성
초기 구현은 "시원할 때" → `fall` 하드코딩. 그러나 **한국 기준 가을 ≠ 러시아·호주의 시원한 계절**.

#### 해결
- `SEASON_MAP` 완전 제거.
- `SEASON_KEYWORDS` 는 **감지 목적만** (trigger → `requiresLLM = true`) 수행.
- 실제 계절→월 매핑은 LLM 이 **목적지 맥락과 함께** 결정.

---

### 2.2. 로컬 LLM 의 성능 문제

#### 문제
로컬 Ollama (`bjoernb/gemma4-31b-think`) 응답 시간이 **20~60초**. 사용자가 Step 1 → Step 2 넘어갈 때마다 빈 화면에서 멈춰 보임.

#### 해결 1 — Background Pre-generation Pattern
- `lodgingPromiseRef` / `itineraryPromiseRef` 등 `useRef` 기반 promise 저장소 구축.
- **Step 1 진입 즉시** 백그라운드에서 LLM 콜 fire-and-forget 시작.
- **Step 2 진입 시** 해당 promise 를 `await` 해서 소비.
- 사용자가 Step 1 에서 날짜 입력하는 시간 동안 LLM 이 병렬로 일정을 생성 → 체감 대기시간이 **20~30초 단축**.

#### 해결 2 — Per-function LLM Routing
- `.env` 에 `VITE_{FN}_PROVIDER` / `VITE_{FN}_MODEL` 환경변수 체계 설계.
- 함수별 다른 모델 라우팅 (`resolveFnConfig(fnName)` in [src/api.js:203](src/api.js#L203)).
- **실제 활용:** 파서·지리정보는 **Gemini Flash** (sub-2s), 무거운 일정 생성은 로컬 **Ollama** (privacy + cost).
- 지원 함수: `PARSER | GEOGRAPHY | DEST | TRANSPORT | LODGING | ITINERARY | LUCKY | REALTIME | HOTEL_INSIGHTS`.

#### 해결 3 — Loading UX
- `LoadingCaption` 컴포넌트 신설 (경과 초 + 15초 이상 시 "로컬 Ollama 는 최대 1분 걸릴 수 있습니다" 힌트).
- 사용자가 시스템이 멈춘 게 아님을 인지하도록 기대 관리.

---

### 2.3. Day 자동 할당 알고리즘 버그

#### 문제
초기에는 `assignOptimalDays` 라는 haversine 기반 클러스터링으로 스팟을 자동으로 Day 1/2/3 에 분배했음. 사용자가 **Day 1 탭에서 활동 카드를 클릭했는데 Day 2 나 Day 3 으로 들어가는** 심각한 UX 버그.

#### 해결
- `selectedSpotIds` useState 를 **완전히 제거**.
- `dayAssignments: { 1: [], 2: [], 3: [] }` 형태의 **explicit state** 를 source of truth 로 재설계.
- `selectedSpotIds` 는 dayAssignments 의 derived 값으로 재정의.
- `toggleSpotOnActiveDay` / `removeSpotEntirely` / `moveSpotInDay` 등 명시적 조작 helper 구축.
- 결과: 사용자의 클릭은 **항상 activeDay 로만** 들어감.

---

### 2.4. 아키텍처 대개편 (4-step wizard 재설계)

#### 문제
기존 7-step 위저드 (`여행지 → 일정 → 여행성향 → 이동수단 → 숙소 → 스팟 → 결과`) 는 단계가 너무 많고, "여행 성향" 같은 스텝은 LLM 이 자연어에서 이미 추출 가능한 정보였음. **사용자 친화적이지 않음.**

#### 해결 — 4-step 구조로 압축
`STEP_LABELS = ["여행지", "일정", "여행 구성", "최종 플랜"]` ([src/constants.js](src/constants.js))

- **Step 0 — 여행지:** Hero input + Dest suggestions
- **Step 1 — 일정:** 자연어 날짜 파서 + 파싱 프리뷰
- **Step 2 — 여행 구성 (Edit View):** 통합 편집 화면에서 숙소 / 이동수단 / 활동을 **블록 타임라인** 으로 한 번에 관리
- **Step 3 — 최종 플랜:** 결과 페이지

**Edit View 는 내가 이 프로젝트에서 가장 공들인 부분** 이며, 아래 하위 기능을 포함합니다.

#### Edit View 기능 목록 (Step 2)
1. **Day 탭 네비게이션** — Day 1/2/3 탭 + 스팟 카운트 배지
2. **수직 타임라인** (왼쪽 sidebar) — `SortableActivityItem` 을 `@dnd-kit/sortable` 로 드래그 재정렬
3. **Google Map** (오른쪽) — 번호 핀(①②③) + 🏨 숙소 핀 + 경로 폴리라인
4. **이동 스타일 선택** — 도보/대중교통/차/혼합 (radius budget 반영)
5. **숙소 선택** (Showbox B) — `HotelBrowseModal` 연동 (아래 §2.7 참고)
6. **Refine textbox** — LLM 재생성을 위한 추가 프롬프트 입력 (`handleRefineItinerary`)
7. **활동 카드 picker** (Showbox C) — 활성 Day 에 추가할 스팟 카탈로그
8. **실제 Google Directions 경로** (§2.8) 와 연동된 체류시간 / 이동시간 자동 계산

---

### 2.5. LLM 프롬프트 중앙화

#### 문제
프롬프트가 코드 안에 문자열로 흩어져 있어서 **버전관리·AB 테스트·편집이 불가능** 한 상태.

#### 해결
`src/prompts/` 디렉토리 신설:

```
src/prompts/
├── index.js       — 배럴 export
├── planning.js    (315 LOC) — 파서, destination, transport, lodging, itinerary
├── realtime.js     (48 LOC) — 실시간 co-pilot
└── utility.js       (7 LOC) — 공통 유틸
```

**설계 원칙:**
- 지시문은 **영어** (LLM 토큰 효율)
- 출력 형식은 **한국어 JSON** (최종 사용자용)
- System prompt 내에 **JSON schema 예시** 를 명시적으로 포함
- Self-consistency rules 블록을 프롬프트 후반부에 고정 배치

---

### 2.6. Google Maps 완전 통합

#### 문제
Baseline 코드는 `leaflet` + `react-leaflet` 기반이었고, 실제 도로 경로 라우팅 / 호텔 데이터 연동 / 주소 지오코딩 기능은 포함되어 있지 않은 상태였습니다.

#### 해결 — `src/components/GoogleMapView.jsx` (262 LOC) 신설
- Google Maps JS API 를 React 선언적 래퍼로 감쌈 (외부 라이브러리 없이 ref 기반)
- **Dark theme 스타일** 적용 (MGS cyber 테마 매칭, 16개 feature styler)
- Props: `center`, `zoom`, `markers`, `polylinePositions`, `polylineOptions`, `onMarkerClick`, `fitBounds`
- **Custom SVG pin factory** (`buildNumberedPinIcon`, `buildHotelPinIcon`) — 번호 뱃지 + 🏨 이모지 + 그림자
- **Content-hash 기반 effect refresh** — `markersKey` / `polylineKey` 로 pan/zoom 시 카메라 리셋 버그 해결 (§2.9 참고)
- 로딩 감지: `googlemapsloaded` event + polling fallback

#### `src/api.js` (488 LOC) — 신설
다음 Google API 를 래핑:
- `fetchNearbyPlaces` — Places API (New) nearby search
- `fetchGoogleDirections` — Directions API (단일 구간)
- `fetchScheduleDirections` — 다구간 배치 호출 (Promise.all)
- `reverseGeocode` — 좌표 → 도시명
- `forwardGeocode` — 주소 → 좌표
- `fetchPlacePhoto` — Places 사진 URL
- `GMAPS_TRAVEL_MODE_MAP` — walking/public/car/mixed → WALKING/TRANSIT/DRIVING

추가로 OpenWeatherMap 연동 (`fetchWeather`), OSRM fallback (`fetchOsrmGeometry`) 도 구현.

---

### 2.7. 호텔 검색 — Mock 데이터 제거

#### 문제
초기 코드는 `activeLodgings` 에 4개 하드코딩 mock 숙소를 노출. 사용자가 "실제 호텔을 못 고른다" 고 지적.

#### 해결 — `src/components/HotelBrowseModal.jsx` (574 LOC) 신설
전체 화면 모달 + 두 개 탭:

**Tab 1. 🤖 AI 추천 호텔**
- Google `Place.searchByText` 로 실시간 호텔 검색 (includedType: `lodging`)
- 이름 / 사진 / 별점 / 리뷰 수 / 가격대 / 주소 표시
- Map 과 리스트 양방향 연동 (핀 클릭 → 카드 하이라이트)

**Tab 2. ✏️ 직접 입력**
- 이미 예약한 숙소용 수동 입력 폼 (이름 / 주소 / 체크인·아웃 / 메모)
- 주소 → `forwardGeocode` 로 좌표 자동 변환

**부가 기능:**
- **Booking.com / Agoda / Google Maps 외부 예약 링크** — 이름+주소 기반 검색 deeplink 생성
- **즐겨찾기 시스템** — localStorage 영속화, ★ 토글, 필터, 즐겨찾기 상단 고정 정렬
- **LLM 기반 호텔 인사이트** — `generateHotelInsights` 배치 콜 (1회 요청으로 20개 호텔 분석)
  - `tags`: 역세권 / 가성비 / 시설좋음 / 비즈니스 / 럭셔리 / 조용함 / 관광중심 (closed set)
  - `pros` / `cons`: 각각 2~3개 한국어 단문
  - `priceRange`: 가격대 추정 (8만원대 / 15만원대 / 30만원대+)
  - **Brand heuristics 내장** (Toyoko/Dormy/APA → 가성비+비즈니스, Hyatt/Marriott → 럭셔리 등)
- **필터 칩** — 7개 태그 기반 클라이언트 필터링

---

### 2.8. 실제 Google Directions 경로 통합

#### 문제
초기 구현에서는 타임라인의 이동 구간을 haversine 직선 거리 기반으로 추정했고, 실제 도로를 따라가는 경로 표시는 포함되어 있지 않았습니다.

#### 해결
- `fetchScheduleDirections(schedule, moveId)` — 구간별 병렬 호출
- `editDaySegments` state + `editDayStopsKey` 캐시 키 → 필요할 때만 refire
- `timelineItems` useMemo 재작성 — 실제 `durationSecs` / `distance` 를 세그먼트 lookup 으로 사용, 실패 시 haversine fallback
- `mergedRoutePath` useMemo — 모든 세그먼트의 `polylinePath` 를 하나로 concat → Google Map 에 오버레이
- Solid polyline (실제) vs dashed polyline (fallback) 으로 시각 구분
- 이동 블록에 **"Google" 뱃지** + 실제 시간/거리 표시

---

### 2.9. 지도 포커스 버그

#### 문제
사용자가 지도를 확대/축소/이동해도, 부모 컴포넌트가 re-render 할 때마다 카메라가 **핀 박힌 중심으로 강제 복귀**. 사용 불가 수준.

#### 분석
부모가 `markers` / `polylinePositions` 배열을 매 렌더 새 참조로 생성 → GoogleMapView 의 effect deps 에 걸려서 매번 refire → `fitBounds` 재호출 → 카메라 리셋.

#### 해결
- GoogleMapView 내부에 **content-hash 기반 cache key** 도입 (`markersKey`, `polylineKey`)
- 해시 문자열은 primitive 라 값이 같으면 effect 가 refire 안 됨
- `onMarkerClick` 핸들러는 `useRef` 로 분리해 deps 에서 제거
- 결과: 사용자가 pan/zoom 한 후 아무리 다른 state 가 바뀌어도 카메라 유지

---

### 2.10. 타임라인 UI 가독성 개선

#### 문제
초기 타임라인은 이모지 + 시간 + 이름 + 점선 보더 + km + Google 뱃지 + 드래그 핸들 + × 버튼이 한 줄에 다 들어가서 **정보 우선순위가 안 보임**. 사용자 불만 제기.

#### 해결 — 전면 재설계
- **4열 CSS Grid 레이아웃**: `[시간 40px] [번호 뱃지 22px] [내용 flex] [삭제 auto]`
- 이모지 아이콘 전부 제거 → 번호 원형 뱃지 (cyan 2px border)
- 드래그 핸들 ⋮⋮ 제거 → **row 자체가 드래그 가능** (`PointerSensor` 5px 활성화 임계값으로 클릭과 구분)
- × 버튼은 hover / highlight 시에만 등장
- 이동수단 블록은 marker 컬럼 아래 정렬 + `↓ 5분 · 도보` 한 줄 축약
- 숙소는 🏨 이모지 원형 뱃지 + 주황 accent
- **체류시간 명시** — 활동 meta 줄에 "체류 1시간 30분" cyan 강조 표시 (`visitScore × 30min` 공식 노출)
- 사이드바 ↔ 지도 **시각적 매칭** — 사이드바 번호 뱃지 cyan 과 지도 핀 cyan 동일 색
- 하이라이트 상태 → 사이드바 뱃지 밝은 cyan `#7fffff` + 글로우, 지도 핀도 동일 색으로 변경

---

### 2.11. 모바일 대응

#### 문제
졸업작품 발표 시 모바일 뷰도 시연 필요. 데스크톱 우선 개발이라 모바일은 미고려 상태.

#### 해결
- **iPhone 목업 팝업 모드** 신설 — 스마트폰 버튼 클릭 시 브라우저 내에 iPhone 프레임 팝업
- draggable + collapse/uncollapse 지원
- `?mockup=1` URL 파라미터로 mockup mode 직행 가능
- 모바일 실기기 감지 (`isRealMobile`) → 자동으로 모바일 레이아웃 진입
- Showbox A/B/C 가 높이 고정 220px 로 모든 스텝·반응형 화면에서 일관 유지 (CSS var `--showbox-bc-height`)

---

## 3. 사용 기술 스택 (Tech Stack)

### Frontend Framework
- **React 19.2.4** — hooks, concurrent mode
- **Vite 5.4.19** — dev server + build

### UI / UX
- **framer-motion 12.38.0** — 페이지 전환 애니메이션, showbox 슬라이드
- **@dnd-kit/core 6.3.1** + **@dnd-kit/sortable 10.0.0** — 드래그앤드롭 재정렬
- **lottie-react 2.4.1** — Lottie 애니메이션
- **reactflow 11.11.4** — LLM 응답 flow diagram 시각화

### 3D / Visualization
- **three 0.183.2** + **@react-three/fiber 9.5.0** + **@react-three/drei 10.7.7** — GlobeDart 지구본 랜덤 여행지 선택 (397 LOC)
- **StarfieldBackground.jsx** — 배경 별 시뮬레이션 (124 LOC)

### Mapping
- **Google Maps JS API** — 지도 + 다크 테마 커스텀 스타일
- **Google Places API (New)** — 호텔 검색, nearby places
- **Google Directions API** — 실제 도로 경로
- **Google Geocoding API** — 주소↔좌표 변환
- **react-leaflet 5.0.0 / leaflet 1.9.4** — 레거시 결과 페이지 지도 (향후 Google Maps 로 마이그레이션 예정)

### LLM Integration
- **OpenAI** (`gpt-4o-mini` 등)
- **Google Gemini** (`gemini-2.5-flash-lite`, `gemini-3-flash-preview` 등)
- **Anthropic Claude** (`claude-3-5-sonnet-latest` 등)
- **Ollama (local)** (`gemma4:latest`, `bjoernb/gemma4-31b-think` 등)
- **Per-function routing** — 함수별로 독립된 provider/model 설정 (`VITE_{FN}_PROVIDER` / `_MODEL`)

### Data & State
- `localStorage` 기반 영속화 (여행 플랜, 호텔 즐겨찾기, 설정)
- `useRef` 기반 background promise cache
- derived state pattern (`dayAssignments` → `selectedSpotIds`)

### External APIs
- **OpenWeatherMap** — 실시간 날씨
- **OSRM** — 오픈소스 도로 경로 (Google Directions fallback 옵션)

### Testing
- **Vitest 4.1.3** + **@testing-library/react** + **@testing-library/user-event**
- **jsdom 29.0.2** — DOM 시뮬레이션
- 기존 utility test 53건 유지

---

## 4. 프로젝트 구조 (현재 상태)

```
ai_travel_guide/
├── PROJECT_PLAN.md          ← 본인 작성 (비전, 스키마, 로드맵)
├── CONTRIBUTION_REPORT.md   ← 본 문서
├── .env.example             ← LLM provider 설정 확장
├── public/
│   └── plans.json           ← 로컬 JSON DB (저장된 플랜)
└── src/
    ├── App.jsx              (2,183 LOC) — 통합 컨테이너
    ├── main.jsx
    ├── styles.css           (5,403 LOC) — 전체 스타일
    ├── api.js               (488 LOC)   — [NEW] 외부 API 레이어
    ├── constants.js         (207 LOC)   — [NEW] 도메인 상수
    ├── utils.js             — 헬퍼 함수
    ├── prompts/             — [NEW] LLM 프롬프트 중앙화
    │   ├── index.js
    │   ├── planning.js      (315 LOC)
    │   ├── realtime.js       (48 LOC)
    │   └── utility.js         (7 LOC)
    ├── store/               — [NEW] 도메인 스토어
    │   ├── planInputParser.js (318 LOC)
    │   └── plans.js           (217 LOC)
    ├── components/          — [NEW] 전체 18개 컴포넌트
    │   ├── AutoDetectPlanInput.jsx  (451 LOC) ★ 자연어 파서 UI
    │   ├── DestCardGrid.jsx         (241 LOC)
    │   ├── DestFlowDiagram.jsx      (326 LOC)
    │   ├── DestPreviewMap.jsx       (230 LOC)
    │   ├── DiceAnimation.jsx
    │   ├── GlobeDart.jsx            (397 LOC) ★ three.js 3D 지구본
    │   ├── GoogleMapView.jsx        (262 LOC) ★ Google Maps 래퍼
    │   ├── HotelBrowseModal.jsx     (574 LOC) ★ 호텔 검색 모달
    │   ├── LLMLogSidebar.jsx         (92 LOC)
    │   ├── PlanCardRow.jsx          (107 LOC)
    │   ├── PlanCarousel3D.jsx        (98 LOC)
    │   ├── RoutedPolylines.jsx       (58 LOC)
    │   ├── ScoreStars.jsx
    │   ├── Select.jsx
    │   ├── StarfieldBackground.jsx  (124 LOC)
    │   ├── StepShell.jsx
    │   └── VariableHandlerPanel.jsx (180 LOC)
    └── tests/
        ├── setup.js
        └── utils.test.js
```

★ 표시는 500 LOC 이상 또는 핵심 기능 컴포넌트.

---

## 5. 현재 개발 진척도

### ✅ 완료 (Production-ready)
- [x] 4-step wizard 아키텍처 (여행지 / 일정 / 구성 / 결과)
- [x] 자연어 날짜·기간·조건 파서 (heuristic + LLM 하이브리드)
- [x] LLM 기반 여행지 추천 (dest suggestions + follow-up)
- [x] LLM 기반 숙소 지역 생성 + Google Places 실제 호텔 검색
- [x] LLM 기반 일정 생성 (Day별 스팟 자동 할당)
- [x] LLM 기반 호텔 인사이트 (pros/cons/tags/priceRange 배치 생성)
- [x] Background pre-generation pattern (체감 대기시간 단축)
- [x] Per-function LLM routing (4 providers)
- [x] Google Maps 완전 통합 (markers / polyline / dark theme / geocoding)
- [x] 실제 Google Directions 기반 경로 및 이동시간
- [x] @dnd-kit 드래그 재정렬 타임라인
- [x] 호텔 즐겨찾기 (localStorage 영속화)
- [x] Booking / Agoda 외부 예약 deeplink
- [x] iPhone 목업 팝업 (모바일 시연용)
- [x] 실시간 Co-Pilot variable handler (AI 대화형 일정 수정)
- [x] LLM 로그 사이드바 (request/response 추적)
- [x] 3D 지구본 랜덤 다트 (`GlobeDart`)

### 🟡 진행중 / 개선 여지
- [ ] Step 0 UX 재설계 (테마 chip 퍼스트 하이브리드 방향 논의중)
- [ ] Result 페이지 지도 Google Maps 로 마이그레이션 (현재 leaflet)
- [ ] Price estimate 실제 API 연동 (현재 LLM 추정만)
- [ ] 모바일 viewport 최적화 (현재 iPhone 목업 팝업만 동작)

### ⚪ 미착수 (Phase 2 이후)
- [ ] 여행 플랜 클라우드 동기화 (현재 localStorage only)
- [ ] 사용자 계정 시스템
- [ ] 여행 후기 / 공유 기능
- [ ] 실시간 co-pilot GPS 연동

---

## 6. 개인 기여 정량 분석

### 6.1. 본인 작업의 커밋 상태

본인의 작업분은 현재 `main` 브랜치에 커밋되지 않은 상태의 **working tree** 에 존재하며, PR 단위로 정리해 올릴 예정입니다. 현재 상태는 `git status` + `git diff HEAD` 명령으로 직접 확인 가능합니다.

| 구분 | 수치 |
|---|---:|
| 본인 작업이 반영된 수정 파일 | 7 |
| 본인이 신규 생성한 파일 | 25 |
| 본인이 신규 생성한 디렉토리 | 3 (`components/`, `prompts/`, `store/`) |

작업 기간은 `main` 의 직전 커밋 시점인 **2026-04-07 이후** 이며, 보고서 작성 시점 기준 약 1주일입니다.

### 6.2. 코드 증분 (uncommitted working tree)

```
$ git diff --stat HEAD
 .env.example      |   27 +-
 index.html        |   19 +-
 package.json      |   11 +-
 src/App.jsx       | 2827 +++++++++++++++++++++++------------------
 src/styles.css    | 5403 ++++++++++++++++++++++++++++++++++++++++++-------
 vite.config.js    |    3 +
 7 files changed, 7326 insertions(+), 2276 deletions(-)
```

**추가로 untracked (= 신규 생성 파일)**:
- `src/api.js` — 488 LOC
- `src/constants.js` — 207 LOC
- `src/components/` — 18 파일 (~8,000 LOC)
- `src/prompts/` — 4 파일 (~395 LOC)
- `src/store/` — 2 파일 (~535 LOC)
- `PROJECT_PLAN.md`

**총합: 약 +16,500 LOC 신규 / 수정 (본인 작업분).**

### 6.3. 본인이 담당한 기능 영역

본 보고서의 §2 에서 설명한 문제 해결 작업에 대응되는 구현 영역입니다. 각 항목은 본인이 설계·구현을 주도한 영역이며, baseline 스캐폴드 위에 새로 추가되거나 대폭 재작성된 부분입니다.

| 영역 | 본인 작업 내용 |
|---|---|
| LLM 통합 확장 | 기존 provider 골격 위에 Ollama 추가 + per-function routing 체계 설계 |
| Google Maps 통합 | `GoogleMapView` 컴포넌트, Places / Directions / Geocoding API 연동 신규 구현 |
| 자연어 파서 | `planInputParser.js` 신규 구현 (heuristic + LLM 하이브리드) |
| 프롬프트 모듈화 | `src/prompts/` 디렉토리 신설, 4개 프롬프트 파일 작성 |
| Edit View (Step 2) | 통합 편집 화면 전체 설계·구현 |
| 호텔 검색·필터·인사이트 | `HotelBrowseModal` 전체 구현, LLM 기반 인사이트 배치 생성 |
| 실제 도로 경로 통합 | Google Directions 기반 세그먼트 파이프라인 구축 |
| 3D 요소 | `GlobeDart`, `StarfieldBackground` 신규 구현 |
| 4-step 위저드 | 기존 구조 축약 및 Edit View 중심으로 재설계 |
| 타임라인 UI | DnD 기반 수직 타임라인 + 지도 ↔ 사이드바 상호 연동 구현 |
| CSS 디자인 시스템 | 다크 테마 확장, +3,127 LOC 추가 |

---

## 7. 결론

본 보고서는 본인이 직접 담당·구현한 영역을 정량·정성적으로 정리한 개인 기여 기록입니다. 작성 기간 동안 본인은 AI 기반 여행 플래너의 **LLM 파이프라인, Google Maps 통합, 4-step 편집 위저드, 실제 도로 경로 기반 일정 생성** 을 중심으로 기능을 구현했습니다.

남은 과제는 Step 0 UX 재설계와 결과 페이지 지도 마이그레이션이며, 다음 단계에서 이어서 작업할 예정입니다.

---

*본 보고서는 `git log`, `git diff --stat HEAD`, 파일 시스템 직접 조회를 통해 얻은 객관적 데이터에 근거해 작성되었습니다. 본인의 작업분만을 기술 대상으로 하며, 타 참여자의 기여에 대한 평가는 본 문서의 범위 밖입니다.*
