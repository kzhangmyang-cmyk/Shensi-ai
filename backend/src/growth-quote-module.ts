import type express from "express";
import type mysql from "mysql2/promise";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";
import type { GrowthCommercialModule } from "./growth-commercial-composition.js";
import {
  defineGrowthPrivateServiceKey,
  type GrowthPrivateServiceKey,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import { GROWTH_CATALOG_SERVICES } from "./growth-catalog-module.js";
import {
  createProbabilityAssessmentRepository,
  type ProbabilityAssessmentPersistence
} from "./probability-assessment.js";
import { ensureProbabilityAssessmentMysqlSchema } from "./probability-assessment-mysql-repository.js";
import {
  InMemoryQuoteRepository,
  type QuoteRepository
} from "./quote-repository.js";
import {
  MysqlQuoteRepository,
  ensureQuoteMysqlSchema
} from "./quote-mysql-repository.js";
import {
  QuoteCaseService,
  type QuoteSubjectReader
} from "./quote-case-service.js";
import {
  QuoteVersionService,
  type CreateQuoteVersionInput,
  type QuotePreviewInput,
  type QuoteQualificationAuthority
} from "./quote-version-service.js";
import type { CommercialBindingAuthoritySource } from "./commercial-binding-snapshot.js";
import { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type { GrowthWorkspaceMemberAssignabilityReader } from "./growth-workspace-member-assignability.js";
import type { GrowthHttpIdempotencyRepository } from "./growth-http-idempotency-repository.js";
import type {
  GrowthTemporalBarrier,
  GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { GrowthCatalogServices } from "./growth-catalog-module.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { parseIfMatchRevision, setRevisionEtag } from "./growth-http-preconditions.js";
import { GrowthHttpError } from "./growth-command-context.js";
import { QuoteApprovalService } from "./quote-approval-service.js";
import {
  AuthoritativeQuoteAsOfReader,
  DealAuthoritativeQuoteReader,
  QuoteApprovalAsOfReader,
  QuoteVersionEvidenceReader
} from "./authoritative-quote-reader.js";
import { QuotePreviewEvidenceReader } from "./quote-preview-evidence-reader.js";
import type { ProbabilityAssessmentWriter } from "./probability-assessment.js";
import type { QuoteProjectedDocumentAuthorityValidator } from "./commercial-authority-guard.js";
import { createQuoteProjectedDocumentAuthorityValidator } from "./quote-projected-document-authority.js";
import { createQuoteCrmCommand } from "./quote-crm-command.js";
import { createMysqlQuoteCrmCommand } from "./quote-crm-command-mysql.js";
import { QuotePublicationWorker } from "./quote-publication-worker.js";
import { QuotePublicationRecoverySweeper } from "./quote-publication-recovery-sweeper.js";
import type { CrmStore } from "./store.js";
import {
  DealCommercialDecisionService,
  type DealCommercialDecisionInput
} from "./deal-commercial-decision-service.js";
import {
  createQuoteRouter,
  QuotePublicationService
} from "./quote-router.js";
import { registerGrowthAdvisorQuoteTools } from "./growth-advisor-quote-tools.js";

export const GROWTH_PROBABILITY_ASSESSMENTS =
  defineGrowthPrivateServiceKey<ProbabilityAssessmentPersistence>(
    "growth-probability-assessments"
  );

export interface GrowthQuoteServices {
  readonly repository: QuoteRepository;
  readonly quoteCases: QuoteCaseService;
  readonly quoteVersions: QuoteVersionService;
  readonly quoteApprovals: QuoteApprovalService;
  /** Application-owned publication executor used by recovery and release gates. */
  readonly publicationWorker?: Pick<QuotePublicationWorker, "runOne">;
  readonly dealDecisions?: DealCommercialDecisionService;
  readonly authorityReaders: GrowthQuoteAuthorityReaders;
}

export const GROWTH_QUOTE_SERVICES =
  defineGrowthPrivateServiceKey<GrowthQuoteServices>("growth-quote-services");

export interface GrowthQuoteAuthorityReaders {
  readonly commercialBindingVerifier: CommercialBindingVerifier;
  readonly dealAuthoritativeQuotes: DealAuthoritativeQuoteReader;
  readonly authoritativeContributions: AuthoritativeQuoteAsOfReader;
  readonly quoteApprovals: QuoteApprovalAsOfReader;
  readonly quoteVersions: QuoteVersionEvidenceReader;
  readonly quotePreviews: QuotePreviewEvidenceReader;
}

export const GROWTH_QUOTE_AUTHORITY_READERS =
  defineGrowthPrivateServiceKey<GrowthQuoteAuthorityReaders>(
    "growth-quote-authority-readers"
  );

export interface GrowthQuoteAcquisitionIntegrations {
  readonly probabilityAssessments: ProbabilityAssessmentWriter;
  readonly quoteProjectedDocumentAuthority:
    QuoteProjectedDocumentAuthorityValidator;
}

export const GROWTH_QUOTE_ACQUISITION_INTEGRATIONS:
GrowthPrivateServiceKey<GrowthQuoteAcquisitionIntegrations> =
  defineGrowthPrivateServiceKey<GrowthQuoteAcquisitionIntegrations>(
    "growth-quote-acquisition-integrations"
  );

export interface GrowthQuoteTrustedAuthority {
  readonly assignments: GrowthWorkspaceMemberAssignabilityReader;
  readonly subjects: QuoteSubjectReader;
  readonly commercialBindings: CommercialBindingAuthoritySource;
  readonly qualificationAuthority?: QuoteQualificationAuthority;
}

export interface GrowthQuoteResourceFactoryInput {
  mode: "memory" | "mysql";
  pool?: mysql.Pool;
  temporalTransactions: GrowthTemporalTransactionRunner;
  temporalBarrier: GrowthTemporalBarrier;
  httpIdempotency: GrowthHttpIdempotencyRepository;
  foundation: GrowthFoundationServices;
  catalog: GrowthCatalogServices;
  trustedAuthority?: GrowthQuoteTrustedAuthority;
}

export interface GrowthQuoteResourceHandle {
  probabilityAssessments: ProbabilityAssessmentPersistence;
  quote?: GrowthQuoteServices;
  quoteProjectedDocumentAuthority?: QuoteProjectedDocumentAuthorityValidator;
  start?(): void;
  close(): Promise<void>;
}

interface GrowthQuoteModuleHooks {
  resourceFactory?: (
    input: GrowthQuoteResourceFactoryInput
  ) => GrowthQuoteResourceHandle | Promise<GrowthQuoteResourceHandle>;
}

function routeId(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value
    || value === "" || value.length > 191) {
    throw new GrowthHttpError(400, "invalid_quote_resource_id");
  }
  return value;
}

function route(
  action: (
    req: express.Request,
    res: express.Response
  ) => Promise<void>
) {
  return (req: express.Request, res: express.Response,
    next: express.NextFunction) => {
    action(req, res).catch(next);
  };
}

function replayHeader(res: express.Response, replayed: boolean) {
  if (replayed) res.setHeader("Idempotency-Replayed", "true");
}

function mountQuoteVersionRoutes(
  router: express.Router,
  service: QuoteVersionService,
  foundation: GrowthFoundationServices
) {
  router.post("/api/v1/quotes/cases/:id/preview", route(async (req, res) => {
    const id = routeId(req.params.id);
    const expectedRevision = parseIfMatchRevision(req, `quote-case:${id}`);
    const payload = req.body as QuotePreviewInput;
    const command = foundation.commandContextFactory(req, {
      canonicalPath: "/api/v1/quotes/cases/:id/preview",
      pathParams: Object.freeze({ id }), payload, expectedRevision
    });
    const result = await service.preview(command, id, payload);
    replayHeader(res, result.replayed);
    res.status(200).json(result.value);
  }));
  router.get("/api/v1/quotes/cases/:id/versions", route(async (req, res) => {
    const id = routeId(req.params.id);
    const context = foundation.workspaceContext(req);
    const items = await service.listVersions(context, id);
    res.status(200).json({ items, nextCursor: null });
  }));
  router.post("/api/v1/quotes/cases/:id/versions", route(async (req, res) => {
    const id = routeId(req.params.id);
    const expectedRevision = parseIfMatchRevision(req, `quote-case:${id}`);
    const payload = req.body as CreateQuoteVersionInput;
    const command = foundation.commandContextFactory(req, {
      canonicalPath: "/api/v1/quotes/cases/:id/versions",
      pathParams: Object.freeze({ id }), payload, expectedRevision
    });
    const result = await service.createVersion(command, id, payload);
    replayHeader(res, result.replayed);
    setRevisionEtag(res, "quote-version", result.value.id,
      result.value.lifecycleRevision);
    res.status(201).json(result.value);
  }));
  router.get("/api/v1/quotes/versions/:id", route(async (req, res) => {
    const id = routeId(req.params.id);
    const version = await service.getVersion(foundation.workspaceContext(req), id);
    setRevisionEtag(res, "quote-version", version.id,
      version.lifecycleRevision);
    res.status(200).json(version);
  }));
  router.post("/api/v1/quotes/versions/:id/submit", route(async (req, res) => {
    const id = routeId(req.params.id);
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)
      || Object.keys(req.body as object).length !== 0) {
      throw new GrowthHttpError(400, "invalid_quote_submit_input");
    }
    const expectedRevision = parseIfMatchRevision(req, `quote-version:${id}`);
    const payload = Object.freeze({});
    const command = foundation.commandContextFactory(req, {
      canonicalPath: "/api/v1/quotes/versions/:id/submit",
      pathParams: Object.freeze({ id }), payload, expectedRevision
    });
    const result = await service.submit(command, id);
    replayHeader(res, result.replayed);
    setRevisionEtag(res, "quote-version", result.value.submittedVersion.id,
      result.value.submittedVersion.lifecycleRevision);
    res.status(200).json(result.value);
  }));
}

