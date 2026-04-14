/**
 * Plan store — localStorage adapter (Phase 1)
 *
 * Shape matches PROJECT_PLAN.md multi-level schema. Phase 2 (Supabase) will
 * replace this file's implementation; public API stays the same.
 *
 * @typedef {Object} Plan
 * @property {string} id
 * @property {string} name
 * @property {{country: string, city: string, latlng: [number, number] | null}} destination
 * @property {{start: string | null, end: string | null, nights: number | null, days: number | null}} dates
 * @property {string} rawInput
 * @property {string[]} preferences
 * @property {"draft" | "planning" | "ready" | "active" | "done"} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | null} createdBy
 * @property {PlanDay[]} days
 * @property {PlanRevision[]} revisions
 *
 * @typedef {Object} PlanDay
 * @property {string} id
 * @property {string} planId
 * @property {number} dayNumber
 * @property {string | null} date
 * @property {string | null} theme
 * @property {string | null} notes
 * @property {PlanItem[]} items
 *
 * @typedef {Object} PlanItem
 * @property {string} id
 * @property {string} dayId
 * @property {number} seq
 * @property {"content" | "meal" | "move" | "lodging" | "break"} type
 * @property {string} name
 * @property {string | null} startTime
 * @property {string | null} endTime
 * @property {number | null} durationMin
 * @property {[number, number] | null} latlng
 * @property {Object} meta
 * @property {"planned" | "in_progress" | "done" | "skipped" | "modified"} status
 * @property {string | null} originalItemId
 *
 * @typedef {Object} PlanRevision
 * @property {string} id
 * @property {string} planId
 * @property {string} triggeredAt
 * @property {"user_input" | "auto" | "manual"} triggerType
 * @property {string} triggerInput
 * @property {PlanItem[]} beforeSnapshot
 * @property {PlanItem[]} afterSnapshot
 * @property {string} diffSummary
 */

const STORAGE_KEY = "ai_travel_guide:plans:v1";

function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function nowIso() {
  return new Date().toISOString();
}

function readRaw() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(plans) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(plans));
  } catch (err) {
    console.warn("[plans store] write failed", err);
  }
}

/** @returns {Plan[]} */
export function loadPlans() {
  return readRaw();
}

/** @param {string} id @returns {Plan | null} */
export function getPlan(id) {
  return readRaw().find((p) => p.id === id) ?? null;
}

/**
 * Create a new plan with sensible defaults. Caller can pass partial init.
 * @param {Partial<Plan>} init
 * @returns {Plan}
 */
export function createPlan(init = {}) {
  /** @type {Plan} */
  const plan = {
    id: init.id ?? uid(),
    name: init.name ?? "새 여행 플랜",
    destination: init.destination ?? { country: "", city: "", latlng: null },
    dates: init.dates ?? { start: null, end: null, nights: null, days: null },
    rawInput: init.rawInput ?? "",
    preferences: init.preferences ?? [],
    status: init.status ?? "draft",
    createdAt: init.createdAt ?? nowIso(),
    updatedAt: init.updatedAt ?? nowIso(),
    createdBy: init.createdBy ?? null,
    days: init.days ?? [],
    revisions: init.revisions ?? [],
  };
  const plans = readRaw();
  plans.push(plan);
  writeRaw(plans);
  return plan;
}

/**
 * Shallow-merge patch into an existing plan.
 * @param {string} id
 * @param {Partial<Plan>} patch
 * @returns {Plan | null}
 */
export function updatePlan(id, patch) {
  const plans = readRaw();
  const idx = plans.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const merged = { ...plans[idx], ...patch, updatedAt: nowIso() };
  plans[idx] = merged;
  writeRaw(plans);
  return merged;
}

/** @param {string} id */
export function deletePlan(id) {
  const plans = readRaw().filter((p) => p.id !== id);
  writeRaw(plans);
}

/** Replace full plans array (used for debugging / import). */
export function replaceAllPlans(plans) {
  writeRaw(Array.isArray(plans) ? plans : []);
}

/** Clear storage entirely. */
export function clearPlans() {
  writeRaw([]);
}

// ── Day / Item helpers ────────────────────────────────────────────────────

export function addDay(planId, dayInit = {}) {
  const plan = getPlan(planId);
  if (!plan) return null;
  const dayNumber = dayInit.dayNumber ?? (plan.days?.length ?? 0) + 1;
  const day = {
    id: "d_" + uid(),
    planId,
    dayNumber,
    date: dayInit.date ?? null,
    theme: dayInit.theme ?? null,
    notes: dayInit.notes ?? null,
    items: dayInit.items ?? [],
  };
  const days = [...(plan.days ?? []), day];
  updatePlan(planId, { days });
  return day;
}

export function addItem(planId, dayId, itemInit) {
  const plan = getPlan(planId);
  if (!plan) return null;
  const days = (plan.days ?? []).map((d) => {
    if (d.id !== dayId) return d;
    const seq = itemInit.seq ?? (d.items?.length ?? 0) + 1;
    const item = {
      id: "i_" + uid(),
      dayId,
      seq,
      type: itemInit.type ?? "content",
      name: itemInit.name ?? "",
      startTime: itemInit.startTime ?? null,
      endTime: itemInit.endTime ?? null,
      durationMin: itemInit.durationMin ?? null,
      latlng: itemInit.latlng ?? null,
      meta: itemInit.meta ?? {},
      status: itemInit.status ?? "planned",
      originalItemId: itemInit.originalItemId ?? null,
    };
    return { ...d, items: [...(d.items ?? []), item] };
  });
  updatePlan(planId, { days });
  return true;
}

export function addRevision(planId, revisionInit) {
  const plan = getPlan(planId);
  if (!plan) return null;
  const revision = {
    id: "r_" + uid(),
    planId,
    triggeredAt: nowIso(),
    triggerType: revisionInit.triggerType ?? "user_input",
    triggerInput: revisionInit.triggerInput ?? "",
    beforeSnapshot: revisionInit.beforeSnapshot ?? [],
    afterSnapshot: revisionInit.afterSnapshot ?? [],
    diffSummary: revisionInit.diffSummary ?? "",
  };
  const revisions = [...(plan.revisions ?? []), revision];
  updatePlan(planId, { revisions });
  return revision;
}
