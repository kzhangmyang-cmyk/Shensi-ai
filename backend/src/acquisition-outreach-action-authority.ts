import { canonicalJsonStringify } from "./canonical-json.js";
import { crawlerOutreachFinalizationState,
  type AcquisitionCrawlerJob } from "./acquisition-crawler-job.js";
import { discoveryEvidencePublicSourceUrl,
  type AcquisitionCandidate, type DiscoveryEvidence } from "./acquisition-domain.js";
import { orderedCandidateEvidenceIds, selectDouyinCandidateEvidence } from
  "./acquisition-douyin-evidence-selection.js";
import { validDirectMessageClaimAuthority,
  type DesktopOutreachClaimAuthoritySnapshot } from
  "./acquisition-outreach-batch-repository.js";
import type { AcquisitionOutreachAction, AcquisitionOutreachBatch } from
  "./acquisition-outreach-batch.js";
import type { AcquisitionRun } from "./acquisition-plan-run-repository.js";
import type { VerifiedOutreachDraftAuthority } from
  "./acquisition-outreach-draft-authority.js";

export type OutreachActionAuthority =
  | { accountHandle: string }
  | { failureCode: "approval_authority_changed" };

export interface DouyinOutreachFeatureFlags {
  approvalsEnabled: boolean;
  serverExecutionEnabled: boolean;
  desktopExecutionEnabled: boolean;
}

export function resolveDouyinOutreachFeatureFlags(environment: {
  approvals?: unknown;
  serverExecution?: unknown;
  desktopExecution?: unknown;
  DOUYIN_OUTREACH_APPROVALS_ENABLED?: unknown;
  DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED?: unknown;
  DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED?: unknown;
}, gateway: unknown): DouyinOutreachFeatureFlags {
  const exactBoolean = (value: unknown, name: string) => {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new TypeError(`${name} must be exactly true or false`);
  };
  const approvalsEnabled = exactBoolean(environment.approvals
    ?? environment.DOUYIN_OUTREACH_APPROVALS_ENABLED,
  "DOUYIN_OUTREACH_APPROVALS_ENABLED");
  const serverExecutionEnabled = exactBoolean(environment.serverExecution
    ?? environment.DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED,
  "DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED");
  const desktopExecutionEnabled = exactBoolean(environment.desktopExecution
    ?? environment.DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED,
  "DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED");
  if (serverExecutionEnabled
    && typeof (gateway as { executeAction?: unknown } | null)?.executeAction !== "function") {
    throw new TypeError(
      "DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED requires a MediaCrawler gateway"
    );
  }
  return Object.freeze({ approvalsEnabled, serverExecutionEnabled,
    desktopExecutionEnabled });
}

interface AuthorityAccount {
  state: string;
  accountHandle: string | null;
  displayName: string | null;
  loginStateVersion: number | null;
}

interface AuthorityPolicyVersion {
  id: string;
  policyHash: string;
  schedule: { timeZone: string };
}

export interface LockedOutreachCandidateAuthorityInput {
  scope: { workspaceId: string; ownerId: string; teamId: string; actorId: string };
  candidateId: string;
  publicActorKey: string;
}

