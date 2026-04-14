# AI Travel Guide — Project Plan

졸업작품 / Baby Toy Project. AI 기반 여행 플래너 + 실시간 내비게이션형 동행 앱.

---

## 비전

**두 가지 핵심 기능을 가진 여행 앱:**

### 1. AI Planning

- 사용자가 목적지 / 일정 / 취향을 입력 → LLM 이 상세 일정 생성
- 입력 방식은 **자연어 우선** — "따뜻할 때 3박4일 가고 싶어" 같은 문장도 파싱
- 구조화된 입력(달력 선택, 숙박수 선택)도 동시에 지원
- 생성된 플랜은 수정 / 저장 / 재생성 가능

### 2. Live Co-Pilot (실시간 동행)

- 여행지에서 앱을 열고 당일 일정 따라감
- **돌발 상황** 발생 시 자연어로 입력:
  - "늦잠 자서 12시에 일어남"
  - "비가 와서 오늘 야외 일정 못 가"
  - "이 식당 1시간 웨이팅 있음"
- LLM 이 남은 일정을 **최단거리 / 우선순위 기반**으로 실시간 재조정
- 수정 이력은 audit trail 로 보존 (before/after snapshot)

---

## 데이터 스키마 (Multi-Level)

localStorage → Supabase 로의 마이그레이션을 전제로 설계. Phase 1 은 localStorage 에 nested JSON 으로 저장하되, shape 은 Supabase 테이블 스키마와 동일하게 맞춰둠.

### Level 1 — `plans` (최상위 플랜 메타)

```ts
{
  id: string (uuid)
  name: string                    // "도쿄 2박3일"
  destination: {
    country: string
    city: string
    latlng: [number, number] | null
  }
  dates: {
    start: string | null          // "YYYY-MM-DD"
    end: string | null
    nights: number | null
    days: number | null
  }
  rawInput: string                // 자연어 원본 "따뜻할 때 3박4일"
  preferences: string[]           // ["미식", "자연", "힐링"]
  status: "draft" | "planning" | "ready" | "active" | "done"
  createdAt: string (ISO)
  updatedAt: string (ISO)
  createdBy: string | null        // 현재는 null, 추후 user id
}
```

### Level 2 — `plan_days` (일자별)

```ts
{
  id: string
  planId: string                  // fk → plans.id
  dayNumber: number               // 1, 2, 3
  date: string | null             // "YYYY-MM-DD"
  theme: string | null            // "아사쿠사 탐방"
  notes: string | null
}
```

### Level 3 — `plan_items` (일정 항목)

```ts
{
  id: string
  dayId: string                   // fk → plan_days.id
  seq: number                     // 순서
  type: "content" | "meal" | "move" | "lodging" | "break"
  name: string
  startTime: string | null        // "09:00"
  endTime: string | null          // "10:30"
  durationMin: number | null
  latlng: [number, number] | null
  meta: object                    // { category, score, img, notes, ... }
  status: "planned" | "in_progress" | "done" | "skipped" | "modified"
  originalItemId: string | null   // Live Co-Pilot 재조정 시 원본 참조
}
```

### Level 4 — `plan_revisions` (Live Co-Pilot audit trail)

```ts
{
  id: string
  planId: string                  // fk → plans.id
  triggeredAt: string (ISO)
  triggerType: "user_input" | "auto" | "manual"
  triggerInput: string            // "늦잠 자서 12시에 일어남"
  beforeSnapshot: PlanItem[]      // 수정 전
  afterSnapshot: PlanItem[]       // 수정 후
  diffSummary: string             // LLM 요약
}
```

### Level 5 — `plan_logs` (LLM 호출 로그, 선택적)

기존 `llmLogs` 상태와 통합 가능. 플랜별로 분리 저장.

---

## 저장소 전략

### Phase 1 — localStorage (현재)

- Key: `ai_travel_guide:plans:v1`
- Value: `Plan[]` — 각 plan 이 nested 로 `days[]`, `days[].items[]`, `revisions[]` 을 보유
- 간단하고 빠름, 서버 비용 0

### Phase 2 — Supabase

- 위 5개 테이블로 normalize
- Row-Level Security 적용해 나중에 계정 붙일 때 대비
- Store 인터페이스(`src/store/plans.js`) 는 동일, 구현체만 교체

---

## 기술 스택

- **Frontend**: React + Vite + framer-motion
- **Styling**: CSS (MGS cyber 테마)
- **Maps**: React-Leaflet + Google Maps Places API
- **LLM**: OpenAI / Gemini / Claude (env 로 provider 전환 가능, [src/api.js](src/api.js))
- **Storage**: localStorage (Phase 1) → Supabase (Phase 2)

---

## 로드맵

### ✅ 완료

- [x] 기본 wizard flow (7 단계)
- [x] Destination 선택 (Globe + AI 추천)
- [x] Itinerary 생성 (LLM)
- [x] LLM 통신 로그 사이드바
- [x] 실시간 상태 바 / 변수 조치 패널 / 모달 대화
- [x] Mobile Preview (iPhone 15 Pro 목업 팝업, draggable + collapsible)
- [x] Vitest 단위 테스트 (53개)

### 🚧 진행 중 (현재 페이즈)

- [ ] **Plan 스키마 + localStorage store** (`src/store/plans.js`)
- [ ] **AutoDetect 일정 입력** — 단일 input 에서 자연어 / 구조화 자동 감지 + LLM 파싱
- [ ] Step 0 (플랜 설정) 안에서 지역 확정 후 일정 입력 패널이 animation 으로 슬라이드 인 (기존 Step 1 "지역/일정" 흡수)

### 📋 다음

- [ ] Plan 목록 / 수정 / 삭제 UI
- [ ] Live Co-Pilot 모드 — 여행 당일 뷰, 위치 기반 현재 일정 하이라이트
- [ ] 자연어 재조정 입력 → LLM diff → revision 기록
- [ ] Supabase 마이그레이션

---

## 현재 작업 메모

- iPhone 목업은 **시연/데모용**. 실제 반응형 개발은 Chrome DevTools 기준.
- `?mockup=1` 쿼리로 iframe 모드 구분 → 무한 중첩 방지
- AutoDetect 입력은 이 프로젝트의 UX 하이라이트 — LLM 파싱 + 구조화 필드 프리뷰를 같이 보여서 모호성 해소
