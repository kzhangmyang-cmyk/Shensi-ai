import type {
  AcquisitionCandidate,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import type {
  AcquisitionDomainRepository,
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  douyinDoNotContactIdentityHash
} from "./acquisition-douyin-crawler-ingestion.js";
import type {
  InMemoryAcquisitionDouyinCrawlerIngestionRepository,
  MysqlAcquisitionDouyinCrawlerIngestionRepository
} from "./acquisition-douyin-crawler-ingestion-repository.js";
import type {
  MysqlAcquisitionDomainRepository
} from "./acquisition-mysql-repositories.js";
import { canonicalJsonStringify } from "./canonical-json.js";

export interface OutreachDraftAuthorityScope {
  workspaceId: string;
  ownerId: string;
  teamId: string;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface VerifiedOutreachDraftAuthority {
  candidate: DeepReadonly<AcquisitionCandidate>;
  evidence: readonly DeepReadonly<DiscoveryEvidence>[];
}

export interface OutreachDraftAuthorityRequest {
  scope: OutreachDraftAuthorityScope;
  candidateId: string;
  evidenceIds: readonly string[];
  publicActorKey: string;
  expectedCandidate: AcquisitionCandidate;
  expectedEvidence: readonly DiscoveryEvidence[];
}

export interface AcquisitionOutreachDraftFinalAuthorityPort {
  hasDoNotContact(
    scope: OutreachDraftAuthorityScope,
    publicActorKey: string
  ): Promise<boolean>;
  verify(
    input: OutreachDraftAuthorityRequest
  ): Promise<VerifiedOutreachDraftAuthority>;
}

function changed(): never {
  throw new Error("OUTREACH_CANDIDATE_AUTHORITY_CHANGED");
}

function same(left: unknown, right: unknown) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function freezeRecursively<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function immutableProjection(
  candidate: AcquisitionCandidate,
  evidence: DiscoveryEvidence[]
): VerifiedOutreachDraftAuthority {
  return freezeRecursively({
    candidate: structuredClone(candidate),
    evidence: structuredClone(evidence)
  });
}

async function compareAuthority(input: OutreachDraftAuthorityRequest, options: {
  domain: AcquisitionDomainRepository;
  hasDoNotContact(identityHash: string): Promise<boolean>;
}) {
  const candidate = await options.domain.findCandidate(
    input.scope,
    input.candidateId
  );
  const evidence = await Promise.all(input.evidenceIds.map((evidenceId) =>
    options.domain.findEvidence(input.scope, evidenceId)));
  if (!candidate || evidence.some((item) => !item)
    || await options.hasDoNotContact(
      douyinDoNotContactIdentityHash(input.publicActorKey)
    )) changed();
  const rows = evidence as DiscoveryEvidence[];
  if (!same(candidate, input.expectedCandidate)
    || !same(rows, input.expectedEvidence)) changed();
  return immutableProjection(candidate, rows);
}

export class InMemoryAcquisitionOutreachDraftFinalAuthority
implements AcquisitionOutreachDraftFinalAuthorityPort {
  constructor(private readonly options: {
    domain: InMemoryAcquisitionDomainRepository;
    doNotContact: InMemoryAcquisitionDouyinCrawlerIngestionRepository;
  }) {}

  hasDoNotContact(
    scope: OutreachDraftAuthorityScope,
    publicActorKey: string
  ) {
    return this.options.doNotContact.transaction({
      ...scope,
      actorId: "outreach-draft-final-authority"
    }, () => this.options.doNotContact.hasDoNotContact(
      scope.workspaceId,
      douyinDoNotContactIdentityHash(publicActorKey)
    ));
  }

  verify(input: OutreachDraftAuthorityRequest) {
    return this.options.doNotContact.transaction({
      ...input.scope,
      actorId: "outreach-draft-final-authority"
    }, async () => {
      const identityHash = douyinDoNotContactIdentityHash(input.publicActorKey);
      await this.options.doNotContact.lockOutreachDraftAuthority(
        input.scope,
        input.candidateId,
        input.evidenceIds,
        identityHash
      );
      return compareAuthority(input, {
        domain: this.options.domain,
        hasDoNotContact: (hash) =>
          this.options.doNotContact.hasDoNotContact(
            input.scope.workspaceId,
            hash
          )
      });
    }).then(freezeRecursively);
  }
}

export class MysqlAcquisitionOutreachDraftFinalAuthority
implements AcquisitionOutreachDraftFinalAuthorityPort {
  constructor(private readonly options: {
    domain: MysqlAcquisitionDomainRepository;
    doNotContact: MysqlAcquisitionDouyinCrawlerIngestionRepository;
  }) {}

  hasDoNotContact(
    scope: OutreachDraftAuthorityScope,
    publicActorKey: string
  ) {
    return this.options.doNotContact.transaction({
      ...scope,
      actorId: "outreach-draft-final-authority"
    }, () => this.options.doNotContact.hasDoNotContact(
      scope.workspaceId,
      douyinDoNotContactIdentityHash(publicActorKey)
    ));
  }

  verify(input: OutreachDraftAuthorityRequest) {
    return this.options.doNotContact.transaction({
      ...input.scope,
      actorId: "outreach-draft-final-authority"
    }, async () => {
      const identityHash = douyinDoNotContactIdentityHash(input.publicActorKey);
      await this.options.doNotContact.lockOutreachDraftAuthority(
        input.scope,
        input.candidateId,
        input.evidenceIds,
        identityHash
      );
      return compareAuthority(input, {
        domain: this.options.domain,
        hasDoNotContact: (hash) =>
          this.options.doNotContact.hasDoNotContact(
            input.scope.workspaceId,
            hash
          )
      });
    }).then(freezeRecursively);
  }
}
