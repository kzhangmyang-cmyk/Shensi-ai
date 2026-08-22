import assert from "node:assert/strict";
import {
  ACQUISITION_LEGACY_MODEL_CONTENT_BUNDLE,
  ACQUISITION_LEGACY_MODEL_CONTENT_HASHES,
  ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  ACQUISITION_MODEL_CONTENT_BUNDLE,
  ACQUISITION_MODEL_CONTENT_HASHES,
  ACQUISITION_MODEL_PROMPT_VERSION,
  ACQUISITION_MODEL_SCHEMA_VERSION,
  ACQUISITION_PREVIOUS_MODEL_CONTENT_BUNDLE,
  ACQUISITION_PREVIOUS_MODEL_CONTENT_HASHES,
  ACQUISITION_PREVIOUS_MODEL_PROMPT_VERSION,
  ACQUISITION_PREVIOUS_MODEL_SCHEMA_VERSION,
  ACQUISITION_PLAN_DRAFT_PROMPT_ID,
  ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL,
  ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID,
  acquisitionModelContentForSnapshot
} from "./acquisition-model-content.js";

const copilotPrompt =
  ACQUISITION_MODEL_CONTENT_BUNDLE.promptTemplates[
    "acquisition.pi.turn.v1"
  ];
const judgmentPrompt =
  ACQUISITION_MODEL_CONTENT_BUNDLE.promptTemplates[
    "acquisition.judgment.v1"
  ];
const judgmentTools =
  ACQUISITION_MODEL_CONTENT_BUNDLE.toolSchemas[
    "acquisition.judgment.v1"
  ];

assert.equal(
  ACQUISITION_MODEL_PROMPT_VERSION,
  "acquisition-model-prompt-bundle.v5"
);
assert.equal(
  ACQUISITION_MODEL_SCHEMA_VERSION,
  "acquisition-model-schema-bundle.v6"
);
assert.equal(
  ACQUISITION_PREVIOUS_MODEL_PROMPT_VERSION,
  "acquisition-model-prompt-bundle.v4"
);
assert.equal(
  ACQUISITION_PREVIOUS_MODEL_SCHEMA_VERSION,
  "acquisition-model-schema-bundle.v3"
);
assert.equal(
  ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  "acquisition-model-prompt-bundle.v3"
);
assert.equal(
  ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  "acquisition-model-schema-bundle.v2"
);
assert.deepEqual(ACQUISITION_LEGACY_MODEL_CONTENT_HASHES, {
  promptHash:
    "sha256:5c840bb642766df13767c21139ccd8ed0709d60b5aeac04d4736e39e383b519b",
  schemaHash:
    "sha256:eda863c053daa21ba9a6d56a8fc11d466d50818d6f8c300d9223442372f04686"
});
assert.match(
  copilotPrompt ?? "",
  /企业公开需求[\s\S]*个人公开经营需求/
);
assert.match(
  copilotPrompt ?? "",
  /至少两个独立信号/
);
assert.match(
  copilotPrompt ?? "",
  /意向资格[\s\S]*财务价值[\s\S]*客户作战卡[\s\S]*人工审核/
);
assert.match(
  copilotPrompt ?? "",
  /未指定搜索连接[\s\S]*自动使用[\s\S]*已启用/
);
assert.match(
  judgmentPrompt ?? "",
  /事实[\s\S]*推断[\s\S]*未知/
);
assert.match(
  judgmentPrompt ?? "",
  /最小货币单位[\s\S]*基点/
);
assert.deepEqual(
  judgmentTools?.map((tool) => tool.name),
  ["__goodjob_submit_acquisition_judgment"]
);
assert.equal(
  Array.isArray(judgmentTools?.[0]?.parameters.oneOf),
  true
);
const judgmentParameters = judgmentTools?.[0]?.parameters as {
  oneOf: Array<any>;
} | undefined;
const battleCardVariant = judgmentParameters?.oneOf.find(
  (variant: any) =>
    variant?.properties?.operation?.const === "build_battle_card"
);
assert.ok(battleCardVariant);
assert.deepEqual(
  Object.keys(battleCardVariant.properties.result.properties).sort(),
  [
    "accountOverview",
    "buyingCommittee",
    "connectionStrategies",
    "doNotActions",
    "needAssessment",
    "procurementPreferences",
    "roleSpecificOpeners",
    "supplierHypotheses"
  ]
);
assert.equal(
  "financialSummary" in battleCardVariant.properties.result.properties,
  false
);

const planDraftPrompt =
  ACQUISITION_MODEL_CONTENT_BUNDLE.promptTemplates[
    ACQUISITION_PLAN_DRAFT_PROMPT_ID
  ];
const planDraftTools =
  ACQUISITION_MODEL_CONTENT_BUNDLE.toolSchemas[
    ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID
  ];
assert.match(
  planDraftPrompt ?? "",
  /语义意图[\s\S]*连接 ID[\s\S]*凭据版本[\s\S]*operationId[\s\S]*模型快照[\s\S]*预算分配/
);
assert.deepEqual(
  planDraftTools?.map((tool) => tool.name),
  [ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL]
);
assert.equal(
  ACQUISITION_LEGACY_MODEL_CONTENT_BUNDLE.promptTemplates[
    ACQUISITION_PLAN_DRAFT_PROMPT_ID
  ],
  undefined
);
assert.equal(
  ACQUISITION_LEGACY_MODEL_CONTENT_BUNDLE.toolSchemas[
    ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID
  ],
  undefined
);

function assertObjectsAreClosed(schema: unknown) {
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object") {
    assert.equal(record.additionalProperties, false);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      value.forEach(assertObjectsAreClosed);
    } else {
      assertObjectsAreClosed(value);
    }
  }
}

assertObjectsAreClosed(planDraftTools?.[0]?.parameters);
assert.equal(
  acquisitionModelContentForSnapshot({
    promptVersion: ACQUISITION_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_MODEL_CONTENT_HASHES
  }),
  ACQUISITION_MODEL_CONTENT_BUNDLE
);
assert.equal(
  acquisitionModelContentForSnapshot({
    promptVersion: ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_LEGACY_MODEL_CONTENT_HASHES
  }),
  ACQUISITION_LEGACY_MODEL_CONTENT_BUNDLE
);
assert.equal(
  acquisitionModelContentForSnapshot({
    promptVersion: ACQUISITION_PREVIOUS_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_PREVIOUS_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_PREVIOUS_MODEL_CONTENT_HASHES
  }),
  ACQUISITION_PREVIOUS_MODEL_CONTENT_BUNDLE
);
for (const snapshot of [{
  promptVersion: "acquisition-model-prompt-bundle.v999",
  schemaVersion: ACQUISITION_MODEL_SCHEMA_VERSION,
  ...ACQUISITION_MODEL_CONTENT_HASHES
}, {
  promptVersion: ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  schemaVersion: ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  ...ACQUISITION_LEGACY_MODEL_CONTENT_HASHES,
  promptHash: "sha256:unknown-legacy-prompt"
}]) {
  assert.throws(
    () => acquisitionModelContentForSnapshot(snapshot),
    /MODEL_CONTENT_HASH_MISMATCH/
  );
}

console.log("acquisition model content tests passed");
