import { createHash } from "node:crypto";
import type {
  AcquisitionCandidate,
  BuyingStage,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import {
  type AcquisitionActorScope,
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import {
  classifyDouyinPublicSource,
  type DouyinPublicSourceType
} from "./acquisition-douyin-public-source.js";
import {
  resolveAcquisitionPublicIdentity,
  type AcquisitionPublicIdentityResolution
} from "./acquisition-public-identity-resolver.js";
import type {
  AcquisitionCandidateDirectoryPort
} from "./acquisition-tool-executor.js";

export interface AcquisitionIndividualSignalSubject {
  publicActorKey: string;
  publicDisplayName: string;
  publicProfileUrl: string;
  sourcePlatform: string;
  demandCategory: string;
  demandSummary: string;
  locationHint: string;
  buyingStage: BuyingStage;
  negativeSignals: string[];
}

export interface AcquisitionIndividualSignalIngestionInput {
  scope: AcquisitionActorScope;
  provider: string;
  sourceUrl: string;
  sourceType?: DouyinPublicSourceType;
  subject: AcquisitionIndividualSignalSubject;
  evidence: DiscoveryEvidence;
  idempotencyKey: string;
  initialCandidateStatus?: "needs_research" | "do_not_contact";
  /** Internal saga barrier. Throwing here rolls back the candidate transaction. */
  beforeCandidateCommit?: () => Promise<void>;
}

export interface AcquisitionIndividualSignalIngestionResult {
  candidate: AcquisitionCandidate;
  created: boolean;
  identityResolution: AcquisitionPublicIdentityResolution;
}

export interface AcquisitionIndividualSignalIngestionPort {
  ingest(
    input: AcquisitionIndividualSignalIngestionInput
  ): Promise<AcquisitionIndividualSignalIngestionResult>;
}

export interface AcquisitionIndividualSignalIngestionServiceOptions {
  domain: AcquisitionDomainService;
  candidateDirectory: AcquisitionCandidateDirectoryPort;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value: unknown) {
  return digest(JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(
        Object.entries(nested as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
      );
    }
    return nested;
  }));
}

function childIdempotencyKey(
  parent: string,
  operation: string,
  material: unknown
) {
  return `${parent}:${operation}:${stableHash(material).slice(0, 32)}`;
}

function inferredBuyingStage(text: string): BuyingStage {
  if (/(?:正在采购|采购需求|招标|求购|寻找供应商|马上购买|尽快上线|近期上线)/u.test(text)) {
    return "purchase_ready";
  }
  if (/(?:比价|对比|比较|询价|报价|方案选择)/u.test(text)) {
    return "comparison";
  }
  if (/(?:寻找方案|了解方案|调研|咨询|怎么做|解决方案)/u.test(text)) {
    return "solution_research";
  }
  if (/(?:获客难|成本高|需要|需求|痛点|缺少)/u.test(text)) {
    return "problem_defined";
  }
  return "awareness";
}

const NEGATIVE_SIGNALS = [
  "不需要",
  "请勿联系",
  "拒绝推销",
  "勿扰",
  "不接受营销",
  "请勿电话推销"
] as const;

/**
 * Turns a public Douyin URL plus bounded public/user-supplied text into the
 * same individual subject shape consumed by the search ingestion path.
 * Non-Douyin and unsupported Douyin pages deliberately return null.
 */
