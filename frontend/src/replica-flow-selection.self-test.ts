import { strict as assert } from "node:assert";
import {
  getFlowCardSpacing,
  isSelectableFlowCard,
  nextSelectableFlowIndex
} from "./replica-flow-selection";

function card(disabled = false) {
  return {
    getAttribute(name: string) {
      return name === "aria-disabled" && disabled ? "true" : null;
    }
  };
}

assert.equal(isSelectableFlowCard(card()), true);
assert.equal(isSelectableFlowCard(card(true)), false);

const cards = [card(), card(true), card(true), card(), card(true)];
assert.equal(nextSelectableFlowIndex(cards, 0, 1), 3);
assert.equal(nextSelectableFlowIndex(cards, 3, -1), 0);
assert.equal(nextSelectableFlowIndex(cards, 3, 1), 0);
assert.equal(nextSelectableFlowIndex([card(), card(true)], 0, 1), 0);

assert.deepEqual(
  getFlowCardSpacing(485),
  { firstStep: 108, nextStep: 78 },
  "compact platform stages must leave enough of the black side cards visible"
);
assert.deepEqual(
  getFlowCardSpacing(720),
  { firstStep: 170, nextStep: 112 },
  "wide platform stages must present the carousel as five discoverable cards"
);
assert.deepEqual(
  getFlowCardSpacing(360),
  { firstStep: 74, nextStep: 52 },
  "mobile stages must keep the outer cards inside the compact carousel"
);

console.log("replica flow selection self-test passed");
