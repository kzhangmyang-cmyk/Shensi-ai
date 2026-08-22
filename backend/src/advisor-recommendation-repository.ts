import { createHash } from "node:crypto";
import {
  applyAdvisorTransition,
  recommendationError,
  type AdvisorRecommendation,
  type AdvisorRecommendationEvent,
  type AdvisorTransitionInput,
  type AdvisorTransitionMetadata
} from "./advisor-recommendation-domain.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { canonicalJsonStringify } from "./canonical-json.js";

export interface CommandResult<T> {
  value: T;
  replayed: boolean;
}

export interface CursorPage<T> {
  items: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface AdvisorRecommendationListAtQuery {
  status: readonly AdvisorRecommendation["status"][];
  cutoff: GrowthSealedReadCutoff;
  limit: number;
  cursor: string | null;
}

export interface AdvisorRecommendationRepository {
  create(
    command: CommandContext,
    aggregate: AdvisorRecommendation
  ): Promise<CommandResult<AdvisorRecommendation>>;
  findById(
    context: ActiveWorkspaceContext,
    id: string
  ): Promise<AdvisorRecommendation | null>;
  listAt(
    context: ActiveWorkspaceContext,
    query: AdvisorRecommendationListAtQuery
  ): Promise<CursorPage<AdvisorRecommendation>>;
  listExpirable(
    asOf: string,
    limit: number
  ): Promise<readonly AdvisorRecommendation[]>;
  transition(
    command: CommandContext,
    input: AdvisorTransitionInput
  ): Promise<CommandResult<AdvisorRecommendation>>;
}

export interface AdvisorRecommendationTransitionTransaction {
  lockRecommendationForUpdate(
    workspaceId: string,
    recommendationId: string
  ): Promise<AdvisorRecommendation | null>;
}

export interface AdvisorExpiryBlocker {
  hasBlockingOperation(
    tx: AdvisorRecommendationTransitionTransaction,
    workspaceId: string,
    recommendationId: string
  ): Promise<boolean>;
}

export function advisorSnapshotHash(
  aggregate: AdvisorRecommendation
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(aggregate) ?? "").digest("hex")}`;
}

export class InMemoryAdvisorRecommendationRepository
implements AdvisorRecommendationRepository {
  private readonly transactions: GrowthTemporalTransactionRunner;
  private readonly barrier: GrowthTemporalBarrier;
  private readonly recommendations = new Map<string, AdvisorRecommendation>();
  private readonly events = new Map<string, AdvisorRecommendationEvent[]>();
  private readonly generationKeys = new Map<string, string>();
  private readonly blocking: AdvisorExpiryBlocker | null;
  private now: () => string;

  constructor(
    initial: readonly AdvisorRecommendation[] = [],
    options: {
      now?: string | (() => string);
      blocking?: AdvisorExpiryBlocker;
      temporalTransactions?: GrowthTemporalTransactionRunner;
      temporalBarrier?: GrowthTemporalBarrier;
    } = {}
  ) {
    this.transactions = options.temporalTransactions
      ?? new InMemoryGrowthTemporalTransactionRunner(
        typeof options.now === "string" ? options.now : "2026-08-09T00:00:00.000Z"
      );
    this.barrier = options.temporalBarrier
      ?? new DefaultGrowthTemporalBarrier(this.transactions);
    this.now = typeof options.now === "function"
      ? options.now : () => "2026-08-09T00:00:00.000Z";
    this.blocking = options.blocking ?? null;
    for (const aggregate of initial) {
      this.recommendations.set(
        `${aggregate.workspaceId}\u0000${aggregate.id}`,
        Object.freeze({ ...aggregate })
      );
    }
  }

  setNow(value: string): void {
    if (this.transactions instanceof InMemoryGrowthTemporalTransactionRunner) {
      this.transactions.setDatabaseNow(value);
    }
    this.now = () => value;
  }

  /** Test/support seam: seeds an aggregate without appending a created event
   *  or allocating a temporal stamp. Runtime creation goes through `create`. */
  seed(aggregate: AdvisorRecommendation): void {
    this.recommendations.set(
      this.key(aggregate.workspaceId, aggregate.id),
      Object.freeze({ ...aggregate })
    );
  }

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }

  async create(
    command: CommandContext,
    aggregate: AdvisorRecommendation
  ): Promise<CommandResult<AdvisorRecommendation>> {
    const generationKey =
      `${aggregate.workspaceId}\u0000${aggregate.generationIdempotencyKey}`;
    const existingId = this.generationKeys.get(generationKey);
    if (existingId !== undefined) {
      const existing = this.recommendations.get(
        this.key(aggregate.workspaceId, existingId)
      );
      if (!existing) throw recommendationError("advisor_generation_conflict");
      if (existing.inputSnapshotHash !== aggregate.inputSnapshotHash) {
        throw recommendationError("advisor_generation_conflict");
      }
      return { value: existing, replayed: true };
    }
    const stamp = await this.transactions.run(async (tx) =>
      this.barrier.allocateAppend(tx, aggregate.workspaceId));
    const stored = Object.freeze({
      ...aggregate,
      createdAt: stamp.recordedAt,
      updatedAt: stamp.recordedAt
    }) as AdvisorRecommendation;
    this.recommendations.set(this.key(stored.workspaceId, stored.id), stored);
    this.generationKeys.set(generationKey, stored.id);
    this.appendEvent(stored, "created", command.actorId, stamp);
    void command;
    return { value: stored, replayed: false };
  }

  async findById(
    context: ActiveWorkspaceContext,
    id: string
  ): Promise<AdvisorRecommendation | null> {
    return this.recommendations.get(this.key(context.workspaceId, id)) ?? null;
  }

  async listAt(
    context: ActiveWorkspaceContext,
    query: AdvisorRecommendationListAtQuery
  ): Promise<CursorPage<AdvisorRecommendation>> {
    if (query.cutoff.workspaceId !== context.workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const statuses = new Set(query.status);
    const rows: AdvisorRecommendation[] = [];
    for (const aggregate of this.recommendations.values()) {
      if (aggregate.workspaceId !== context.workspaceId) continue;
      const historical = this.reduceAt(
        context.workspaceId, aggregate.id, query.cutoff
      );
      if (historical && statuses.has(historical.status)) {
        rows.push(historical);
      }
    }
    rows.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
    const start = query.cursor
      ? rows.findIndex((row) => row.id === query.cursor) + 1
      : 0;
    const page = rows.slice(start, start + query.limit);
    return {
      items: page,
      nextCursor: start + query.limit < rows.length
        ? page.at(-1)?.id ?? null : null,
      hasMore: start + query.limit < rows.length
    };
  }

  async listExpirable(
    asOf: string,
    limit: number
  ): Promise<readonly AdvisorRecommendation[]> {
    return [...this.recommendations.values()]
      .filter((aggregate) =>
        (aggregate.status === "proposed" || aggregate.status === "accepted")
        && aggregate.expiresAt <= asOf)
      .sort((left, right) =>
        left.expiresAt.localeCompare(right.expiresAt)
        || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async transition(
    command: CommandContext,
    input: AdvisorTransitionInput
  ): Promise<CommandResult<AdvisorRecommendation>> {
    const repo = this;
    const stamp = await this.transactions.run(async (tx) => {
      const allocated = await this.barrier.allocateAppend(
        tx, command.workspace.workspaceId
      );
      if (this.blocking) {
        const blocked = await this.blocking.hasBlockingOperation(
          {
            async lockRecommendationForUpdate(workspaceId, recommendationId) {
              return repo.recommendations.get(
                `${workspaceId}\u0000${recommendationId}`
              ) ?? null;
            }
          },
          command.workspace.workspaceId,
          input.recommendationId
        );
        if (blocked) {
          throw recommendationError("advisor_expiry_blocked");
        }
      }
      const current = this.recommendations.get(
        this.key(command.workspace.workspaceId, input.recommendationId)
      );
      if (!current) throw recommendationError("advisor_recommendation_not_found");
      const metadata: AdvisorTransitionMetadata = {
        actorId: command.actorId,
        occurredAt: allocated.recordedAt
      };
      const next = applyAdvisorTransition(current, input, metadata);
      this.recommendations.set(this.key(next.workspaceId, next.id), next);
      this.appendEvent(next, input.kind, command.actorId, allocated);
      return next;
    });
    return { value: stamp, replayed: false };
  }


  private reduceAt(
    workspaceId: string,
    recommendationId: string,
    cutoff: GrowthSealedReadCutoff
  ): AdvisorRecommendation | null {
    const events = (this.events.get(this.key(workspaceId, recommendationId))
      ?? []).filter((event) => event.recordedAt <= cutoff.effectiveAsOf);
    if (events.length === 0) return null;
    const ordered = [...events].sort(
      (left, right) => left.eventRevision - right.eventRevision
    );
    return ordered.at(-1)!.aggregateSnapshot;
  }

  private appendEvent(
    aggregate: AdvisorRecommendation,
    eventType: AdvisorRecommendationEvent["eventType"],
    actorId: string,
    stamp: { recordedAt: string; temporalSequence: number }
  ): void {
    const key = this.key(aggregate.workspaceId, aggregate.id);
    const events = this.events.get(key) ?? [];
    events.push(Object.freeze({
      recommendationId: aggregate.id,
      eventRevision: aggregate.revision,
      eventType,
      recordedAt: stamp.recordedAt,
      temporalSequence: stamp.temporalSequence,
      actorId,
      aggregateSnapshotHash: advisorSnapshotHash(aggregate),
      aggregateSnapshot: aggregate
    }));
    this.events.set(key, events);
  }

  eventsFor(recommendationId: string): AdvisorRecommendationEvent[] {
    for (const [key, events] of this.events) {
      if (key.endsWith(`\u0000${recommendationId}`)) return events;
    }
    return [];
  }
}