export function individualSignalSubjectFromDouyinSource(input: {
  sourceUrl: string;
  title: string;
  snippet: string;
  demandCategory: string;
  locationHint?: string;
}) {
  const classification = classifyDouyinPublicSource(
    input.sourceUrl,
    input.title,
    input.snippet
  );
  if (!classification || classification.sourceType === "other") return null;
  const sourceUrl = new URL(input.sourceUrl).toString();
  const signalText = `${input.title}\n${input.snippet}`;
  const subject: AcquisitionIndividualSignalSubject = {
    publicActorKey: `unresolved-public-signal:douyin:sha256:${digest(sourceUrl)}`,
    publicDisplayName: classification.sourceType === "comment_signal"
      ? "抖音公开评论式信号（身份待核实）"
      : input.title.trim() || "抖音公开需求信号（身份待核实）",
    publicProfileUrl: sourceUrl,
    sourcePlatform: "douyin",
    demandCategory: input.demandCategory.trim().slice(0, 100)
      || "抖音公开需求信号",
    demandSummary: input.snippet.trim().slice(0, 2_000)
      || "只发现公开抖音链接，具体需求需人工核实。",
    locationHint: (input.locationHint ?? "").trim().slice(0, 200),
    buyingStage: inferredBuyingStage(signalText),
    negativeSignals: NEGATIVE_SIGNALS.filter((signal) =>
      signalText.includes(signal)
    )
  };
  return {
    sourcePlatform: classification.sourcePlatform,
    sourceType: classification.sourceType,
    subject
  };
}

/** Shared candidate upsert used by provider search and customer submissions. */
export class AcquisitionIndividualSignalIngestionService
implements AcquisitionIndividualSignalIngestionPort {
  private readonly domain: AcquisitionDomainService;
  private readonly candidateDirectory: AcquisitionCandidateDirectoryPort;

  constructor(options: AcquisitionIndividualSignalIngestionServiceOptions) {
    this.domain = options.domain;
    this.candidateDirectory = options.candidateDirectory;
  }

  async ingest(input: AcquisitionIndividualSignalIngestionInput) {
    if (input.evidence.targetType !== "individual_signal") {
      throw new TypeError("Individual signal evidence is required");
    }
    const identityResolution = resolveAcquisitionPublicIdentity({
      ownerId: input.scope.ownerId,
      teamId: input.scope.teamId,
      provider: input.provider,
      sourceUrl: input.sourceUrl,
      sourceType: input.sourceType,
      subject: {
        kind: "individual",
        publicActorKey: input.subject.publicActorKey,
        publicProfileUrl: input.subject.publicProfileUrl,
        sourcePlatform: input.subject.sourcePlatform
      }
    });
    const dedupeKey = identityResolution.dedupeKey;
    const upsert = await this.candidateDirectory.upsertCandidate({
      ownerId: input.scope.ownerId,
      teamId: input.scope.teamId,
      dedupeKey,
      partyType: "individual",
      idempotencyKey: childIdempotencyKey(
        input.idempotencyKey,
        "candidate-upsert",
        { dedupeKey }
      ),
      createCandidate: async () => this.domain.createIndividualCandidate(
        input.scope,
        {
          ...input.subject,
          demandSignalId: `signal-${digest(
            `${dedupeKey}\u0000${input.sourceUrl}`
          ).slice(0, 24)}`,
          individualPartyId: identityResolution.partyId,
          evidenceIds: [input.evidence.id],
          ...(["needs_research", "do_not_contact"].includes(
            String(input.initialCandidateStatus)
          )
            ? { initialStatus: input.initialCandidateStatus }
            : {})
        },
        childIdempotencyKey(input.idempotencyKey, "candidate", {
          dedupeKey,
          partyType: "individual"
        }),
        input.beforeCandidateCommit
      )
    });
    let candidate = await this.domain.getCandidate(
      input.scope,
      upsert.entry.candidateId
    );
    if (!upsert.created) {
      candidate = await this.domain.mergeIndividualDemandSignal(
        input.scope,
        candidate.id,
        {
          evidenceId: input.evidence.id,
          demandSummary: input.subject.demandSummary,
          buyingStage: input.subject.buyingStage,
          negativeSignals: input.subject.negativeSignals
        },
        childIdempotencyKey(input.idempotencyKey, "merge-signal", {
          candidateId: candidate.id,
          evidenceId: input.evidence.id
        }),
        input.beforeCandidateCommit
      );
    }
    return {
      candidate,
      created: upsert.created,
      identityResolution
    };
  }
}
