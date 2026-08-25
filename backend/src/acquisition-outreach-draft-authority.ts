import type { AcquisitionCandidate, DiscoveryEvidence } from "./acquisition-domain.js";
import type { AcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import { createHash } from "node:crypto";

export interface OutreachDraftAuthorityScope { workspaceId: string; ownerId: string; teamId: string; }
export interface VerifiedOutreachDraftAuthority { candidate: Readonly<AcquisitionCandidate>; evidence: readonly Readonly<DiscoveryEvidence>[]; }
export interface OutreachDraftAuthorityRequest {
  scope: OutreachDraftAuthorityScope;
  candidateId: string;
  evidenceIds: readonly string[];
  publicActorKey: string;
  expectedCandidate: AcquisitionCandidate;
  expectedEvidence: readonly DiscoveryEvidence[];
}
export interface AcquisitionOutreachDraftFinalAuthorityPort {
  verify(input: OutreachDraftAuthorityRequest): Promise<VerifiedOutreachDraftAuthority>;
}

function changed(): never { throw new Error("OUTREACH_CANDIDATE_AUTHORITY_CHANGED"); }
function same(left: unknown, right: unknown) { return canonicalJsonStringify(left) === canonicalJsonStringify(right); }
function dncIdentity(publicActorKey: string) { return `dnc:sha256:${createHash("sha256").update(`douyin\u0000${publicActorKey}`, "utf8").digest("hex")}`; }
function freeze(candidate: AcquisitionCandidate, evidence: DiscoveryEvidence[]): VerifiedOutreachDraftAuthority {
  return Object.freeze({ candidate: Object.freeze(structuredClone(candidate)), evidence: Object.freeze(evidence.map((item) => Object.freeze(structuredClone(item)))) });
}

/** Memory implementation runs on the repository's shared transaction coordinator.
 * The DNC port must use the same workspace/identity lock as its writer. */
export class InMemoryAcquisitionOutreachDraftFinalAuthority
implements AcquisitionOutreachDraftFinalAuthorityPort {
  constructor(private readonly options: {
    domain: AcquisitionDomainRepository;
    withLockedDnc<T>(scope: OutreachDraftAuthorityScope, publicActorKey: string, work: () => Promise<T>): Promise<T>;
    hasDoNotContact(scope: OutreachDraftAuthorityScope, publicActorKey: string): Promise<boolean>;
  }) {}
  verify(input: OutreachDraftAuthorityRequest) {
    return this.options.domain.transaction(() => this.options.withLockedDnc(input.scope, input.publicActorKey, async () => {
      const candidate = await this.options.domain.findCandidate(input.scope, input.candidateId);
      const evidence = await Promise.all(input.evidenceIds.map((id) => this.options.domain.findEvidence(input.scope, id)));
      if (!candidate || evidence.some((item) => !item) || await this.options.hasDoNotContact(input.scope, input.publicActorKey)) changed();
      const rows = evidence as DiscoveryEvidence[];
      if (!same(candidate, input.expectedCandidate) || !same(rows, input.expectedEvidence)) changed();
      return freeze(candidate, rows);
    }));
  }
}

/** MySQL implementation locks candidate, exact evidence membership, and the
 * DNC primary-key gap before loading and comparing the complete authority. */
export class MysqlAcquisitionOutreachDraftFinalAuthority
implements AcquisitionOutreachDraftFinalAuthorityPort {
  constructor(private readonly options: {
    pool: { getConnection(): Promise<{ beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; query(sql: string, values?: unknown[]): Promise<unknown>; }> };
    load(input: OutreachDraftAuthorityRequest, connection: { query(sql: string, values?: unknown[]): Promise<unknown> }): Promise<{ candidate: AcquisitionCandidate | null; evidence: Array<DiscoveryEvidence | null>; dnc: boolean }>;
  }) {}
  async verify(input: OutreachDraftAuthorityRequest) {
    const connection = await this.options.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT id FROM acquisition_candidates WHERE id = ? AND owner_id = ? AND team_id = ? FOR UPDATE", [input.candidateId, input.scope.ownerId, input.scope.teamId]);
      for (const evidenceId of input.evidenceIds) {
        await connection.query("SELECT id FROM acquisition_discovery_evidence WHERE id = ? AND owner_id = ? AND team_id = ? FOR UPDATE", [evidenceId, input.scope.ownerId, input.scope.teamId]);
      }
      await connection.query("SELECT identity_hash FROM acquisition_douyin_do_not_contact WHERE workspace_id = ? AND identity_hash = ? FOR UPDATE", [input.scope.workspaceId, dncIdentity(input.publicActorKey)]);
      // Read through the locked connection so the comparison observes the
      // same transaction/locking boundary as the preceding point locks.
      const loaded = await this.options.load(input, connection);
      if (!loaded.candidate || loaded.evidence.some((item) => !item) || loaded.dnc || !same(loaded.candidate, input.expectedCandidate) || !same(loaded.evidence, input.expectedEvidence)) changed();
      const value = freeze(loaded.candidate, loaded.evidence as DiscoveryEvidence[]);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
}
