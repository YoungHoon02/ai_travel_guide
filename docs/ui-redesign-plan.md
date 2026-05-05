# UI/UX 개선 계획

작성: 2026-04-23

## 배경

현재 UI는 시각적으로 정돈돼 있으나, 일반 사용자 테스트에서 **"지금 뭘 해야 할지 모르겠다"** 는 접근성/usability 피드백을 받음. 이에 따라 IA(정보구조)부터 다시 설계하기로 결정.

## 현재 상태 스냅샷

### 파일 규모
- [src/App.jsx](src/App.jsx) — 2,408 lines (단일 컴포넌트가 모든 step 분기 관리)
- [src/styles.css](src/styles.css) — 5,486 lines
- 20개 컴포넌트, 총 ~12,000 lines

### IA 구조 (4-step wizard)
| # | 라벨 | 실제 작업 | 주요 컴포넌트 |
|---|------|----------|--------------|
| 0 | 여행지 | 자유 텍스트 input → AI가 목적지 후보 추천, 지도 프리뷰 | GlobeDart, DestCardGrid, DestPreviewMap, AutoDetectPlanInput |
| 1 | 일정 | 국가/지역/일수 확정 | (step0-grid 재사용) |
| 2 | 여행 구성 | 날짜별 스팟/숙소 편집, 드래그 재정렬 | CopilotPanel, HotelBrowseModal, GoogleMapView |
| 3 | 최종 플랜 | 결과 뷰 | PlanCarousel3D, PlanCardRow |

### 레이아웃 (step0-grid, step 0~2 공통)
- A: 큰 상단 영역 (지도/결과/편집 뷰)
- B: 220px 고정 행 (타이틀/테마 칩/폼)
- C: 220px 고정 행 (플랜 캐러셀/액션)

## 진단: "무슨 액션을 해야할지 모름" 근본 원인

### 1. Step 라벨이 추상명사
"여행지 · 일정 · 여행 구성 · 최종 플랜" — 각 step에서 *어떤 결정을 해야 나가는지* 가 라벨로 드러나지 않음. 사용자는 진입 후 화면 스캔으로 목적을 역추론해야 함.

### 2. Primary CTA 불명확
- Step 0 첫 진입 시 글로브, 테마 칩, 자유 입력창이 동시에 보임 ([App.jsx:1644-1674](src/App.jsx#L1644-L1674)). 어떤 것이 "주 입력 경로"인지 시각적 가중치 부족.
- B/C 영역의 버튼들이 step별로 의미 바뀌는데 라벨이 짧고 일관성 없음.

### 3. B/C 영역의 역할 불투명
220px 고정 행 2개가 항상 보이지만 step마다 내용 교체됨. 섹션 타이틀/구분선/"이 칸은 뭐하는 곳"이 부재 → 화면 분할은 됐으나 **정보 위계는 전달 안 됨**.

### 4. "다음" 게이트 조건이 암묵적
각 step의 `canProceed` 로직 ([App.jsx:734-738](src/App.jsx#L734-L738)) 은 있으나, **어떤 조건을 만족하면 다음으로 가는지** 화면에 명시 안 됨. 사용자는 버튼이 언제 활성화되는지 시행착오로 학습.

### 5. 상태 피드백 부재
AI 호출 중, 후보 생성 중, 저장 중 등 pending 상태가 spinner 수준이라 **"지금 무슨 일이 일어나고 있는지"** 설명 부족.

## 개선 방향 제안

### 원칙
1. **매 step 최상단에 "이 화면에서 할 일" 1줄 카피** — 추상 라벨 대신 동사형 문장
2. **Primary CTA 하나만 시각적 강조** — 나머지는 secondary 톤 다운
3. **진입 시 보이는 요소 축소** — 불필요한 옵션은 progressive disclosure
4. **WCAG AA 기준 contrast / 44x44 최소 터치 영역** 통과
5. **Focus ring, keyboard nav, aria-label** 전면 점검

### 후보 IA (Phase별)

#### Phase 1 — 최소 침습 (라벨·카피·CTA 위계만 손보기)
- Step 라벨을 동사형으로 변경 (예: "여행지 정하기" / "일정 맞추기" / "하루하루 짜기" / "완성!")
- 각 step 상단에 1줄 안내 카피 영역 추가 (B 상단 20~30px, B/C 고정 높이 내부 재배치)
- Primary/secondary 버튼 스타일 재정의
- 리스크 낮음, 효과는 "몰라서 막힘" 해소에 즉효

#### Phase 2 — B/C 영역 재정의
- B/C 각각에 작은 섹션 타이틀 + 아이콘 부여
- B = "지금 편집 중인 것", C = "다음 액션" 식의 의미 고정
- 220px 고정 제약 유지 (메모리 선호 반영)

#### Phase 3 — Step 0 진입 flow 재설계
- 글로브 / 테마 칩 / 자유 입력창 중 **하나를 기본 노출** + 나머지는 "다른 방식으로 고르기" 링크
- "FSD BETA" 토글 위치/설명 명확화

#### Phase 4 — 상태/피드백 레이어
- AI 호출 pending 시 "무엇을 하는 중"인지 카피로 노출 (`dest-a__status` 확장)
- 에러/빈 상태 UI 일관화

### 후보 IA (재구성 옵션)

**Option R1 — 4-step 유지, 카피/시각만 재설계** (Phase 1~4 누적)
- 장점: 파일 구조 그대로, 위험 최소
- 단점: 본질적 flow 문제는 못 잡을 수도

**Option R2 — 3-step 통합 (여행지 + 일정을 한 화면)**
- "어디·언제" 한 번에 입력 → "하루별 구성" → "완료"
- 장점: step 하나 줄이면 인지 부담 감소
- 단점: 한 화면에 더 많은 입력 필드 → B/C 활용 재설계 필요

**Option R3 — Conversation-driven (chat-like)**
- AI가 대화로 정보 수집, 사용자는 답변만 하면 됨
- 장점: "뭘 해야 하지?" 가 질문으로 명확히 옴
- 단점: 대대적 재작업, 맵/편집 UX와 chat 병치 난이도

## 재개 시 확인할 항목 (퍼즈 지점)

- [ ] 위 Phase 1부터 순차 진행할지, Option R1/R2/R3 중 택일할지
- [ ] "B/C 220px 고정" 제약을 새 IA에서도 유지할지 (메모리에 기록돼 있음)
- [ ] 4-step 구조 유지 vs 3-step 통합 vs chat-driven
- [ ] 접근성 기준 목표 (WCAG AA 최소? AAA?)
- [ ] 기존 LLM prompt / store 로직은 재사용 전제인지

## 백업 상태

- `src/legacy/` 에 32 파일 / 620K 복사 완료 (2026-04-23)
- `main.jsx` / `tests/` 는 제외 (entry와 테스트는 새 UI 기준)
- `main.jsx` 에서 import되지 않으므로 런타임/번들 영향 없음

## 관련 파일

- [src/App.jsx:93](src/App.jsx#L93) — `step` state
- [src/App.jsx:734-738](src/App.jsx#L734-L738) — `canProceed` 게이트 로직
- [src/App.jsx:1296-1384](src/App.jsx#L1296-L1384) — step 0 조건부 렌더
- [src/constants.js:3](src/constants.js#L3) — `STEP_LABELS`
