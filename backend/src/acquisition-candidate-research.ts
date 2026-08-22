import { createHash } from "node:crypto";
import type {
  AcquisitionCandidate,
  DiscoveryEvidenceInput
} from "./acquisition-domain.js";
import type {
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import type {
  AcquisitionOperationShard,
  AcquisitionProviderConnectionSnapshot,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionScope
} from "./acquisition-plan-run-service.js";
import {
  normalizeAcquisitionPublicCreditCode,
  normalizeAcquisitionPublicDomain,
  normalizeAcquisitionPublicUrl,
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";
import type {
  SearchPublicSourceResult,
  SearchPublicSourcesPort,
  SearchPublicSourcesResponse
} from "./acquisition-tool-executor.js";

const MAX_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 5;
const MAX_QUERY_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const ACCESS_RESTRICTED_CODES = new Set([
  "ACCESS_RESTRICTED",
  "AUTHENTICATION_REQUIRED",
  "CAPTCHA_REQUIRED",
  "LOGIN_REQUIRED",
  "HTTP_401",
  "HTTP_403"
]);

export interface AcquisitionCandidateResearchInput {
  scope: AcquisitionScope;
  run: AcquisitionRun;
  shard: AcquisitionOperationShard;
  candidateId: string;
  questions: string[];
  signal: AbortSignal;
}

export interface AcquisitionCandidateResearchResult {
  status:
    | "completed"
    | "no_new_evidence"
    | "access_restricted"
    | "failed";
  queries: Array<{
    query: string;
    providerConnectionId: string;
    resultCount: number;
  }>;
  addedEvidenceIds: string[];
}

export interface AcquisitionCandidateResearchConnectionValidationInput {
  scope: AcquisitionScope;
  run: AcquisitionRun;
  shard: AcquisitionOperationShard;
  connection: AcquisitionProviderConnectionSnapshot;
}

export type AcquisitionCandidateResearchConnectionValidator = (
  input: AcquisitionCandidateResearchConnectionValidationInput
) => Promise<void>;

export interface AcquisitionCandidateResearchPort {
  research(
    input: AcquisitionCandidateResearchInput
  ): Promise<AcquisitionCandidateResearchResult>;
}

export interface AcquisitionCandidateResearchServiceOptions {
  domain: Pick<
    AcquisitionDomainService,
    | "getCandidate"
    | "getEvidence"
    | "appendEvidence"
    | "attachEvidenceToCandidate"
  >;
  search: SearchPublicSourcesPort;
  validateConnection: AcquisitionCandidateResearchConnectionValidator;
  timeoutMs?: number;
}

function normalizedQueryPart(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/["\\]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function query(parts: Array<string | null | undefined>) {
  return parts
    .map((value) => String(value ?? "")
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

function quoted(value: string | null | undefined) {
  const normalized = normalizedQueryPart(value);
  return normalized ? `"${normalized}"` : "";
}

export function acquisitionCandidateResearchQueries(
  candidate: AcquisitionCandidate
) {
  const generated = candidate.profile.kind === "organization"
    ? [
        query([
          quoted(candidate.profile.name),
          quoted(candidate.profile.domain),
          "采购 招标 合作"
        ]),
        query([
          quoted(candidate.profile.name),
          "招聘 扩张 融资 新项目"
        ]),
        query([
          quoted(candidate.profile.name),
          "供应商 系统 服务商"
        ])
      ]
    : [
        query([
          quoted(candidate.profile.publicDisplayName),
          quoted(candidate.profile.publicProfileUrl),
          "求购 报价 合作"
        ]),
        query([
          quoted(candidate.profile.publicDisplayName),
          "采购 寻找供应商 解决方案"
        ]),
        query([
          quoted(candidate.profile.publicDisplayName),
          "比价 预算 上线"
        ])
      ];
  return [...new Set(generated.filter(Boolean))].slice(0, MAX_QUERIES);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function contentHash(result: SearchPublicSourceResult) {
  return `sha256:${sha256(JSON.stringify({
    sourceUrl: normalizeAcquisitionPublicUrl(result.sourceUrl),
    title: result.title,
    snippet: result.snippet
  }))}`;
}

function evidenceInput(
  response: SearchPublicSourcesResponse,
  result: SearchPublicSourceResult,
  queryText: string,
  resultRank: number
): DiscoveryEvidenceInput {
  return {
    targetType: result.subject.kind === "organization"
      ? "organization"
      : "individual_signal",
    sourcePlatform: result.sourcePlatform ?? response.provider,
    sourceTitle: result.title,
    sourceSnippet: result.snippet,
    publishedAt: result.publishedAt,
    locale: result.locale,
    rawArtifactHash: result.rawArtifactHash,
    contentHash: contentHash(result),
    provenance: {
      kind: "search_result",
      provider: response.provider,
      providerConnectionId: response.providerConnectionId,
      requestId: response.requestId,
      providerRecordId: result.providerRecordId,
      queryText,
      sourceUrl: result.sourceUrl,
      resultRank
    },
    accessStatus: result.accessStatus,
    supersedesEvidenceId: null
  };
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal);
}

function accessRestrictedError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string"
    && ACCESS_RESTRICTED_CODES.has(code.toLocaleUpperCase("en-US"));
}

function researchIdempotencyKey(input: {
  runId: string;
  candidateId: string;
  providerConnectionId: string;
  normalizedSourceUrl: string;
}) {
  return `acquisition-research:${sha256(JSON.stringify(input)).slice(0, 48)}`;
}

function matchingOrganization(
  candidate: AcquisitionCandidate,
  result: SearchPublicSourceResult,
  response: SearchPublicSourcesResponse,
  scope: AcquisitionScope
) {
  if (
    candidate.profile.kind !== "organization"
    || result.subject.kind !== "organization"
  ) {
    return false;
  }
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    provider: response.provider,
    sourceUrl: result.sourceUrl,
    sourceType: result.sourceType,
    subject: result.subject
  });
  if (resolution.status !== "resolved") return false;
  const targetDomain = normalizeAcquisitionPublicDomain(
    candidate.profile.domain
  );
  const resultDomain = normalizeAcquisitionPublicDomain(
    result.subject.domain
  );
  const targetCreditCode = normalizeAcquisitionPublicCreditCode(
    candidate.profile.creditCode
  );
  const resultCreditCode = normalizeAcquisitionPublicCreditCode(
    result.subject.creditCode
  );
  const domainConflict = Boolean(
    targetDomain && resultDomain && targetDomain !== resultDomain
  );
  const creditConflict = Boolean(
    targetCreditCode
    && resultCreditCode
    && targetCreditCode !== resultCreditCode
  );
  const sharesStrongIdentity = Boolean(
    (targetDomain && resultDomain === targetDomain)
    || (targetCreditCode && resultCreditCode === targetCreditCode)
  );
  return sharesStrongIdentity && !domainConflict && !creditConflict;
}

function matchingIndividual(
  candidate: AcquisitionCandidate,
  result: SearchPublicSourceResult,
  response: SearchPublicSourcesResponse,
  scope: AcquisitionScope
) {
  if (
    candidate.profile.kind !== "individual"
    || result.subject.kind !== "individual"
    || candidate.partyRef.partyType !== "individual"
  ) {
    return false;
  }
  const targetProfile = normalizeAcquisitionPublicUrl(
    candidate.profile.publicProfileUrl
  );
  const resultProfile = normalizeAcquisitionPublicUrl(
    result.subject.publicProfileUrl
  );
  if (!targetProfile || resultProfile !== targetProfile) return false;
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    provider: response.provider,
    sourceUrl: result.sourceUrl,
    sourceType: result.sourceType,
    subject: result.subject
  });
  return resolution.status === "resolved"
    && resolution.partyId === candidate.partyRef.individualPartyId;
}

