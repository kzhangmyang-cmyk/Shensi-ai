import type {
  ClosureAttestation,
  RoiClosureRepository,
  RoiClosureSeries,
  RoiClosureVersion,
  RoiSnapshot,
  RoiSnapshotEntry,
  RoiSnapshotSliceMember
} from "./acquisition-roi-closure.js";

export class InMemoryRoiClosureRepository implements RoiClosureRepository {
  private readonly series = new Map<string, RoiClosureSeries>();
  private readonly attestations = new Map<string, ClosureAttestation>();
  private readonly versions = new Map<string, RoiClosureVersion>();
  private readonly snapshots = new Map<string, RoiSnapshot[]>();
  private readonly sliceMembers = new Map<string, RoiSnapshotSliceMember[]>();
  private readonly entries = new Map<string, RoiSnapshotEntry[]>();
  private readonly attestationHashes = new Map<string, string>();
  private readonly closureHashes = new Map<string, string>();
  private readonly reopenHashes = new Map<string, string>();
  private readonly reopenEvents = new Map<string, number>();
  private closeOperations = 0;

  private seriesKey(workspaceId: string, cohortId: string, currency: string) {
    return `${workspaceId}\u0000${cohortId}\u0000${currency}`;
  }

  async getSeries(
    workspaceId: string,
    cohortId: string,
    currency: string
  ): Promise<RoiClosureSeries | null> {
    return this.series.get(this.seriesKey(workspaceId, cohortId, currency))
      ?? null;
  }

  async getSeriesById(
    workspaceId: string,
    seriesId: string
  ): Promise<RoiClosureSeries | null> {
    return [...this.series.values()].find((series) =>
      series.workspaceId === workspaceId && series.id === seriesId) ?? null;
  }

  async createSeries(series: RoiClosureSeries): Promise<void> {
    this.series.set(
      this.seriesKey(series.workspaceId, series.cohortId, series.currency),
      Object.freeze({ ...series })
    );
  }

  async appendAttestation(
    attestation: ClosureAttestation,
    domainCommandHash: `sha256:${string}`
  ): Promise<ClosureAttestation> {
    const stored = Object.freeze({ ...attestation });
    this.attestations.set(
      `${attestation.workspaceId}\u0000${attestation.id}`,
      stored
    );
    this.attestationHashes.set(
      `${attestation.workspaceId}\u0000${domainCommandHash}`,
      attestation.id
    );
    return stored;
  }

  async findAttestationByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<ClosureAttestation | null> {
    const id = this.attestationHashes.get(
      `${workspaceId}\u0000${domainCommandHash}`
    );
    return id ? this.attestations.get(`${workspaceId}\u0000${id}`) ?? null : null;
  }

  async listAttestations(
    workspaceId: string,
    cohortId: string,
    currency: string
  ): Promise<ClosureAttestation[]> {
    return [...this.attestations.values()].filter((attestation) =>
      attestation.workspaceId === workspaceId
      && attestation.cohortId === cohortId
      && attestation.currency === currency);
  }

  async appendClosureVersion(input: {
    version: RoiClosureVersion;
    snapshots: RoiSnapshot[];
    sliceMembers: RoiSnapshotSliceMember[];
    entries: RoiSnapshotEntry[];
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
  }): Promise<RoiClosureVersion> {
    this.closeOperations += 1;
    const stored = Object.freeze({ ...input.version });
    this.versions.set(
      `${input.version.workspaceId}\u0000${input.version.id}`,
      stored
    );
    this.snapshots.set(input.version.id,
      input.snapshots.map((snapshot) => ({ ...snapshot })));
    this.sliceMembers.set(input.version.id,
      input.sliceMembers.map((member) => ({ ...member })));
    this.entries.set(input.version.id,
      input.entries.map((entry) => ({ ...entry })));
    this.closureHashes.set(
      `${input.version.workspaceId}\u0000${input.domainCommandHash}`,
      input.version.id
    );
    return stored;
  }

  async findClosureVersionByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureVersion | null> {
    const id = this.closureHashes.get(
      `${workspaceId}\u0000${domainCommandHash}`
    );
    return id ? this.getVersion(workspaceId, id) : null;
  }

  async getVersion(
    workspaceId: string,
    id: string
  ): Promise<RoiClosureVersion | null> {
    return this.versions.get(`${workspaceId}\u0000${id}`) ?? null;
  }

  async listSnapshots(
    _workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshot[]> {
    return this.snapshots.get(closureVersionId) ?? [];
  }

  async listSliceMembers(
    _workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshotSliceMember[]> {
    return this.sliceMembers.get(closureVersionId) ?? [];
  }

  async listEntries(
    _workspaceId: string,
    closureVersionId: string
  ): Promise<RoiSnapshotEntry[]> {
    return this.entries.get(closureVersionId) ?? [];
  }

  async markClosed(
    series: RoiClosureSeries,
    closureVersionId: string
  ): Promise<RoiClosureSeries> {
    const updated = Object.freeze({
      ...series,
      status: "closed",
      currentClosureVersionId: closureVersionId,
      revision: series.revision + 1
    });
    this.series.set(
      this.seriesKey(series.workspaceId, series.cohortId, series.currency),
      updated
    );
    return updated;
  }

  async appendReopenEvent(
    series: RoiClosureSeries,
    closureVersionId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureSeries> {
    this.reopenEvents.set(
      closureVersionId, (this.reopenEvents.get(closureVersionId) ?? 0) + 1
    );
    this.reopenHashes.set(
      `${series.workspaceId}\u0000${domainCommandHash}`,
      series.id
    );
    const updated = Object.freeze({
      ...series,
      status: "open",
      revision: series.revision + 1
    });
    this.series.set(
      this.seriesKey(series.workspaceId, series.cohortId, series.currency),
      updated
    );
    const version = this.versions.get(
      `${series.workspaceId}\u0000${closureVersionId}`
    );
    if (version) {
      this.versions.set(
        `${series.workspaceId}\u0000${closureVersionId}`,
        Object.freeze({ ...version, status: "superseded" })
      );
    }
    return updated;
  }

  async findReopenByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<RoiClosureSeries | null> {
    const id = this.reopenHashes.get(
      `${workspaceId}\u0000${domainCommandHash}`
    );
    return id ? this.getSeriesById(workspaceId, id) : null;
  }

  async countReopenEvents(closureVersionId: string): Promise<number> {
    return this.reopenEvents.get(closureVersionId) ?? 0;
  }

  async countTotalReopenEvents(): Promise<number> {
    return [...this.reopenEvents.values()].reduce(
      (sum, count) => sum + count, 0
    );
  }

  async countCloseOperations(): Promise<number> {
    return this.closeOperations;
  }

  async countClosureVersions(): Promise<number> {
    return this.versions.size;
  }

  async countAttestations(): Promise<number> {
    return this.attestations.size;
  }
}