function decisionInput(value: unknown): { reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1
    || typeof Reflect.get(value, "reason") !== "string"
    || !String(Reflect.get(value, "reason")).trim()) {
    throw new GrowthHttpError(400, "invalid_quote_decision_input");
  }
  return { reason: String(Reflect.get(value, "reason")).trim() };
}

function mountQuoteApprovalRoutes(
  router: express.Router,
  service: QuoteApprovalService,
  foundation: GrowthFoundationServices
) {
  router.get("/api/v1/quotes/versions/:id/approvals", route(async (req, res) => {
    const id = routeId(req.params.id);
    const items = await service.listForVersion(
      foundation.workspaceContext(req), id
    );
    res.status(200).json({ items, nextCursor: null });
  }));
  const decisionRoute = (kind: "approve" | "reject" | "expire") =>
    route(async (req, res) => {
      const id = routeId(req.params.id);
      const payload = decisionInput(req.body);
      const expectedRevision = parseIfMatchRevision(req, `quote-version:${id}`);
      const command = foundation.commandContextFactory(req, {
        canonicalPath: `/api/v1/quotes/versions/:id/${kind}`,
        pathParams: Object.freeze({ id }), payload, expectedRevision
      });
      const result = await service[kind](command, id, payload);
      replayHeader(res, result.replayed);
      if (kind === "reject") {
        res.status(200).json(result.value.approval);
        return;
      }
      setRevisionEtag(res, "quote-version", result.value.quoteVersion.id,
        result.value.quoteVersion.lifecycleRevision);
      res.status(200).json(result.value.quoteVersion);
    });
  router.post("/api/v1/quotes/versions/:id/approve",
    decisionRoute("approve"));
  router.post("/api/v1/quotes/versions/:id/reject",
    decisionRoute("reject"));
  router.post("/api/v1/quotes/versions/:id/expire",
    decisionRoute("expire"));
}

