# AI Travel Planner Prototype (React)

교수님 시연용 단계 전환 프로토타입입니다.

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속

## 시연 흐름

1. 나라/지역/일정 선택
2. 여행 성향(역사유적, 쇼핑 등) 선택
3. LLM 컨텐츠 추천 화면에서 방문지 선택
4. LLM 이동옵션 추천 화면에서 교통 방식 선택
5. 최종 플랜 화면(사이드바 일정표 + 지도 핀/경로 + 클릭 정보)

## 기술 포인트

- React 기반 멀티 스텝 UI
- `framer-motion` 화면 전환 애니메이션
- `react-leaflet` 지도 핀/경로 상호작용

## 메모

- 현재는 키 없이 즉시 시연 가능하도록 OSM 타일 지도를 사용
- Google Maps API 키를 연결하면 동일한 흐름으로 확장 가능
