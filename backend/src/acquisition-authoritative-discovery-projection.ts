import { createHash } from "node:crypto";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type { CanonicalSubjectMaterial } from "./acquisition-canonical-subject.js";
import type { GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import type { ResolvedAcquisitionWorkspace } from "./growth-workspace-context.js";

export interface AuthoritativeDiscoveryAppendInput {
  eventId: string;
  platform: string;
  candidateId: string;
  ownerId: string;
  discoveredAt: string;
  material: CanonicalSubjectMaterial;
  attribution: OutcomeAttributionInput;
  origin: "acquisition_run" | "candidate_ingestion";
  payloadHash: `sha256:${string}`;
}

export interface AuthoritativeDiscoveryProjectionRow
extends AuthoritativeDiscoveryAppendInput {
  workspaceId: string;
  sourceRecordedAt: string;
  sourceTemporalSequence: number;
}

export interface AuthoritativeDiscoveryProjectionWriter {
  appendBatchFirst(
    workspace: ResolvedAcquisitionWorkspace,
    events: readonly AuthoritativeDiscoveryAppendInput[]
  ): Promise<readonly AuthoritativeDiscoveryProjectionRow[]>;
}

export interface AuthoritativeDiscoverySource {
  listDiscoveries(
    workspaceId: string,
    query: {
      platform: string;
      from: string;
      to: string;
      cutoff: GrowthSealedReadCutoff;
      after: { sourceRecordedAt: string; eventId: string } | null;
      limit: number;
    }
  ): Promise<{
    items: Array<{
      eventId: string;
      candidateId: string;
      ownerId: string;
      discoveredAt: string;
      sourceRecordedAt: string;
      sourceTemporalSequence: number;
      material: CanonicalSubjectMaterial;
      attribution: OutcomeAttributionInput;
    }>;
    next: { sourceRecordedAt: string; eventId: string } | null;
  }>;
  getWatermark(
    workspaceId: string,
    query: { platform: string; cutoff: GrowthSealedReadCutoff }
  ): Promise<{
    lastSourceRecordedAt: string | null;
    lastEventId: string | null;
    lastSourceTemporalSequence: number | null;
    eventCount: number;
    eventSetHash: `sha256:${string}`;
  }>;
}

export interface InMemoryDiscoveryRow {
  eventId: string;
  candidateId: string;
  ownerId: string;
  discoveredAt: string;
  sourceRecordedAt: string;
  sourceTemporalSequence: number;
  material: CanonicalSubjectMaterial;
  attribution: OutcomeAttributionInput;
}

export class InMemoryAuthoritativeDiscoverySource
implements AuthoritativeDiscoveryProjectionWriter, AuthoritativeDiscoverySource {
  constructor(private rows: readonly InMemoryDiscoveryRow[] = []) {}

  appendRows(rows: readonly InMemoryDiscoveryRow[]): void {
    this.rows = [...this.rows, ...rows];
  }

  async appendBatchFirst(
    workspace: ResolvedAcquisitionWorkspace,
    events: readonly AuthoritativeDiscoveryAppendInput[]
  ): Promise<readonly AuthoritativeDiscoveryProjectionRow[]> {
    const appended = events.map((event, index) => {
      const row: AuthoritativeDiscoveryProjectionRow = Object.freeze({
        ...event,
        workspaceId: workspace.workspaceId,
        sourceRecordedAt: new Date(
          Date.parse("2026-08-09T00:00:00.000Z") + index
        ).toISOString(),
        sourceTemporalSequence: index + 1
      });
      this.rows = [...this.rows, row];
      return row;
    });
    return appended;
  }

  async listDiscoveries(
    workspaceId: string,
    query: {
      platform: string;
      from: string;
      to: string;
      cutoff: GrowthSealedReadCutoff;
      after: { sourceRecordedAt: string; eventId: string } | null;
      limit: number;
    }
  ) {
    if (cutoffWorkspaceMismatch(query.cutoff, workspaceId)) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const selected = this.rows
      .filter((row) =>
        row.discoveredAt >= query.from
        && row.discoveredAt < query.to
        && row.sourceRecordedAt <= query.cutoff.effectiveAsOf)
      .sort((left, right) =>
        left.sourceRecordedAt.localeCompare(right.sourceRecordedAt)
        || left.eventId.localeCompare(right.eventId));
    const start = query.after
      ? selected.findIndex((row) =>
          row.sourceRecordedAt === query.after!.sourceRecordedAt
          && row.eventId === query.after!.eventId) + 1
      : 0;
    const page = selected.slice(start, start + query.limit + 1);
    const hasMore = page.length > query.limit;
    const items = hasMore ? page.slice(0, query.limit) : page;
    return {
      items: items.map((row) => ({
        eventId: row.eventId,
        candidateId: row.candidateId,
        ownerId: row.ownerId,
        discoveredAt: row.discoveredAt,
        sourceRecordedAt: row.sourceRecordedAt,
        sourceTemporalSequence: row.sourceTemporalSequence,
        material: row.material,
        attribution: row.attribution
      })),
      next: hasMore && items.length > 0
        ? {
            sourceRecordedAt: items[items.length - 1]!.sourceRecordedAt,
            eventId: items[items.length - 1]!.eventId
          }
        : null
    };
  }

  async getWatermark(
    workspaceId: string,
    query: { platform: string; cutoff: GrowthSealedReadCutoff }
  ) {
    if (cutoffWorkspaceMismatch(query.cutoff, workspaceId)) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const selected = this.rows.filter((row) =>
      row.sourceRecordedAt <= query.cutoff.effectiveAsOf);
    const last = selected.at(-1) ?? null;
    return {
      lastSourceRecordedAt: last?.sourceRecordedAt ?? null,
      lastEventId: last?.eventId ?? null,
      lastSourceTemporalSequence: last?.sourceTemporalSequence ?? null,
      eventCount: selected.length,
      eventSetHash: `sha256:${createHash("sha256")
        .update(selected.map((row) =>
          `${row.eventId}\u0000${row.sourceRecordedAt}`).join("\u001f"))
        .digest("hex")}` as `sha256:${string}`
    };
  }
}

function cutoffWorkspaceMismatch(
  cutoff: GrowthSealedReadCutoff,
  workspaceId: string
): boolean {
  return cutoff.workspaceId !== workspaceId;
}