export function createAcquisitionOutreachActionAuthority(options: {
  findBatch(workspaceId: string, batchId: string): Promise<AcquisitionOutreachBatch | null>;
  listActions(workspaceId: string, batchId: string): Promise<AcquisitionOutreachAction[] | null>;
  findAccount(workspaceId: string, accountId: string): Promise<AuthorityAccount | null>;
  findRun(runId: string): Promise<Pick<AcquisitionRun, "ownerId" | "teamId"> | null>;
  findCrawlerJob(workspaceId: string, runId: string): Promise<AcquisitionCrawlerJob | null>;
  listPolicyVersions(workspaceId: string, planId: string): Promise<AuthorityPolicyVersion[]>;
  findCandidate(scope: { workspaceId: string; ownerId: string; teamId: string;
    actorId: string }, candidateId: string): Promise<AcquisitionCandidate | null>;
  findEvidence(scope: { workspaceId: string; ownerId: string; teamId: string;
    actorId: string }, evidenceId: string): Promise<DiscoveryEvidence | null>;
  hasDoNotContact(scope: { workspaceId: string; ownerId: string; teamId: string;
    actorId: string }, publicActorKey: string): Promise<boolean>;
  loadLockedCandidateAuthority?(input: LockedOutreachCandidateAuthorityInput):
    Promise<VerifiedOutreachDraftAuthority | null>;
}) {
  return Object.freeze({
    async resolve(value: AcquisitionOutreachAction | DesktopOutreachClaimAuthoritySnapshot,
      actorId: string): Promise<OutreachActionAuthority | null> {
      const locked = "action" in value ? value : null;
      const action = locked?.action ?? value as AcquisitionOutreachAction;
      const [batch, account, actions] = locked
        ? [locked.batch, locked.account, locked.siblings] as const
        : await Promise.all([
          options.findBatch(action.workspaceId, action.batchId),
          options.findAccount(action.workspaceId, action.accountId),
          options.listActions(action.workspaceId, action.batchId)
        ]);
      const predecessor = locked?.predecessor
        ?? actions?.find((candidate) => candidate.id === action.predecessorActionId);
      if (!batch || batch.accountId !== action.accountId
        || (!(action.kind === "direct_message" && action.authorizationVersion === 3)
          && batch.accountLoginStateVersion !== action.accountLoginStateVersion)
        || (action.kind === "comment"
        ? batch.state !== "approved" || batch.revision !== action.batchRevision
          || batch.approvalHash !== action.approvalHash
        : !validDirectMessageClaimAuthority(action, batch, predecessor))) {
        return { failureCode: "approval_authority_changed" };
      }
      if (!account || account.state !== "active"
        || !/^dyacct_[0-9a-f]{64}$/u.test(account.accountHandle ?? "")
        || !account.displayName?.trim()
        || account.loginStateVersion !== action.accountLoginStateVersion) return null;
      const frozen = batch.candidates.find((value) => value.candidateId === action.candidateId);
      if (!frozen || (action.kind === "comment"
        ? frozen.commentHash !== action.contentHash
          || frozen.commentTargetPublicUrl !== action.targetPublicUrl
        : frozen.publicProfileUrl !== action.targetPublicUrl)) {
        return { failureCode: "approval_authority_changed" };
      }
      const [authoritativeRun, crawlerJob, policyVersions] = await Promise.all([
        options.findRun(batch.runId),
        options.findCrawlerJob(action.workspaceId, batch.runId),
        options.listPolicyVersions(action.workspaceId, batch.planId)
      ]);
      const policy = policyVersions.find((value) => value.id === batch.policyVersionId);
      if (!authoritativeRun || !crawlerJob || !policy
        || crawlerOutreachFinalizationState(crawlerJob) !== "ready"
        || policy.policyHash !== batch.policyHash
        || policy.schedule.timeZone !== batch.timeZone
        || crawlerJob.policyVersionId !== batch.policyVersionId
        || crawlerJob.policyHash !== batch.policyHash
        || crawlerJob.accountId !== batch.accountId
        // The source login stays on the immutable collection. Send authority
        // is the exact current account/batch/action version checked above.
        || crawlerJob.accountLoginStateVersion > batch.accountLoginStateVersion
        || crawlerJob.dailyBudgetId !== batch.dailyBudgetId
        || crawlerJob.localDate !== batch.localDate
        || crawlerJob.dailyCandidateLimit !== batch.dailyCandidateLimit) {
        return { failureCode: "approval_authority_changed" };
      }
      const scope = { workspaceId: action.workspaceId,
        ownerId: authoritativeRun.ownerId, teamId: authoritativeRun.teamId, actorId };
      let verified: VerifiedOutreachDraftAuthority | null;
      if (locked) {
        if (!options.loadLockedCandidateAuthority) {
          return { failureCode: "approval_authority_changed" };
        }
        verified = await options.loadLockedCandidateAuthority({
          scope, candidateId: action.candidateId, publicActorKey: frozen.publicActorKey
        });
      } else {
        const candidate = await options.findCandidate(scope, action.candidateId);
        if (!candidate) return { failureCode: "approval_authority_changed" };
        const evidence = await Promise.all(orderedCandidateEvidenceIds(candidate).map((id) =>
          options.findEvidence(scope, id)));
        if (evidence.some((item) => !item)) {
          return { failureCode: "approval_authority_changed" };
        }
        verified = { candidate, evidence: evidence.filter(
          (item): item is DiscoveryEvidence => Boolean(item)) };
      }
      const candidate = verified?.candidate;
      if (!candidate || candidate.version !== frozen.candidateRevision
        || candidate.profile.kind !== "individual"
        || candidate.profile.publicActorKey !== frozen.publicActorKey
        || candidate.profile.publicProfileUrl !== frozen.publicProfileUrl) {
        return { failureCode: "approval_authority_changed" };
      }
      const exactVideoEvidence = selectDouyinCandidateEvidence(
        verified!.evidence as readonly DiscoveryEvidence[],
        { requireVideo: true });
      const exactVideoUrl = exactVideoEvidence
        ? discoveryEvidencePublicSourceUrl(exactVideoEvidence) : null;
      const hashes = verified!.evidence.map((value) => value.contentHash).sort();
      if (canonicalJsonStringify(hashes)
          !== canonicalJsonStringify([...frozen.evidenceHashes].sort())
        || exactVideoUrl !== frozen.commentTargetPublicUrl
        || verified!.candidate.status === "do_not_contact"
        || (!locked && await options.hasDoNotContact(scope, frozen.publicActorKey))) {
        return { failureCode: "approval_authority_changed" };
      }
      return { accountHandle: account.accountHandle! };
    }
  });
}