function dealDecisionInput(value: unknown): DealCommercialDecisionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GrowthHttpError(400, "invalid_deal_decision_input");
  }
  const input = value as Record<string, unknown>;
  const type = input.type;
  const common = typeof input.occurredAt === "string"
    && (typeof input.reasonText === "string" || input.reasonText === null)
    && (typeof input.reasonCode === "string" || input.reasonCode === null);
  if (!common) throw new GrowthHttpError(400, "invalid_deal_decision_input");
  if (type === "pre_quote_disqualified") {
    if (Object.keys(input).length !== 4
      || typeof input.reasonCode !== "string" || !input.reasonCode.trim()) {
      throw new GrowthHttpError(400, "invalid_deal_decision_input");
    }
    return input as unknown as DealCommercialDecisionInput;
  }
  if ((type !== "won" && type !== "lost")
    || Object.keys(input).length !== 6
    || typeof input.quoteVersionId !== "string"
    || typeof input.commercialAmountHash !== "string") {
    throw new GrowthHttpError(400, "invalid_deal_decision_input");
  }
  return input as unknown as DealCommercialDecisionInput;
}

function mountDealDecisionRoutes(
  router: express.Router,
  service: DealCommercialDecisionService,
  foundation: GrowthFoundationServices
) {
  router.post("/api/v1/quotes/deals/:dealId/decision", route(async (req, res) => {
    const dealId = routeId(req.params.dealId);
    const payload = dealDecisionInput(req.body);
    const expectedRevision = parseIfMatchRevision(req,
      `deal-authority:${dealId}`);
    const command = foundation.commandContextFactory(req, {
      canonicalPath: "/api/v1/quotes/deals/:dealId/decision",
      pathParams: Object.freeze({ dealId }), payload, expectedRevision
    });
    const result = await service.decide(command, dealId, payload);
    replayHeader(res, result.replayed);
    setRevisionEtag(res, "deal-authority", dealId,
      result.value.authorityRevision);
    res.status(200).json(result.value);
  }));
}

