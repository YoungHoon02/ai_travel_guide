import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { timeToMinutes } from "../utils.js";
import { nearestSlot } from "../utils.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, "0"); }

function minutesUntil(timeStr, nowMins) {
  const target = timeToMinutes(timeStr);
  return target - nowMins;
}

function formatCountdown(mins) {
  if (mins <= 0) return "지남";
  if (mins < 60) return `${mins}분 남음`;
  return `${Math.floor(mins / 60)}시간 ${mins % 60}분 남음`;
}

function formatDistM(m) {
  if (!Number.isFinite(m) || m === Infinity) return null;
  if (m < 1000) return `${m}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

function formatRevisionTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toLocaleString("ko-KR", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── SlotCard ────────────────────────────────────────────────────────────────

function SlotCard({ slot, label, nowMins, userLatLng, onDone, onSkip, onDelay, isPrimary }) {
  if (!slot) return null;
  const startMins = timeToMinutes(slot.startTime);
  const endMins = timeToMinutes(slot.endTime);
  const inProgress = nowMins >= startMins && nowMins < endMins;
  const overdue = nowMins >= endMins && slot.status !== "done" && slot.status !== "skipped";
  const countdownMins = minutesUntil(slot.startTime, nowMins);

  const distInfo = (() => {
    if (!userLatLng || !Array.isArray(slot.latlng)) return null;
    const { distM, proximity } = nearestSlot([slot], userLatLng, slot.day);
    return { distM, proximity };
  })();

  return (
    <div className={`ttv-slot-card${isPrimary ? " ttv-slot-card--primary" : " ttv-slot-card--next"}${overdue ? " ttv-slot-card--overdue" : ""}`}>
      <div className="ttv-slot-card__label">{label}</div>
      <div className="ttv-slot-card__name">{slot.name}</div>
      <div className="ttv-slot-card__meta">
        <span>{slot.startTime} – {slot.endTime}</span>
        {slot.area && <span>· {slot.area}</span>}
        {slot.category && <span>· {slot.category}</span>}
      </div>
      <div className="ttv-slot-card__sub">
        {inProgress && <span className="ttv-badge ttv-badge--active">진행 중</span>}
        {overdue && <span className="ttv-badge ttv-badge--warn">시간 초과</span>}
        {!inProgress && !overdue && countdownMins > 0 && (
          <span className="ttv-badge">{formatCountdown(countdownMins)}</span>
        )}
        {distInfo && (
          <span className={`ttv-badge ttv-badge--${distInfo.proximity}`}>
            {distInfo.proximity === "arrived" ? "도착" :
             distInfo.proximity === "nearby" ? `근처 ${formatDistM(distInfo.distM)}` :
             `${formatDistM(distInfo.distM)} 거리`}
          </span>
        )}
        {slot.status === "done" && <span className="ttv-badge ttv-badge--done">✓ 완료</span>}
        {slot.status === "skipped" && <span className="ttv-badge ttv-badge--skip">건너뜀</span>}
      </div>
      {isPrimary && slot.status !== "done" && slot.status !== "skipped" && (
        <div className="ttv-slot-card__actions">
          <button type="button" className="ttv-action ttv-action--done" onClick={() => onDone(slot.id)}>✓ 완료</button>
          <button type="button" className="ttv-action ttv-action--skip" onClick={() => onSkip(slot.id)}>건너뜀</button>
          <button type="button" className="ttv-action ttv-action--delay" onClick={() => onDelay(slot)}>⏱ 지연 보고</button>
          {Array.isArray(slot.latlng) && (
            <a
              className="ttv-action ttv-action--nav"
              href={`https://www.google.com/maps/dir/?api=1&destination=${slot.latlng[0]},${slot.latlng[1]}`}
              target="_blank"
              rel="noopener noreferrer"
            >🗺 길 안내</a>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RevisionPanel ───────────────────────────────────────────────────────────

function RevisionPanel({ revisions, onRestore }) {
  const [previewId, setPreviewId] = useState(null);
  const sorted = [...(revisions ?? [])].reverse();
  if (sorted.length === 0) {
    return (
      <div className="ttv-revision__empty">
        Co-Pilot 수정 이력이 없습니다.
      </div>
    );
  }
  return (
    <ul className="ttv-revision__list">
      {sorted.map((rev) => {
        const isPreviewing = previewId === rev.id;
        return (
          <li key={rev.id} className="ttv-revision__item">
            <div className="ttv-revision__item-header">
              <span className="ttv-revision__time">{formatRevisionTime(rev.triggeredAt)}</span>
              <span className="ttv-revision__trigger">{rev.triggerInput || rev.diffSummary || "—"}</span>
            </div>
            {rev.diffSummary && rev.triggerInput && (
              <div className="ttv-revision__summary">{rev.diffSummary}</div>
            )}
            <div className="ttv-revision__item-actions">
              <button
                type="button"
                className="ttv-revision__btn"
                onClick={() => setPreviewId(isPreviewing ? null : rev.id)}
              >
                {isPreviewing ? "닫기" : "변경 전 보기"}
              </button>
              {onRestore && (
                <button
                  type="button"
                  className="ttv-revision__btn ttv-revision__btn--restore"
                  onClick={() => { onRestore(rev.beforeSnapshot); setPreviewId(null); }}
                >
                  이 시점으로 되돌리기
                </button>
              )}
            </div>
            {isPreviewing && Array.isArray(rev.beforeSnapshot) && (
              <ul className="ttv-revision__snapshot">
                {rev.beforeSnapshot.filter((s) => s.kind === "activity").map((s) => (
                  <li key={s.id} className="ttv-revision__snapshot-item">
                    <span className="ttv-revision__snapshot-time">{s.startTime}</span>
                    <span>{s.name}</span>
                    {s.day && <span className="ttv-revision__snapshot-day">Day {s.day}</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ─── ToastQueue ──────────────────────────────────────────────────────────────

function Toast({ msg, onDismiss, onAction, actionLabel }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <motion.div
      className="ttv-toast"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
    >
      <span className="ttv-toast__msg">{msg}</span>
      <div className="ttv-toast__actions">
        {onAction && actionLabel && (
          <button type="button" className="ttv-toast__action" onClick={onAction}>{actionLabel}</button>
        )}
        <button type="button" className="ttv-toast__dismiss" onClick={onDismiss}>✕</button>
      </div>
    </motion.div>
  );
}

// ─── TripTimeView ─────────────────────────────────────────────────────────────

/**
 * TripTimeView — "여행 중" 화면.
 *
 * Props:
 *   schedule: Slot[]
 *   currentDay: number           — 오늘이 트립 몇일차
 *   currentTimeStr: string       — "HH:MM"
 *   nowMins: number              — minutes since midnight
 *   userLatLng: {lat, lng}|null
 *   isGpsTracking: boolean
 *   onStartGps: () => void
 *   gpsError: string|null
 *   planRevisions: PlanRevision[]    — plan.revisions from store
 *   onSlotStatus: (slotId, status) => void   — "done" | "skipped"
 *   onDelayCopilot: (slotName) => void       — prefill Co-Pilot prompt
 *   onRestoreRevision: (beforeSnapshot) => void
 *   onClose: () => void
 */
export default function TripTimeView({
  schedule,
  currentDay,
  currentTimeStr,
  nowMins,
  userLatLng,
  isGpsTracking,
  onStartGps,
  gpsError,
  planRevisions,
  onSlotStatus,
  onDelayCopilot,
  onRestoreRevision,
  onClose,
}) {
  const [viewDay, setViewDay] = useState(currentDay);
  const [sidePanel, setSidePanel] = useState(null); // null | "revision"
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const deviationFiredRef = useRef(new Set());

  const maxDay = schedule.reduce((m, s) => Math.max(m, s.day), 0);

  // Sync viewDay when currentDay changes (new trip day).
  useEffect(() => { setViewDay(currentDay); }, [currentDay]);

  const addToast = useCallback((msg, opts = {}) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, msg, ...opts }]);
    return id;
  }, []);
  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Activity slots for the viewed day, sorted by startTime.
  const daySlots = schedule
    .filter((s) => s.kind === "activity" && s.day === viewDay)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  // Current and next slots based on real time (only applies to currentDay).
  const { currentSlot, nextSlot } = (() => {
    if (viewDay !== currentDay) return { currentSlot: null, nextSlot: null };
    let cur = null;
    let nxt = null;
    for (const s of daySlots) {
      const start = timeToMinutes(s.startTime);
      const end = timeToMinutes(s.endTime);
      if (nowMins >= start && nowMins < end && s.status !== "done" && s.status !== "skipped") {
        cur = s;
      } else if (nowMins < start && s.status !== "done" && s.status !== "skipped" && !nxt) {
        nxt = s;
      }
    }
    if (!cur && !nxt) nxt = daySlots.find((s) => s.status !== "done" && s.status !== "skipped") ?? null;
    return { currentSlot: cur, nextSlot: cur ? nxt : null };
  })();

  const displayPrimary = currentSlot ?? nextSlot ?? daySlots[0] ?? null;
  const displayNext = currentSlot ? nextSlot : (nextSlot ? daySlots[daySlots.indexOf(nextSlot) + 1] ?? null : null);

  // A4 — 이탈 알림: GPS 위치가 현재 슬롯에서 2km 이상 벗어나면 toast 1회.
  useEffect(() => {
    if (!userLatLng || !displayPrimary || viewDay !== currentDay) return;
    if (displayPrimary.status === "done" || displayPrimary.status === "skipped") return;
    const { distM } = nearestSlot([displayPrimary], userLatLng, currentDay);
    const key = `dev-${displayPrimary.id}`;
    if (distM > 2000 && !deviationFiredRef.current.has(key)) {
      deviationFiredRef.current.add(key);
      addToast(
        `현재 위치가 [${displayPrimary.name}]에서 ${formatDistM(distM)} 떨어져 있어요. 일정 조정이 필요한가요?`,
        {
          actionLabel: "Co-Pilot에 물어보기",
          onAction: () => onDelayCopilot?.(displayPrimary.name),
        }
      );
    }
    // Reset key if user returned within range.
    if (distM <= 2000) deviationFiredRef.current.delete(key);
  }, [userLatLng, displayPrimary, currentDay, viewDay, addToast, onDelayCopilot]);

  // A4 — 종료 시각 초과 알림 (5분 이상).
  useEffect(() => {
    if (!displayPrimary || viewDay !== currentDay) return;
    if (displayPrimary.status === "done" || displayPrimary.status === "skipped") return;
    const overMins = nowMins - timeToMinutes(displayPrimary.endTime);
    const key = `overdue-${displayPrimary.id}`;
    if (overMins >= 5 && !deviationFiredRef.current.has(key)) {
      deviationFiredRef.current.add(key);
      addToast(
        `[${displayPrimary.name}] 종료 시각을 ${overMins}분 넘겼어요. 다음 일정 출발을 권장합니다.`,
        {
          actionLabel: "지연 보고",
          onAction: () => onDelayCopilot?.(displayPrimary.name),
        }
      );
    }
  }, [nowMins, displayPrimary, currentDay, viewDay, addToast, onDelayCopilot]);

  return (
    <div className="ttv">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="ttv-header">
        <div className="ttv-header__left">
          <span className="ttv-header__time">{currentTimeStr}</span>
          <span className="ttv-header__day">Day {viewDay} / {maxDay}</span>
        </div>
        <div className="ttv-header__right">
          {!isGpsTracking ? (
            <button
              type="button"
              className="ttv-gps-btn"
              onClick={onStartGps}
              title={gpsError === "denied" ? "위치 권한 거부됨" : "GPS 추적 시작"}
              disabled={gpsError === "denied"}
            >
              {gpsError === "denied" ? "📍 권한 없음" : "📍 GPS 시작"}
            </button>
          ) : (
            <span className="ttv-gps-active">
              📍 {userLatLng ? `${userLatLng.lat.toFixed(3)}, ${userLatLng.lng.toFixed(3)}` : "위치 확인 중…"}
            </span>
          )}
          <button
            type="button"
            className={`ttv-panel-btn${sidePanel === "revision" ? " active" : ""}`}
            onClick={() => setSidePanel((p) => p === "revision" ? null : "revision")}
            title="수정 이력"
          >
            수정 이력 {planRevisions?.length ? `(${planRevisions.length})` : ""}
          </button>
          <button type="button" className="ttv-close-btn" onClick={onClose} title="편집 뷰로 돌아가기">✕</button>
        </div>
      </div>

      {/* ── Day navigation ─────────────────────────────────────── */}
      {maxDay > 1 && (
        <div className="ttv-day-nav">
          <button type="button" className="ttv-day-nav__btn" disabled={viewDay <= 1} onClick={() => setViewDay((d) => d - 1)}>‹</button>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <button
              key={d}
              type="button"
              className={`ttv-day-nav__dot${d === viewDay ? " active" : ""}${d === currentDay ? " today" : ""}`}
              onClick={() => setViewDay(d)}
              title={d === currentDay ? `Day ${d} (오늘)` : `Day ${d}`}
            >
              {d}
            </button>
          ))}
          <button type="button" className="ttv-day-nav__btn" disabled={viewDay >= maxDay} onClick={() => setViewDay((d) => d + 1)}>›</button>
        </div>
      )}

      {/* ── Main body ──────────────────────────────────────────── */}
      <div className="ttv-body">
        <div className="ttv-main">
          {daySlots.length === 0 ? (
            <div className="ttv-empty">Day {viewDay} 일정이 없습니다.</div>
          ) : (
            <>
              <SlotCard
                slot={displayPrimary}
                label={currentSlot ? "진행 중" : "다음 일정"}
                nowMins={nowMins}
                userLatLng={userLatLng}
                onDone={(id) => onSlotStatus?.(id, "done")}
                onSkip={(id) => onSlotStatus?.(id, "skipped")}
                onDelay={(slot) => onDelayCopilot?.(slot.name)}
                isPrimary
              />
              {displayNext && (
                <SlotCard
                  slot={displayNext}
                  label="그 다음"
                  nowMins={nowMins}
                  userLatLng={userLatLng}
                  onDone={() => {}}
                  onSkip={() => {}}
                  onDelay={() => {}}
                  isPrimary={false}
                />
              )}

              {/* All slots minimap for the day */}
              <div className="ttv-timeline">
                {daySlots.map((s) => {
                  const isActive = s.id === displayPrimary?.id;
                  return (
                    <div
                      key={s.id}
                      className={`ttv-timeline__item${isActive ? " active" : ""}${s.status === "done" ? " done" : ""}${s.status === "skipped" ? " skipped" : ""}`}
                    >
                      <span className="ttv-timeline__time">{s.startTime}</span>
                      <span className="ttv-timeline__name">{s.name}</span>
                      {s.status === "done" && <span className="ttv-timeline__status">✓</span>}
                      {s.status === "skipped" && <span className="ttv-timeline__status">–</span>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* ── Revision side panel (B4) ──────────────────────────── */}
        <AnimatePresence>
          {sidePanel === "revision" && (
            <motion.div
              className="ttv-side-panel"
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="ttv-side-panel__header">
                <span>Co-Pilot 수정 이력</span>
                <button type="button" className="ttv-close-btn" onClick={() => setSidePanel(null)}>✕</button>
              </div>
              <div className="ttv-side-panel__body">
                <RevisionPanel
                  revisions={planRevisions}
                  onRestore={onRestoreRevision}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Toasts (A4) ────────────────────────────────────────── */}
      <div className="ttv-toast-queue">
        <AnimatePresence>
          {toasts.map((t) => (
            <Toast
              key={t.id}
              msg={t.msg}
              actionLabel={t.actionLabel}
              onAction={t.onAction}
              onDismiss={() => removeToast(t.id)}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
