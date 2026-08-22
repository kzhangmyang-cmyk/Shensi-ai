import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";

test("in-memory acquisition transactions are reentrant in the same async context", async () => {
  const repository = new InMemoryAcquisitionDomainRepository();
  const outcome = await Promise.race([
    repository.transaction(async () =>
      repository.transaction(async () => "nested-complete")
    ),
    new Promise<string>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("nested acquisition transaction deadlocked")),
        25
      );
    })
  ]);
  assert.equal(outcome, "nested-complete");
});

test("a nested failure rolls back the outer in-memory transaction", async () => {
  const repository = new InMemoryAcquisitionDomainRepository();
  await assert.rejects(
    repository.transaction(async () => {
      await repository.appendEvidence({
        id: "evidence-rolled-back",
        ownerId: "owner-transaction",
        teamId: "team-transaction",
        targetType: "organization",
        sourcePlatform: "authorized_test",
        sourceTitle: "应回滚",
        sourceSnippet: "嵌套事务失败时不能遗留证据",
        publishedAt: null,
        fetchedAt: "2026-07-24T00:00:00.000Z",
        locale: "zh-CN",
        rawArtifactHash: `sha256:${"a".repeat(64)}`,
        contentHash: `sha256:${"b".repeat(64)}`,
        provenance: {
          kind: "user_submitted_url",
          sourceUrl: "https://example.cn/public",
          submittedBy: "actor-transaction"
        },
        accessStatus: "public_content",
        supersedesEvidenceId: null
      });
      await repository.transaction(async () => {
        throw new Error("nested failure");
      });
    }),
    /nested failure/u
  );
  assert.equal(
    await repository.findEvidence(
      { ownerId: "owner-transaction", teamId: "team-transaction" },
      "evidence-rolled-back"
    ),
    null
  );
});