export type GrowthQuoteModuleOptions = GrowthQuoteModuleHooks & {
  trustedAuthority?: GrowthQuoteTrustedAuthority;
  store?: CrmStore;
} & (
  | { mode: "memory" }
  | { mode: "mysql"; pool: mysql.Pool }
);

async function defaultResources(
  options: GrowthQuoteModuleOptions,
  input: GrowthQuoteResourceFactoryInput
): Promise<GrowthQuoteResourceHandle> {
  if (options.mode === "mysql") {
    await ensureProbabilityAssessmentMysqlSchema(options.pool);
    await ensureQuoteMysqlSchema(options.pool);
  }
  const probabilityAssessments = createProbabilityAssessmentRepository(
    options.mode === "mysql"
      ? { mode: "mysql", pool: options.pool,
          temporalBarrier: input.temporalBarrier }
      : { mode: "memory", transactions: input.temporalTransactions,
          temporalBarrier: input.temporalBarrier }
  );
  const repository: QuoteRepository = options.mode === "mysql"
    ? new MysqlQuoteRepository(options.pool, input.temporalBarrier)
    : new InMemoryQuoteRepository(input.temporalTransactions,
        input.temporalBarrier);
  const trusted = input.trustedAuthority;
  const bindingVerifier = trusted
    ? new CommercialBindingVerifier(trusted.commercialBindings)
    : null;
  const crm = options.store ? (options.mode === "mysql"
    ? createMysqlQuoteCrmCommand({ pool: options.pool,
        temporalBarrier: input.temporalBarrier, repository })
    : createQuoteCrmCommand({ store: options.store,
        temporalTransactions: input.temporalTransactions,
        temporalBarrier: input.temporalBarrier, repository })) : null;
  const publicationWorker = crm
    ? new QuotePublicationWorker({ repository, crm,
        workerId: `quote-publication-${process.pid}` })
    : null;
  const quote = trusted ? (() => {
    const dealAuthoritativeQuotes = new DealAuthoritativeQuoteReader(repository);
    const authoritativeContributions = new AuthoritativeQuoteAsOfReader(
      repository
    );
    const quoteApprovals = new QuoteApprovalAsOfReader(repository);
    const quoteVersions = new QuoteVersionEvidenceReader(repository);
    const quotePreviews = new QuotePreviewEvidenceReader(repository);
    const authorityReaders: GrowthQuoteAuthorityReaders = Object.freeze({
      commercialBindingVerifier: bindingVerifier!, dealAuthoritativeQuotes,
      authoritativeContributions, quoteApprovals, quoteVersions, quotePreviews
    });
    return Object.freeze({
      repository,
      quoteCases: new QuoteCaseService({
        repository,
        httpIdempotency: input.httpIdempotency,
        assignments: trusted.assignments,
        subjects: trusted.subjects,
        bindingVerifier: bindingVerifier!,
        probabilityAssessments
      }),
      quoteVersions: new QuoteVersionService({
        repository,
        probabilityAssessments,
        bindingVerifier: bindingVerifier!,
        catalog: input.catalog,
        foundation: input.foundation,
        qualificationAuthority: trusted.qualificationAuthority
      }),
      quoteApprovals: new QuoteApprovalService({
        repository, bindingVerifier: bindingVerifier!,
        foundation: input.foundation, catalog: input.catalog
      }),
      ...(publicationWorker ? { publicationWorker } : {}),
      ...(crm ? { dealDecisions: new DealCommercialDecisionService({
        repository, crm, foundation: input.foundation
      }) } : {}),
      authorityReaders
    });
  })() : undefined;
  const quoteProjectedDocumentAuthority = options.store && quote
    ? (() => {
        const validator = createQuoteProjectedDocumentAuthorityValidator({
          store: options.store!, repository
        });
        return Object.freeze({
          assertAuthorized: validator.assertAuthorized.bind(validator),
          commercialOutcomeAuthority: repository
        });
      })()
    : Object.freeze({
        async assertAuthorized(): Promise<never> {
          throw Object.assign(new Error("authoritative_quote_required"), {
            code: "authoritative_quote_required"
          });
        }
      }) as QuoteProjectedDocumentAuthorityValidator;
  const publication = quote && publicationWorker
    ? new QuotePublicationRecoverySweeper({
        repository, worker: publicationWorker
      })
    : null;
  return {
    probabilityAssessments,
    ...(quote ? { quote } : {}),
    quoteProjectedDocumentAuthority,
    start() { publication?.start(); },
    async close() { await publication?.close(); }
  };
}

