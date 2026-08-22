import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryFinancialCouncilPolicyRepository,
  type FinancialCouncilPolicyRepository
} from "./financial-council-policy-repository.js";
import { policyCommand, policyVersion, policyWorkspace } from
  "./financial-council-policy-test-support.js";

export function registerFinancialCouncilPolicyRepositoryContract(
  label: string,
  factory: () => FinancialCouncilPolicyRepository
) {
  test(`${label}: default is materialized once and isolated by workspace`,
    async () => {
      const repository = factory();
      const ws1 = policyWorkspace("ws-1");
      const first = await repository.getOrCreateActive(
        ws1, policyVersion("ws-1")
      );
      const same = await repository.getOrCreateActive(
        ws1, policyVersion("ws-1", 1, { createdAt: "2027-01-01T00:00:00.000Z" })
      );
      const other = await repository.getOrCreateActive(
        policyWorkspace("ws-2"), policyVersion("ws-2")
      );
      assert.deepEqual(same, first);
      assert.equal(other.workspaceId, "ws-2");
      assert.notDeepEqual(other, first);
      assert.equal(await repository.findVersion(
        policyWorkspace("ws-3"), first.policyVersionId
      ), null);
    });

  test(`${label}: only the named server default can initialize a workspace`,
    async () => {
      const repository = factory();
      await assert.rejects(repository.getOrCreateActive(
        policyWorkspace(),
        policyVersion("ws-1", 1, { policyVersionId: "caller-default" })
      ), /financial_council_policy_default_invalid/u);
      assert.equal(await repository.findActive(policyWorkspace()), null);
    });

  test(`${label}: immutable activation has CAS and exact command replay`,
    async () => {
      const repository = factory();
      const context = policyWorkspace();
      const initial = await repository.getOrCreateActive(
        context, policyVersion()
      );
      const next = policyVersion("ws-1", 2);
      const command = policyCommand();
      const created = await repository.createVersion(command, next);
      const replay = await repository.createVersion(command,
        policyVersion("ws-1", 2, { policyVersionId: "ignored-retry-id" }));
      assert.equal(created.replayed, false);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.value, next);
      assert.deepEqual(await repository.findVersion(context,
        initial.policyVersionId), initial);
      assert.deepEqual(await repository.findActive(context), next);
      assert.equal(Object.isFrozen(replay.value), true);
    });

  test(`${label}: changed replay, stale revision and cross-workspace fail closed`,
    async () => {
      const repository = factory();
      await repository.getOrCreateActive(
        policyWorkspace(), policyVersion()
      );
      await repository.createVersion(policyCommand(), policyVersion("ws-1", 2));
      await assert.rejects(repository.createVersion(policyCommand({
        requestHash: `sha256:${"b".repeat(64)}`
      }), policyVersion("ws-1", 3)),
      /financial_council_policy_idempotency_conflict/u);
      await assert.rejects(repository.createVersion(policyCommand({
        key: "stale", expectedRevision: 1,
        requestHash: `sha256:${"c".repeat(64)}`
      }), policyVersion("ws-1", 3)),
      /financial_council_policy_revision_conflict/u);
      await assert.rejects(repository.createVersion(policyCommand({
        key: "cross", expectedRevision: 2,
        requestHash: `sha256:${"d".repeat(64)}`
      }), policyVersion("ws-2", 3)),
      /financial_council_policy_workspace_mismatch/u);
    });
}

registerFinancialCouncilPolicyRepositoryContract(
  "memory policy repository",
  () => new InMemoryFinancialCouncilPolicyRepository()
);
