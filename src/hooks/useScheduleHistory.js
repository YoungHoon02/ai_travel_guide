import { useCallback, useState } from "react";

/**
 * Schedule history hook — undo/redo stack for the TimeSlot SSOT.
 *
 * Replaces the bare useState pair `[schedule, setSchedule]` with a 3-bucket
 * model (past / present / future) so any user-initiated schedule mutation —
 * Co-Pilot apply, drag/toggle, lodging swap, refine — can be reverted with a
 * single click. System-initiated mutations (initial itinerary load, wizard
 * restart) bypass the stack via `resetSchedule` so undo never pops back to an
 * empty starting state.
 *
 * Standard behavior: a fresh `commitSchedule` clears the redo stack, matching
 * how every text editor and every other undo system in the world works.
 *
 * Stack cap: MAX_HISTORY entries (oldest dropped). Caps both directions so an
 * extended undo→redo→undo session can't balloon memory.
 */
const MAX_HISTORY = 20;

export function useScheduleHistory(initial = []) {
  const [state, setState] = useState({ past: [], present: initial, future: [] });

  // Push current present to past, replace present, drop redo stack.
  const commitSchedule = useCallback((next) => {
    setState((s) => {
      const value = typeof next === "function" ? next(s.present) : next;
      if (value === s.present) return s; // no-op identity update
      return {
        past: [...s.past, s.present].slice(-MAX_HISTORY),
        present: value,
        future: [],
      };
    });
  }, []);

  // Replace present without touching history (initial load, wizard restart).
  // Also clears history so old entries don't cross trip boundaries.
  const resetSchedule = useCallback((next) => {
    setState({ past: [], present: typeof next === "function" ? next([]) : (next ?? []), future: [] });
  }, []);

  // Patch present in place without pushing past or clearing future. Used for
  // transparent system-driven enrichments (geocoding hydration, etc.) where
  // the user didn't make a change and shouldn't see undo step into a state
  // missing the enrichment.
  const patchSchedule = useCallback((updater) => {
    setState((s) => {
      const value = typeof updater === "function" ? updater(s.present) : updater;
      if (value === s.present) return s;
      return { ...s, present: value };
    });
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      if (s.past.length === 0) return s;
      const previous = s.past[s.past.length - 1];
      return {
        past: s.past.slice(0, -1),
        present: previous,
        future: [s.present, ...s.future].slice(0, MAX_HISTORY),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[0];
      return {
        past: [...s.past, s.present].slice(-MAX_HISTORY),
        present: next,
        future: s.future.slice(1),
      };
    });
  }, []);

  return {
    schedule: state.present,
    commitSchedule,
    resetSchedule,
    patchSchedule,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
