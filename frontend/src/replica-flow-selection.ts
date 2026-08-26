type FlowCardState = Pick<HTMLElement, "getAttribute">;

export interface FlowCardSpacing {
  firstStep: number;
  nextStep: number;
}

export function getFlowCardSpacing(stageWidth: number): FlowCardSpacing {
  if (stageWidth < 390) return { firstStep: 74, nextStep: 52 };
  if (stageWidth < 620) return { firstStep: 108, nextStep: 78 };
  return { firstStep: 136, nextStep: 96 };
}

export function isSelectableFlowCard(card: FlowCardState): boolean {
  return card.getAttribute("aria-disabled") !== "true";
}

export function nextSelectableFlowIndex(
  cards: FlowCardState[],
  currentIndex: number,
  direction: number
): number {
  if (cards.length === 0 || direction === 0) return currentIndex;
  const step = direction > 0 ? 1 : -1;
  for (let distance = 1; distance <= cards.length; distance += 1) {
    const index = ((currentIndex + step * distance) % cards.length + cards.length)
      % cards.length;
    const candidate = cards[index];
    if (candidate && isSelectableFlowCard(candidate)) return index;
  }
  return currentIndex;
}
