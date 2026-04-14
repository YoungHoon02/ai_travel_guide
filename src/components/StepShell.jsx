import { motion } from "framer-motion";
import { LAST_WIZARD_STEP, fadeSlide, transitionSpring } from "../constants.js";

export default function StepShell({ stepIndex, title, children, onPrev, onNext, nextDisabled = false, nextLabel }) {
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
