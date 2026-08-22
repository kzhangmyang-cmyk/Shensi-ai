import { growthInstantMilliseconds, normalizeGrowthInstant } from "./growth-as-of.js";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthSealedReadCutoff,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export const GROWTH_WORKSPACE_SETTINGS_DEFAULT_REVISION =
  "growth-workspace-settings.v1" as const;
export const GROWTH_WORKSPACE_SETTINGS_DEFAULT_TIME_ZONE =
  "Asia/Shanghai" as const;
export const GROWTH_WORKSPACE_SETTINGS_DEFAULT_RECORDED_AT =
  "1970-01-01T00:00:00.000Z" as const;

export interface GrowthWorkspaceSettings {
  timeZone: string;
  revision: string;
  recordedAt: string;
  eventSequence: number;
}

export interface GrowthWorkspaceSettingsReader {
  get(context: ActiveWorkspaceContext): Promise<GrowthWorkspaceSettings>;
  getAt(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthWorkspaceSettings>;
}

export interface GrowthTrustedWorkspaceSettingsAppender {
  appendTrustedSettingsEvent(
    workspaceId: string,
    input: Readonly<{ timeZone: string; revision: string }>
  ): Promise<GrowthWorkspaceSettings>;
}

export function assertGrowthWorkspaceTimeZone(timeZone: string): string {
  const normalized = timeZone.trim();
  if (!normalized) throw new Error("invalid_workspace_time_zone");
  try {
    const resolved = new Intl.DateTimeFormat(undefined, {
      timeZone: normalized
    }).resolvedOptions().timeZone;
    if (!resolved) throw new Error("invalid_workspace_time_zone");
  } catch {
    throw new Error("invalid_workspace_time_zone");
  }
  return normalized;
}

function assertRevision(revision: string) {
  const normalized = revision.trim();
  if (!normalized) throw new Error("invalid_workspace_settings_revision");
  return normalized;
}

export function growthDefaultWorkspaceSettings(): GrowthWorkspaceSettings {
  return Object.freeze({
    timeZone: GROWTH_WORKSPACE_SETTINGS_DEFAULT_TIME_ZONE,
    revision: GROWTH_WORKSPACE_SETTINGS_DEFAULT_REVISION,
    recordedAt: GROWTH_WORKSPACE_SETTINGS_DEFAULT_RECORDED_AT,
    eventSequence: 1
  });
}

function validatedSettings(
  value: GrowthWorkspaceSettings
): GrowthWorkspaceSettings {
  if (!Number.isSafeInteger(value.eventSequence) || value.eventSequence < 1) {
    throw new Error("invalid_workspace_settings_event_sequence");
  }
  return Object.freeze({
    timeZone: assertGrowthWorkspaceTimeZone(value.timeZone),
    revision: assertRevision(value.revision),
    recordedAt: normalizeGrowthInstant(value.recordedAt),
    eventSequence: value.eventSequence
  });
}

function compareSettings(
  left: GrowthWorkspaceSettings,
  right: GrowthWorkspaceSettings
) {
  return growthInstantMilliseconds(left.recordedAt)
    - growthInstantMilliseconds(right.recordedAt)
    || left.eventSequence - right.eventSequence;
}

export class InMemoryGrowthWorkspaceSettingsReader
implements GrowthWorkspaceSettingsReader {
  protected readonly histories = new Map<string, GrowthWorkspaceSettings[]>();

  constructor(
    initial: Readonly<Record<string, readonly GrowthWorkspaceSettings[]>> = {}
  ) {
    for (const [workspaceId, values] of Object.entries(initial)) {
      const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
      const history = values.map((value) => validatedSettings({ ...value }));
      const sequences = new Set<number>();
      const revisions = new Set<string>();
      for (const event of history) {
        if (sequences.has(event.eventSequence)) {
          throw new Error("duplicate_workspace_settings_event_sequence");
        }
        if (revisions.has(event.revision)) {
          throw new Error("duplicate_workspace_settings_revision");
        }
        sequences.add(event.eventSequence);
        revisions.add(event.revision);
      }
      history.sort(compareSettings);
      this.histories.set(concreteWorkspaceId, history);
    }
  }

  protected history(workspaceId: string): GrowthWorkspaceSettings[] {
    return this.histories.get(workspaceId) ?? [];
  }

  async get(context: ActiveWorkspaceContext): Promise<GrowthWorkspaceSettings> {
    const workspaceId = assertConcreteGrowthWorkspaceId(context.workspaceId);
    const history = this.history(workspaceId);
    return history.at(-1) ?? growthDefaultWorkspaceSettings();
  }

  async getAt(
    context: ActiveWorkspaceContext,
    cutoff: GrowthSealedReadCutoff
  ): Promise<GrowthWorkspaceSettings> {
    const workspaceId = assertConcreteGrowthWorkspaceId(context.workspaceId);
    const trustedCutoff = assertGrowthSealedReadCutoff(cutoff, workspaceId);
    const cutoffMilliseconds = growthInstantMilliseconds(
      trustedCutoff.effectiveAsOf
    );
    const event = this.history(workspaceId)
      .filter((candidate) =>
        growthInstantMilliseconds(candidate.recordedAt) <= cutoffMilliseconds)
      .at(-1);
    return event ?? growthDefaultWorkspaceSettings();
  }
}

export class InMemoryGrowthWorkspaceSettingsRepository
extends InMemoryGrowthWorkspaceSettingsReader
implements GrowthTrustedWorkspaceSettingsAppender {
  constructor(
    private readonly transactions: GrowthTemporalTransactionRunner,
    private readonly temporalBarrier: GrowthTemporalBarrier,
    initial: Readonly<Record<string, readonly GrowthWorkspaceSettings[]>> = {}
  ) {
    super(initial);
  }

  async appendTrustedSettingsEvent(
    workspaceId: string,
    input: Readonly<{ timeZone: string; revision: string }>
  ): Promise<GrowthWorkspaceSettings> {
    const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
    const timeZone = assertGrowthWorkspaceTimeZone(input.timeZone);
    const revision = assertRevision(input.revision);
    return this.transactions.run(async (tx) => {
      const stamp = await this.temporalBarrier.allocateAppend(
        tx,
        concreteWorkspaceId
      );
      let history = this.histories.get(concreteWorkspaceId);
      if (!history) {
        history = [growthDefaultWorkspaceSettings()];
        this.histories.set(concreteWorkspaceId, history);
      }
      if (history.some((event) => event.revision === revision)) {
        throw new Error("duplicate_workspace_settings_revision");
      }
      const eventSequence = Math.max(
        ...history.map((event) => event.eventSequence)
      ) + 1;
      const event = validatedSettings({
        timeZone,
        revision,
        recordedAt: stamp.recordedAt,
        eventSequence
      });
      history.push(event);
      history.sort(compareSettings);
      return event;
    });
  }
}
