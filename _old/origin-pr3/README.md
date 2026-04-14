# `_old/origin-pr3/` — Archive of origin/main PR #3

## What is this?

이 폴더는 `origin/main` 에 있었던 **PR #3 (contingency handling)** 의 변경 파일을
**기록 보존 목적으로** 복사해 둔 스냅샷입니다. 현재 `main` 브랜치의 라이브 코드와는
연결되어 있지 않고, 참고용으로만 존재합니다.

## 왜 따로 보관하나?

`main` 브랜치의 최신 작업이 `src/App.jsx` 를 전면 리팩터(2,183 LOC) 하면서
기존 구조 대부분을 새 아키텍처로 대체했고, PR #3 의 `src/App.jsx` / `src/utils.js` /
`src/tests/utils.test.js` 변경분은 새 구조와 직접 머지하기에는 맥락이 달라진 상태였습니다.

해당 작업을 그대로 버리지 않기 위해 변경된 파일을 원본 그대로 이 폴더에 보존했고,
merge commit 은 `-s ours` 전략으로 기록하여 git 히스토리 상에서도 두 브랜치가
연결되어 있음을 표시했습니다.

## 원본 커밋 목록 (origin/main)

PR #3 에 포함된 commit (공통 조상 `821452a` 기준으로 origin/main 위에 쌓여 있던 6개):

```
b9f5f8a Merge pull request #3 from YoungHoon02/copilot/improve-user-intent-interpretation
3a9fe31 fix: ensure replacement recommendations keep minimum option count
6713695 feat: apply prioritized schedule replacement policy for contingency handling
f379b90 fix: polish cancellation prompt wording
cc49eaf feat: refine contingency handling with counter-questions and selectable recommendations
a33621b Initial plan
```

## 포함된 파일

| 경로 | 원본 경로 | 설명 |
|---|---|---|
| `src/App.jsx` | `src/App.jsx` | PR #3 의 App.jsx 수정본 (baseline 대비 +10 line) |
| `src/utils.js` | `src/utils.js` | contingency handling 유틸 추가 (+135 line) |
| `src/tests/utils.test.js` | `src/tests/utils.test.js` | 새 유틸에 대한 단위 테스트 (+61 line) |

## 다시 살리려면

이 폴더의 파일 중 특정 기능을 현재 코드에 다시 통합하고 싶다면:

1. 해당 파일을 열어 추가된 함수/로직 확인
2. 현재 `src/` 의 동일 경로 파일과 수동으로 대조
3. 필요한 부분만 선별해서 새 아키텍처 맥락에 맞게 재작성

단순히 파일을 덮어씌우는 것은 권장하지 않습니다 — 현재 `src/App.jsx` 는 4-step
wizard + Edit View 구조이고, PR #3 의 App.jsx 는 그 이전 구조이므로 구조적 호환성이
없습니다.

## 아카이브 시점

- 날짜: 2026-04-14
- 대상 브랜치: `origin/main` (PR #3 merge 완료 상태)
- 보관 사유: 새 아키텍처 리팩터로 인한 supersede merge
