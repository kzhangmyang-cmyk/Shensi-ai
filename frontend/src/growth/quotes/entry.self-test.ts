import { strict as assert } from "node:assert";
import {
  quoteEntryHash
} from "./entry";

assert.equal(
  quoteEntryHash({
    candidateId: "candidate-1",
    customerId: "customer-1",
    dealId: "deal-1",
    assignedTo: "sales-1"
  }),
  "#growth/quotes?candidate=candidate-1&customer=customer-1&deal=deal-1&assignee=sales-1"
);
assert.equal(
  quoteEntryHash({ quoteCaseId: "case-1" }),
  "#growth/quotes?case=case-1"
);
assert.equal(quoteEntryHash({}), "#growth/quotes");