export function createGrowthQuoteModule(
  options: GrowthQuoteModuleOptions
): GrowthCommercialModule {
  let installed = false;
  return Object.freeze({
    name: "growth-quote",
    async install(input: {
      router: express.Router;
      toolPorts: GrowthCommercialToolPorts;
      privateServices: GrowthPrivateServiceRegistry;
    }) {
      if (installed) throw new Error("DUPLICATE_GROWTH_QUOTE_INSTALL");
      installed = true;
      const foundation = input.privateServices.require(
        GROWTH_FOUNDATION_SERVICES
      );
      const catalog = input.privateServices.require(GROWTH_CATALOG_SERVICES);
      const factoryInput: GrowthQuoteResourceFactoryInput = {
        mode: options.mode,
        ...(options.mode === "mysql" ? { pool: options.pool } : {}),
        temporalTransactions: foundation.temporalTransactions,
        temporalBarrier: foundation.temporalBarrier,
        httpIdempotency: foundation.httpIdempotency,
        foundation,
        catalog,
        trustedAuthority: options.trustedAuthority
      };
      let resources: GrowthQuoteResourceHandle | null = null;
      let closePromise: Promise<void> | null = null;
      const close = () => {
        closePromise ??= resources?.close() ?? Promise.resolve();
        return closePromise;
      };
      try {
        resources = options.resourceFactory
          ? await options.resourceFactory(factoryInput)
          : await defaultResources(options, factoryInput);
        Object.freeze(resources.probabilityAssessments);
        input.privateServices.provide(
          GROWTH_PROBABILITY_ASSESSMENTS,
          resources.probabilityAssessments
        );
        if (resources.quote) {
          registerGrowthAdvisorQuoteTools(input.toolPorts, {
            catalog,
            temporalBarrier: foundation.temporalBarrier,
            quotes: {
              preview: (context, caseId, quoteInput) =>
                resources!.quote!.quoteVersions.preview(
                  context, caseId, quoteInput
                ),
              createDraft: (context, caseId, quoteInput) =>
                resources!.quote!.quoteVersions.createVersion(
                  context, caseId, quoteInput
                ),
              submitDraft: (context, draftVersionId) =>
                resources!.quote!.quoteVersions.submit(
                  context, draftVersionId
                ),
              quoteApprovals: resources.quote.authorityReaders.quoteApprovals,
              quoteVersions: resources.quote.authorityReaders.quoteVersions
            }
          });
          input.privateServices.provide(GROWTH_QUOTE_SERVICES, resources.quote);
          input.privateServices.provide(
            GROWTH_QUOTE_AUTHORITY_READERS,
            resources.quote.authorityReaders
          );
          input.router.use(createQuoteRouter({
            cases: resources.quote.quoteCases,
            versions: resources.quote.quoteVersions,
            approvals: resources.quote.quoteApprovals,
            publications: new QuotePublicationService({
              repository: resources.quote.repository,
              httpIdempotency: foundation.httpIdempotency
            }),
            decisions: resources.quote.dealDecisions ?? {
              async decide(): Promise<never> {
                throw new GrowthHttpError(409,
                  "quote_deal_decision_unavailable");
              }
            } as never,
            workspaceContext: foundation.workspaceContext,
            commandContextFactory: foundation.commandContextFactory,
            temporalBarrier: foundation.temporalBarrier
          }));
        }
        const validator = resources.quoteProjectedDocumentAuthority
          ?? Object.freeze({
            async assertAuthorized(): Promise<never> {
              throw Object.assign(new Error("authoritative_quote_required"), {
                code: "authoritative_quote_required"
              });
            }
          }) as QuoteProjectedDocumentAuthorityValidator;
        Object.freeze(validator);
        input.privateServices.provide(
          GROWTH_QUOTE_ACQUISITION_INTEGRATIONS,
          Object.freeze({
            probabilityAssessments: resources.probabilityAssessments,
            quoteProjectedDocumentAuthority: validator
          })
        );
        resources.start?.();
        return Object.freeze({ close });
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    }
  });
}
