import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { loadPlans, deletePlan, updatePlan } from "../store/plans.js";

/**
 * PlanLibraryModal — list / open / rename / delete localStorage Plans.
 *
 * Props:
 *   isOpen: boolean
 *   onClose: () => void
 *   currentPlanId: string | null   — highlight the plan tied to the live schedule
 *   onOpenPlan: (plan) => void     — caller will load schedule + jump to result step
 *   onAfterChange?: () => void     — called after rename/delete so caller can refresh dependent state
 */
export default function PlanLibraryModal({
  isOpen,
  onClose,
  currentPlanId = null,
  onOpenPlan,
  onAfterChange,
}) {
  const [plans, setPlans] = useState([]);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const refresh = useCallback(() => {
    const loaded = loadPlans();
    loaded.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    setPlans(loaded);
  }, []);

  useEffect(() => {
    if (isOpen) refresh();
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const handleRenameStart = (plan) => {
    setRenamingId(plan.id);
    setRenameValue(plan.name);
  };
  const handleRenameSave = (planId) => {
    const next = renameValue.trim();
    if (next) updatePlan(planId, { name: next });
    setRenamingId(null);
    setRenameValue("");
    refresh();
    onAfterChange?.();
  };
  const handleDelete = (planId) => {
    deletePlan(planId);
    setConfirmDeleteId(null);
    refresh();
    onAfterChange?.();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="hotel-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="plan-library"
            initial={{ y: 30, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 30, scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="plan-library__header">
              <h2 className="plan-library__title">📂 내 플랜 ({plans.length})</h2>
              <button
                type="button"
                className="hotel-modal__close"
                onClick={onClose}
                title="닫기 (ESC)"
              >
                &times;
              </button>
            </div>

            <div className="plan-library__body">
              {plans.length === 0 ? (
                <div className="plan-library__empty">
                  저장된 플랜이 없습니다. 일정 생성 시 자동으로 저장됩니다.
                </div>
              ) : (
                <ul className="plan-library__list">
                  {plans.map((plan) => {
                    const isCurrent = plan.id === currentPlanId;
                    const isRenaming = renamingId === plan.id;
                    const isConfirmingDelete = confirmDeleteId === plan.id;
                    const dayCount = plan.dates?.days ?? plan.days?.length ?? 0;
                    const updatedShort = plan.updatedAt
                      ? new Date(plan.updatedAt).toLocaleString("ko-KR", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "";
                    const revisionCount = plan.revisions?.length ?? 0;

                    return (
                      <li
                        key={plan.id}
                        className={`plan-library__item${isCurrent ? " is-current" : ""}`}
                      >
                        <div className="plan-library__item-main">
                          {isRenaming ? (
                            <input
                              className="plan-library__rename-input"
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleRenameSave(plan.id);
                                if (e.key === "Escape") {
                                  setRenamingId(null);
                                  setRenameValue("");
                                }
                              }}
                              onBlur={() => handleRenameSave(plan.id)}
                            />
                          ) : (
                            <strong className="plan-library__item-name">
                              {plan.name || "(이름 없음)"}
                              {isCurrent && (
                                <span className="plan-library__badge">현재</span>
                              )}
                            </strong>
                          )}
                          <div className="plan-library__item-meta">
                            <span>
                              {plan.destination?.city || plan.destination?.country || "—"}
                            </span>
                            <span>·</span>
                            <span>{dayCount ? `${dayCount}일` : "기간 미정"}</span>
                            {plan.dates?.start && (
                              <>
                                <span>·</span>
                                <span>{plan.dates.start}</span>
                              </>
                            )}
                            {revisionCount > 0 && (
                              <>
                                <span>·</span>
                                <span>수정 {revisionCount}회</span>
                              </>
                            )}
                          </div>
                          {updatedShort && (
                            <div className="plan-library__item-updated">
                              마지막 저장 {updatedShort}
                            </div>
                          )}
                        </div>

                        <div className="plan-library__item-actions">
                          {isConfirmingDelete ? (
                            <>
                              <button
                                type="button"
                                className="plan-library__btn plan-library__btn--danger"
                                onClick={() => handleDelete(plan.id)}
                              >
                                삭제 확정
                              </button>
                              <button
                                type="button"
                                className="plan-library__btn"
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                취소
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="plan-library__btn plan-library__btn--primary"
                                onClick={() => onOpenPlan?.(plan)}
                              >
                                열기
                              </button>
                              <button
                                type="button"
                                className="plan-library__btn"
                                onClick={() => handleRenameStart(plan)}
                              >
                                이름변경
                              </button>
                              <button
                                type="button"
                                className="plan-library__btn plan-library__btn--ghost"
                                onClick={() => setConfirmDeleteId(plan.id)}
                              >
                                삭제
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
