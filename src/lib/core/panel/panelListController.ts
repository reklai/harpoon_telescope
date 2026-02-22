// Shared list-navigation math for overlay panels.
// Keeps wheel, arrow, and half-page movement behavior consistent.

export type PanelListDirection = "up" | "down";

export function clampPanelListIndex(length: number, index: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, index));
}

export function movePanelListIndex(
  length: number,
  currentIndex: number,
  delta: number,
): number {
  if (length <= 0) return -1;
  const safeCurrent = clampPanelListIndex(length, currentIndex);
  return clampPanelListIndex(length, safeCurrent + delta);
}

export function movePanelListIndexByDirection(
  length: number,
  currentIndex: number,
  direction: PanelListDirection,
): number {
  return movePanelListIndex(length, currentIndex, direction === "down" ? 1 : -1);
}

export function movePanelListIndexHalfPage(
  length: number,
  currentIndex: number,
  halfPageStep: number,
  direction: PanelListDirection,
): number {
  if (length <= 0) return -1;
  const step = Math.max(1, halfPageStep);
  return movePanelListIndex(length, currentIndex, direction === "down" ? step : -step);
}

export function movePanelListIndexFromWheel(
  length: number,
  currentIndex: number,
  wheelDeltaY: number,
): number {
  if (length <= 0) return -1;
  const direction: PanelListDirection = wheelDeltaY > 0 ? "down" : "up";
  return movePanelListIndexByDirection(length, currentIndex, direction);
}

export function resolveVisibleSelection(
  visibleIndices: number[],
  selectedIndex: number,
): number {
  if (visibleIndices.length === 0) return -1;
  if (visibleIndices.includes(selectedIndex)) return selectedIndex;
  return visibleIndices[0];
}

export function moveVisibleSelection(
  visibleIndices: number[],
  selectedIndex: number,
  delta: number,
): number {
  if (visibleIndices.length === 0) return -1;
  const currentPos = Math.max(0, visibleIndices.indexOf(resolveVisibleSelection(visibleIndices, selectedIndex)));
  const nextPos = Math.max(0, Math.min(visibleIndices.length - 1, currentPos + delta));
  return visibleIndices[nextPos];
}

export function moveVisibleSelectionByDirection(
  visibleIndices: number[],
  selectedIndex: number,
  direction: PanelListDirection,
): number {
  return moveVisibleSelection(visibleIndices, selectedIndex, direction === "down" ? 1 : -1);
}

export function moveVisibleSelectionHalfPage(
  visibleIndices: number[],
  selectedIndex: number,
  halfPageStep: number,
  direction: PanelListDirection,
): number {
  if (visibleIndices.length === 0) return -1;
  const step = Math.max(1, halfPageStep);
  return moveVisibleSelection(visibleIndices, selectedIndex, direction === "down" ? step : -step);
}

export function moveVisibleSelectionFromWheel(
  visibleIndices: number[],
  selectedIndex: number,
  wheelDeltaY: number,
): number {
  const direction: PanelListDirection = wheelDeltaY > 0 ? "down" : "up";
  return moveVisibleSelectionByDirection(visibleIndices, selectedIndex, direction);
}
