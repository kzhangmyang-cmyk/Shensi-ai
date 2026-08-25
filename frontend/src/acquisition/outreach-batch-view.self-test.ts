import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import { renderOutreachBatchView } from "./outreach-batch-view";

const { document } = parseHTML("<main id='host'></main>");
const host = document.querySelector<HTMLElement>("#host")!;
renderOutreachBatchView(host, { phase: "idle", batch: null, drafts: {}, actions: [], error: null, conflict: false, closed: false });
assert.match(host.textContent ?? "", /选择候选人后生成待审批批次/u);
assert.doesNotMatch(host.innerHTML, /accountHandle|cookie|leaseToken/iu);
console.log(JSON.stringify({ ok: true, suite: "outreach-batch-view" }));
