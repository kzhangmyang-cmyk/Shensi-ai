import { strict as assert } from "node:assert";
import { growthHash, parseGrowthHash } from "./router";

assert.deepEqual(parseGrowthHash("#growth/advisor"), { name: "advisor" });
assert.deepEqual(parseGrowthHash("#financial-council"), {
  name: "financial-council"
});
assert.deepEqual(parseGrowthHash("#financial-council/run/run%20%2F%201"), {
  name: "financial-council",
  runId: "run / 1"
});
assert.deepEqual(
  parseGrowthHash("#growth/quotes?case=case-1&deal=deal-1"),
  { name: "quote", quoteCaseId: "case-1", dealId: "deal-1" }
);
assert.deepEqual(
  parseGrowthHash("#growth/roi?cohort=cohort-1&currency=CNY&closure=closure-2"),
  {
    name: "roi",
    cohortId: "cohort-1",
    currency: "CNY",
    closureVersionId: "closure-2"
  }
);
assert.equal(growthHash({ name: "finance" }), "#growth/finance");
assert.equal(
  growthHash({ name: "financial-council", runId: "run / 1" }),
  "#financial-council/run/run%20%2F%201"
);
assert.equal(parseGrowthHash("#acquisition"), null);
assert.equal(parseGrowthHash("#growth/unknown"), null);
assert.equal(
  growthHash({
    name: "quote",
    quoteCaseId: "case-1",
    candidateId: "candidate-1"
  }),
  "#growth/quotes?case=case-1&candidate=candidate-1"
);
assert.equal(
  growthHash({ name: "roi", currency: "USD" }),
  "#growth/roi?currency=USD"
);
