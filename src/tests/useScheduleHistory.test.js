/**
 * Unit tests for src/hooks/useScheduleHistory.js
 *
 * Uses React Testing Library's renderHook to drive the hook through
 * commit/undo/redo/reset transitions and verify the past/present/future
 * stack semantics.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScheduleHistory } from "../hooks/useScheduleHistory.js";

const slotA = [{ id: "a", day: 1, kind: "activity", startTime: "09:00", name: "A" }];
const slotB = [{ id: "b", day: 1, kind: "activity", startTime: "10:00", name: "B" }];
const slotC = [{ id: "c", day: 1, kind: "activity", startTime: "11:00", name: "C" }];

describe("useScheduleHistory", () => {
  it("starts with no history (canUndo/canRedo both false)", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    expect(result.current.schedule).toEqual(slotA);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("commit pushes prev to past, sets present, clears future", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule(slotB));
    expect(result.current.schedule).toEqual(slotB);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("undo restores previous present, makes redo available", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule(slotB));
    act(() => result.current.undo());
    expect(result.current.schedule).toEqual(slotA);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("redo advances back to undone state", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule(slotB));
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(result.current.schedule).toEqual(slotB);
    expect(result.current.canRedo).toBe(false);
  });

  it("new commit after undo clears redo stack (standard behavior)", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule(slotB));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.commitSchedule(slotC));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.schedule).toEqual(slotC);
  });

  it("commit accepts functional updater", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule((prev) => [...prev, ...slotB]));
    expect(result.current.schedule).toEqual([...slotA, ...slotB]);
  });

  it("commit with identical reference is a no-op (no history push)", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule((prev) => prev));
    expect(result.current.canUndo).toBe(false);
  });

  it("resetSchedule clears history without leaving past entries", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule(slotB));
    act(() => result.current.commitSchedule(slotC));
    act(() => result.current.resetSchedule([]));
    expect(result.current.schedule).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("undo on empty history is safe no-op", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.undo());
    expect(result.current.schedule).toEqual(slotA);
  });

  it("redo on empty future is safe no-op", () => {
    const { result } = renderHook(() => useScheduleHistory(slotA));
    act(() => result.current.commitSchedule(slotB));
    act(() => result.current.redo());
    expect(result.current.schedule).toEqual(slotB);
  });

  it("caps past stack at MAX_HISTORY (20)", () => {
    const { result } = renderHook(() => useScheduleHistory([]));
    for (let i = 0; i < 25; i += 1) {
      act(() => result.current.commitSchedule([{ id: `s${i}`, day: 1, kind: "activity", startTime: "09:00", name: `S${i}` }]));
    }
    // Undo 20 times back to the entry that was at index 5 (oldest survivor).
    for (let i = 0; i < 20; i += 1) {
      act(() => result.current.undo());
    }
    expect(result.current.canUndo).toBe(false);
    // 21st undo should be no-op (oldest 5 dropped from cap).
    expect(result.current.schedule[0].id).toBe("s4");
  });
});
