import { strict as assert } from "node:assert";
import {
  quoteEntryHash
} from "./entry";

assert.equal(
  quoteEntryHash({
    candidateId: "candidate-1",
    dealId: "deal-1"
  }),
  "#growth/quotes?candidate=candidate-1&deal=deal-1"
);
assert.equal(
  quoteEntryHash({ quoteCaseId: "case-1" }),
  "#growth/quotes?case=case-1"
);
assert.equal(quoteEntryHash({}), "#growth/quotes");