function matchesCandidate(
  candidate: AcquisitionCandidate,
  result: SearchPublicSourceResult,
  response: SearchPublicSourcesResponse,
  scope: AcquisitionScope
) {
  return candidate.profile.kind === "organization"
    ? matchingOrganization(candidate, result, response, scope)
    : matchingIndividual(candidate, result, response, scope);
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function sourceUrlFromEvidence(
  provenance: DiscoveryEvidenceInput["provenance"]
) {
  if (provenance.kind === "import_artifact_row") return null;
  return normalizeAcquisitionPublicUrl(provenance.sourceUrl);
}

function assertTrustedInput(input: AcquisitionCandidateResearchInput) {
  if (
    input.run.id !== input.shard.runId
    || input.run.ownerId !== input.scope.ownerId
    || input.run.teamId !== input.scope.teamId
    || input.shard.ownerId !== input.scope.ownerId
    || input.shard.teamId !== input.scope.teamId
    || input.shard.kind !== "search"
    || input.shard.connection.kind !== "search"
    || input.shard.connection.status !== "active"
  ) {
    throw new Error("ACQUISITION_RESEARCH_INPUT_MISMATCH");
  }
}

export class AcquisitionCandidateResearchService
implements AcquisitionCandidateResearchPort {
  private readonly domain: AcquisitionCandidateResearchServiceOptions["domain"];
  private readonly search: SearchPublicSourcesPort;
  private readonly validateConnection:
    AcquisitionCandidateResearchConnectionValidator;
  private readonly timeoutMs: number;

  constructor(options: AcquisitionCandidateResearchServiceOptions) {
    this.domain = options.domain;
    this.search = options.search;
    this.validateConnection = options.validateConnection;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs < 1
      || this.timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new TypeError("timeoutMs must be an integer between 1 and 30000");
    }
  }

  async research(
    input: AcquisitionCandidateResearchInput
  ): Promise<AcquisitionCandidateResearchResult> {
    assertNotAborted(input.signal);
    const queries: AcquisitionCandidateResearchResult["queries"] = [];
    const addedEvidenceIds: string[] = [];
    let restricted = false;
    let failed = false;
    const deadline = new AbortController();
    const timeout = setTimeout(() => {
      deadline.abort(new DOMException("research timeout", "TimeoutError"));
    }, this.timeoutMs);
    const onExternalAbort = () => {
      deadline.abort(abortReason(input.signal));
    };
    input.signal.addEventListener("abort", onExternalAbort, { once: true });

    try {
      assertTrustedInput(input);
      const candidate = await raceWithAbort(
        this.domain.getCandidate(input.scope, input.candidateId),
        deadline.signal
      );
      const seenSourceUrls = new Set<string>();
      for (const evidenceId of candidate.evidenceIds) {
        const currentEvidence = await raceWithAbort(
          this.domain.getEvidence(input.scope, evidenceId),
          deadline.signal
        );
        const sourceUrl = sourceUrlFromEvidence(currentEvidence.provenance);
        if (sourceUrl) seenSourceUrls.add(sourceUrl);
      }

      for (const queryText of acquisitionCandidateResearchQueries(candidate)) {
        assertNotAborted(input.signal);
        if (deadline.signal.aborted) {
          failed = true;
          break;
        }
        try {
          await raceWithAbort(this.validateConnection({
            scope: input.scope,
            run: input.run,
            shard: input.shard,
            connection: input.shard.connection
          }), deadline.signal);
          assertNotAborted(input.signal);
          const response = await raceWithAbort(this.search.search({
            ...input.scope,
            sessionId: `acquisition-plan:${input.run.id}`,
            providerConnectionId: input.shard.connection.connectionId,
            query: queryText,
            subjectKinds: [candidate.partyType],
            maxResults: MAX_RESULTS_PER_QUERY,
            signal: deadline.signal
          }), deadline.signal);
          if (
            response.providerConnectionId
              !== input.shard.connection.connectionId
          ) {
            failed = true;
            break;
          }
          const boundedResults = response.results.slice(
            0,
            MAX_RESULTS_PER_QUERY
          );
          queries.push({
            query: queryText,
            providerConnectionId: response.providerConnectionId,
            resultCount: boundedResults.length
          });
          for (let index = 0; index < boundedResults.length; index += 1) {
            assertNotAborted(input.signal);
            if (deadline.signal.aborted) {
              failed = true;
              break;
            }
            const result = boundedResults[index]!;
            if (result.accessStatus === "access_restricted") {
              restricted = true;
              continue;
            }
            const normalizedSourceUrl = normalizeAcquisitionPublicUrl(
              result.sourceUrl
            );
            if (
              !normalizedSourceUrl
              || seenSourceUrls.has(normalizedSourceUrl)
              || !matchesCandidate(
                candidate,
                result,
                response,
                input.scope
              )
            ) {
              continue;
            }
            seenSourceUrls.add(normalizedSourceUrl);
            const idempotencyKey = researchIdempotencyKey({
              runId: input.run.id,
              candidateId: candidate.id,
              providerConnectionId: response.providerConnectionId,
              normalizedSourceUrl
            });
            const created = await this.domain.appendEvidence(
              input.scope,
              evidenceInput(response, result, queryText, index + 1),
              idempotencyKey
            );
            await this.domain.attachEvidenceToCandidate(
              input.scope,
              candidate.id,
              created.id,
              idempotencyKey
            );
            assertNotAborted(input.signal);
            addedEvidenceIds.push(created.id);
          }
          if (failed) break;
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          if (deadline.signal.aborted) {
            failed = true;
            break;
          }
          if (accessRestrictedError(error)) {
            restricted = true;
            queries.push({
              query: queryText,
              providerConnectionId:
                input.shard.connection.connectionId,
              resultCount: 0
            });
            continue;
          }
          failed = true;
          break;
        }
      }

      if (failed || deadline.signal.aborted) {
        return {
          status: "failed",
          queries,
          addedEvidenceIds
        };
      }
      if (addedEvidenceIds.length > 0) {
        await raceWithAbort(
          this.domain.getCandidate(input.scope, candidate.id),
          deadline.signal
        );
        return {
          status: "completed",
          queries,
          addedEvidenceIds
        };
      }
      return {
        status: restricted ? "access_restricted" : "no_new_evidence",
        queries,
        addedEvidenceIds
      };
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      return {
        status: "failed",
        queries,
        addedEvidenceIds
      };
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
