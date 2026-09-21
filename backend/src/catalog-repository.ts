import { createHash } from "node:crypto";
import type {
  CatalogItem,
  CommissionCatalogMigrationItemResult,
  CommissionCatalogMigrationRun,
  CommissionProductCatalogLink,
  PackageComponent,
  PackageVersion,
  PricingPolicyVersion
} from "./catalog-domain.js";
import {
  assertClosedPricingPolicyRules,
  assertClosedPricingPolicyVersion,
  immutableClone,
  normalizeCatalogItemInstants,
  normalizeCommissionCatalogMigrationRunInstants,
  normalizeCommissionProductCatalogLinkInstant,
  normalizePackageVersionInstants,
  normalizePricingPolicyVersionInstants
} from "./catalog-domain.js";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransaction,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { growthHttpIdempotencyKeyHash } from "./growth-http-idempotency-repository.js";

export interface CatalogListQuery {
  cursor: string | null;
  limit: number;
  sort: "code" | "name" | "updatedAt";
  direction: "asc" | "desc";
  type?: CatalogItem["type"];
  status?: CatalogItem["status"];
}

export type CatalogCommandResult<T> =
  | { kind: "ok"; value: T; replayed: boolean }
  | { kind: "revision_conflict"; actualRevision: number }
  | { kind: "state_conflict"; code: string }
  | { kind: "not_found" };

export interface FrozenPackageCostComponent {
  componentCatalogItemId: string;
  componentPricingPolicyVersionId: string;
  quantityMicros: number;
  unitStandardCostMinor: number;
  extendedStandardCostMinor: number;
}

export interface PackageCostSnapshot {
  workspaceId: string;
  pricingPolicyVersionId: string;
  packageVersionId: string;
  componentUnitStandardCostMinor: number;
  packageOwnUnitServiceCostMinor: number;
  totalUnitStandardCostMinor: number;
  componentSnapshotHash: `sha256:${string}`;
  components: readonly FrozenPackageCostComponent[];
}

interface CommandIdentity {
  actorId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface CreateCatalogItemCommand extends CommandIdentity {
  workspaceId: string;
  id: string;
  type: CatalogItem["type"];
  code: string;
  name: string;
  description: CatalogItem["description"];
  unit: string;
}

export interface UpdateCatalogItemCommand extends CommandIdentity {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  patch: Readonly<Partial<Pick<CatalogItem, "name" | "description" | "unit">>>;
}

export interface RetireCatalogItemCommand extends CommandIdentity {
  workspaceId: string;
  id: string;
  expectedRevision: number;
}

type PricingPolicyDraftFields = Omit<PricingPolicyVersion,
  "version" | "status" | "revision" | "createdBy" | "createdAt"
>;

export interface CreatePricingPolicyDraftCommand
extends PricingPolicyDraftFields, CommandIdentity {}

export interface CatalogLockedValidationView {
  findCatalogItem(workspaceId: string, id: string): Promise<CatalogItem | null>;
  findPricingPolicyVersion(
    workspaceId: string,
    id: string
  ): Promise<PricingPolicyVersion | null>;
  findPackageVersion(workspaceId: string, id: string): Promise<PackageVersion | null>;
  listActivePricingPolicyWindowsForUpdate(
    workspaceId: string,
    catalogItemId: string,
    currency: string
  ): Promise<readonly PricingPolicyVersion[]>;
  listPackageComponents(
    workspaceId: string,
    packageVersionId: string
  ): Promise<readonly PackageComponent[]>;
  listActivePackageVersionWindowsForUpdate(
    workspaceId: string,
    catalogItemId: string,
    currency: string
  ): Promise<readonly PackageVersion[]>;
}

export interface PricingPolicyLifecycleCommand extends CommandIdentity {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  capabilityRegistryVersion?: string;
  validate?: (
    view: CatalogLockedValidationView,
    policy: PricingPolicyVersion,
    parent: CatalogItem
  ) => Promise<void | PackageCostSnapshot>;
}

export interface PackageComponentDraft {
  componentCatalogItemId: string;
  componentPricingPolicyVersionId: string;
  quantityMicros: number;
}

type PackageVersionDraftFields = Omit<PackageVersion,
  "version" | "status" | "revision" | "createdBy" | "createdAt" | "updatedAt"
>;

export interface CreatePackageVersionDraftCommand
extends PackageVersionDraftFields, CommandIdentity {
  expectedParentRevision?: number;
  components: readonly PackageComponentDraft[];
  validate?: (
    view: CatalogLockedValidationView,
    version: PackageVersion,
    components: readonly PackageComponent[]
  ) => Promise<void>;
}

export interface UpdatePackageVersionDraftCommand extends CommandIdentity {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  patch: Readonly<Partial<Pick<PackageVersion, "currency" | "validFrom" | "validTo">>>
    & { components?: readonly PackageComponentDraft[] };
  validate?: (
    view: CatalogLockedValidationView,
    version: PackageVersion,
    components: readonly PackageComponent[]
  ) => Promise<void>;
}

export interface PackageVersionLifecycleCommand extends CommandIdentity {
  workspaceId: string;
  id: string;
  expectedRevision: number;
  validate?: (
    view: CatalogLockedValidationView,
    version: PackageVersion,
    components: readonly PackageComponent[]
  ) => Promise<void>;
}

export interface CommissionCatalogMigrationEntry {
  item: CatalogItem;
  pricingPolicy: PricingPolicyVersion;
  link: CommissionProductCatalogLink;
}

export interface CommissionCatalogMigrationCommit {
  run: CommissionCatalogMigrationRun;
  entries: readonly CommissionCatalogMigrationEntry[];
}

export interface CatalogRepository {
  appendCatalogItem(item: CatalogItem): Promise<CatalogItem>;
  findCatalogItem(workspaceId: string, id: string): Promise<CatalogItem | null>;
  listCatalogItems(
    workspaceId: string,
    query: CatalogListQuery
  ): Promise<readonly CatalogItem[]>;
  appendPricingPolicyVersion(policy: PricingPolicyVersion): Promise<PricingPolicyVersion>;
  findPricingPolicyVersion(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): Promise<PricingPolicyVersion | null>;
  listPricingPolicies(
    workspaceId: string,
    query: CatalogListQuery
  ): Promise<readonly PricingPolicyVersion[]>;
  appendPackageVersion(version: PackageVersion): Promise<PackageVersion>;
  findPackageVersion(workspaceId: string, id: string): Promise<PackageVersion | null>;
  listPackageVersions(
    workspaceId: string,
    itemId: string,
    query: CatalogListQuery
  ): Promise<readonly PackageVersion[]>;
  listPackageComponents(
    workspaceId: string,
    packageVersionId: string
  ): Promise<readonly PackageComponent[]>;
  findPackageCostSnapshot(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): Promise<PackageCostSnapshot | null>;
  replaceDraftPackageComponents(
    workspaceId: string,
    packageVersionId: string,
    components: readonly PackageComponent[]
  ): Promise<readonly PackageComponent[]>;
  findCommissionProductLink(
    workspaceId: string,
    commissionProductId: string
  ): Promise<CommissionProductCatalogLink | null>;
  findCommissionCatalogMigrationRun(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<CommissionCatalogMigrationRun | null>;
  commitCommissionCatalogMigration(
    commit: CommissionCatalogMigrationCommit
  ): Promise<CommissionCatalogMigrationRun>;
  createCatalogItem(
    command: CreateCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>>;
  updateCatalogItem(
    command: UpdateCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>>;
  retireCatalogItem(
    command: RetireCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>>;
  createPricingPolicyDraft(
    command: CreatePricingPolicyDraftCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>>;
  activatePricingPolicy(
    command: PricingPolicyLifecycleCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>>;
  retirePricingPolicy(
    command: PricingPolicyLifecycleCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>>;
  createPackageVersionDraft(
    command: CreatePackageVersionDraftCommand
  ): Promise<CatalogCommandResult<PackageVersion>>;
  updatePackageVersionDraft(
    command: UpdatePackageVersionDraftCommand
  ): Promise<CatalogCommandResult<PackageVersion>>;
  activatePackageVersion(
    command: PackageVersionLifecycleCommand
  ): Promise<CatalogCommandResult<PackageVersion>>;
  retirePackageVersion(
    command: PackageVersionLifecycleCommand
  ): Promise<CatalogCommandResult<PackageVersion>>;
}

function invalidMigrationCommit(): Error & { code: string } {
  return Object.assign(new Error("invalid_commission_catalog_migration_commit"), {
    code: "invalid_commission_catalog_migration_commit"
  });
}

function concreteToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = value.trim();
  return token !== "" && token === value && token !== "all";
}

function sha256(bytes: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validSnapshot(value: unknown): boolean {
  if (!Array.isArray(value) || typeof value[0] !== "string") return false;
  const [tag, payload] = value;
  if (["null", "undefined", "hole"].includes(tag)) return value.length === 1;
  if (tag === "boolean") return value.length === 2 && typeof payload === "boolean";
  if (["number", "string", "bigint", "date"].includes(tag)) {
    return value.length === 2 && typeof payload === "string";
  }
  if (tag === "array") {
    return value.length === 2 && Array.isArray(payload) && payload.every(validSnapshot);
  }
  if (tag === "map" && value.length === 2 && Array.isArray(payload)) {
    let previous: string | null = null;
    for (const entry of payload) {
      if (!Array.isArray(entry) || entry.length !== 2
        || !validSnapshot(entry[0]) || !validSnapshot(entry[1])) return false;
      const bytes = JSON.stringify(entry);
      if (previous !== null && previous > bytes) return false;
      previous = bytes;
    }
    return true;
  }
  if (tag === "set" && value.length === 2 && Array.isArray(payload)) {
    let previous: string | null = null;
    for (const item of payload) {
      if (!validSnapshot(item)) return false;
      const bytes = JSON.stringify(item);
      if (previous !== null && previous > bytes) return false;
      previous = bytes;
    }
    return true;
  }
  if (tag === "regexp") {
    return value.length === 4 && typeof value[1] === "string"
      && typeof value[2] === "string" && validSnapshot(value[3]);
  }
  if (tag === "object" && value.length === 2 && Array.isArray(payload)) {
    let previous: string | null = null;
    for (const entry of payload) {
      if (!Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== "string" || !validSnapshot(entry[1])) return false;
      if (previous !== null && previous >= entry[0]) return false;
      previous = entry[0];
    }
    return true;
  }
  return false;
}

export function assertCommissionCatalogMigrationCommitInvariant(
  commit: CommissionCatalogMigrationCommit
): void {
  const { run, entries } = commit;
  try {
    normalizeCommissionCatalogMigrationRunInstants(run);
    for (const entry of entries) {
      normalizeCatalogItemInstants(entry.item);
      normalizePricingPolicyVersionInstants(entry.pricingPolicy);
      normalizeCommissionProductCatalogLinkInstant(entry.link);
    }
  } catch {
    throw invalidMigrationCommit();
  }
  if (!run || !Array.isArray(entries)
    || !concreteToken(run.workspaceId) || !concreteToken(run.id)
    || !concreteToken(run.actorId) || !concreteToken(run.idempotencyKey)
    || run.status !== "completed"
    || !Number.isFinite(Date.parse(run.startedAt))
    || !Number.isFinite(Date.parse(run.completedAt))
    || !Array.isArray(run.items)) throw invalidMigrationCommit();
  if (![run.scanned, run.migrated, run.repairRequired].every((value) =>
    Number.isSafeInteger(value) && value >= 0)) throw invalidMigrationCommit();
  if (run.scanned !== run.items.length
    || run.migrated + run.repairRequired !== run.scanned) {
    throw invalidMigrationCommit();
  }
  const resultByProduct = new Map<string, CommissionCatalogMigrationItemResult>();
  let migrated = 0;
  for (const result of run.items) {
    if (result.workspaceId !== run.workspaceId
      || !concreteToken(result.commissionProductId)
      || resultByProduct.has(result.commissionProductId)
      || !validSnapshot(result.snapshot)) throw invalidMigrationCommit();
    const snapshotBytes = JSON.stringify(result.snapshot);
    if (result.snapshotHash !== sha256(snapshotBytes)) throw invalidMigrationCommit();
    if (result.status === "migrated") {
      migrated += 1;
      if (result.code !== "migrated" || !concreteToken(result.catalogItemId)
        || !concreteToken(result.pricingPolicyVersionId)) {
        throw invalidMigrationCommit();
      }
    } else if (result.status === "repair_required") {
      if (result.code === "migrated" || result.catalogItemId !== null
        || result.pricingPolicyVersionId !== null) throw invalidMigrationCommit();
    } else {
      throw invalidMigrationCommit();
    }
    resultByProduct.set(result.commissionProductId, result);
  }
  if (run.migrated !== migrated || run.repairRequired !== run.scanned - migrated) {
    throw invalidMigrationCommit();
  }
  const expectedInputHash = sha256(JSON.stringify([
    "commission-catalog-migration-input.v1",
    run.workspaceId,
    run.items.map((item) => item.snapshot)
  ]));
  const expectedReportHash = sha256(JSON.stringify([
    "commission-catalog-migration-report.v1",
    run.workspaceId,
    run.items.map((item) => [
      item.commissionProductId, item.status, item.code, item.snapshotHash
    ])
  ]));
  if (run.inputSnapshotHash !== expectedInputHash
    || run.reportHash !== expectedReportHash) throw invalidMigrationCommit();

  const itemIds = new Set<string>();
  const policyIds = new Set<string>();
  const productIds = new Set<string>();
  for (const entry of entries) {
    const { item, pricingPolicy, link } = entry;
    try {
      assertClosedPricingPolicyVersion(pricingPolicy);
    } catch {
      throw invalidMigrationCommit();
    }
    if (item?.workspaceId !== run.workspaceId
      || pricingPolicy?.workspaceId !== run.workspaceId
      || link?.workspaceId !== run.workspaceId
      || !concreteToken(item.id) || !concreteToken(pricingPolicy.id)
      || !concreteToken(link.commissionProductId)
      || pricingPolicy.catalogItemId !== item.id
      || link.catalogItemId !== item.id
      || link.pricingPolicyVersionId !== pricingPolicy.id
      || itemIds.has(item.id) || policyIds.has(pricingPolicy.id)
      || productIds.has(link.commissionProductId)) throw invalidMigrationCommit();
    const result = resultByProduct.get(link.commissionProductId);
    if (!result || result.status !== "migrated"
      || result.catalogItemId !== item.id
      || result.pricingPolicyVersionId !== pricingPolicy.id) {
      throw invalidMigrationCommit();
    }
    itemIds.add(item.id);
    policyIds.add(pricingPolicy.id);
    productIds.add(link.commissionProductId);
  }
}

function migrationEntryProductIds(
  commit: CommissionCatalogMigrationCommit
): ReadonlySet<string> {
  return new Set(commit.entries.map((entry) => entry.link.commissionProductId));
}

export function normalizeCommissionCatalogMigrationCommit(
  commit: CommissionCatalogMigrationCommit
): CommissionCatalogMigrationCommit {
  try {
    return immutableClone({
      run: normalizeCommissionCatalogMigrationRunInstants(commit.run),
      entries: commit.entries.map((entry) => ({
        item: normalizeCatalogItemInstants(entry.item),
        pricingPolicy: normalizePricingPolicyVersionInstants(
          entry.pricingPolicy
        ),
        link: normalizeCommissionProductCatalogLinkInstant(entry.link)
      }))
    }) as CommissionCatalogMigrationCommit;
  } catch {
    throw invalidMigrationCommit();
  }
}

function key(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}

function conflict(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

type CatalogCommandOperation =
  | "catalog_item.create" | "catalog_item.update" | "catalog_item.retire"
  | "pricing_policy.create_draft" | "pricing_policy.activate"
  | "pricing_policy.retire" | "package_version.create_draft"
  | "package_version.update_draft" | "package_version.activate"
  | "package_version.retire";

interface StoredCommandReceipt {
  requestHash: string;
  resourceKind: "catalog_item" | "pricing_policy" | "package_version";
  resourceId: string;
}

class CatalogCommandAbort<T> extends Error {
  constructor(readonly result: CatalogCommandResult<T>) {
    super("catalog_command_aborted");
  }
}

function abort<T>(result: CatalogCommandResult<T>): never {
  throw new CatalogCommandAbort(result);
}

function commandIdentity(command: CommandIdentity): CommandIdentity {
  if (!command.actorId.trim() || !command.idempotencyKey.trim()
    || command.idempotencyKey.length > 200 || !command.requestHash.trim()) {
    throw conflict("invalid_catalog_command_identity");
  }
  return command;
}

function receiptKey(
  workspaceId: string,
  command: CommandIdentity,
  operation: CatalogCommandOperation
): string {
  return `${workspaceId}\u0000${command.actorId}\u0000${operation}\u0000${
    growthHttpIdempotencyKeyHash(command.idempotencyKey)
  }`;
}

function snapshotMap<V>(
  map: ReadonlyMap<string, V>,
  includes: (mapKey: string) => boolean
): Array<readonly [string, V]> {
  return [...map.entries()].filter(([mapKey]) => includes(mapKey));
}

function restoreMap<V>(
  map: Map<string, V>,
  includes: (mapKey: string) => boolean,
  snapshot: readonly (readonly [string, V])[]
): void {
  for (const mapKey of map.keys()) if (includes(mapKey)) map.delete(mapKey);
  for (const [mapKey, value] of snapshot) map.set(mapKey, value);
}

function assertCatalogListQuery(query: CatalogListQuery): CatalogListQuery {
  if (!query || !Number.isSafeInteger(query.limit)
    || query.limit < 1 || query.limit > 100
    || !["code", "name", "updatedAt"].includes(query.sort)
    || !["asc", "desc"].includes(query.direction)
    || (query.cursor !== null && (
      typeof query.cursor !== "string" || query.cursor.trim() === ""
    ))
    || (query.type !== undefined
      && !["product", "service", "package"].includes(query.type))
    || (query.status !== undefined
      && !["active", "retired"].includes(query.status))) {
    throw conflict("invalid_catalog_list_query");
  }
  if (query.cursor !== null) decodeCatalogCursor(query.cursor);
  return query;
}

type CatalogCursor = readonly [string, string];

function decodeCatalogCursor(cursor: string): CatalogCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || parsed.some((value) => typeof value !== "string")) throw new Error();
    return parsed as unknown as CatalogCursor;
  } catch {
    throw conflict("invalid_catalog_cursor");
  }
}

export function encodeCatalogCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString("base64url");
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function paginate<T>(
  values: readonly T[],
  query: CatalogListQuery,
  sortValue: (value: T) => string,
  id: (value: T) => string
): readonly T[] {
  const validated = assertCatalogListQuery(query);
  const direction = validated.direction === "asc" ? 1 : -1;
  const sorted = [...values].sort((left, right) => {
    const byValue = codePointCompare(sortValue(left), sortValue(right));
    return direction * (byValue || codePointCompare(id(left), id(right)));
  });
  const cursor = validated.cursor === null
    ? null : decodeCatalogCursor(validated.cursor);
  const after = cursor === null ? sorted : sorted.filter((value) => {
    const byValue = codePointCompare(sortValue(value), cursor[0]);
    const comparison = byValue || codePointCompare(id(value), cursor[1]);
    return direction * comparison > 0;
  });
  return after.slice(0, validated.limit);
}

function catalogSortValue(item: CatalogItem, sort: CatalogListQuery["sort"]): string {
  return sort === "updatedAt" ? item.updatedAt : item[sort];
}

function lifecycleState<T extends { status: string; revision: number }>(
  current: T,
  command: CommandIdentity & { expectedRevision: number },
  from: string,
  to: string,
  invalidCode: string
): void {
  if (current.revision !== command.expectedRevision) {
    abort({ kind: "revision_conflict", actualRevision: current.revision });
  }
  if (current.status !== from) {
    abort({ kind: "state_conflict", code: invalidCode });
  }
  void to;
}

export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly catalogItems = new Map<string, CatalogItem>();
  private readonly pricingPolicies = new Map<string, PricingPolicyVersion>();
  private readonly packageVersions = new Map<string, PackageVersion>();
  private readonly packageComponents = new Map<string, readonly PackageComponent[]>();
  private readonly packageCostSnapshots = new Map<string, PackageCostSnapshot>();
  private readonly commissionLinks = new Map<string, CommissionProductCatalogLink>();
  private readonly migrationRuns = new Map<string, CommissionCatalogMigrationRun>();
  private readonly commandReceipts = new Map<string, StoredCommandReceipt>();
  private readonly appendEvidence = new Map<string, Readonly<{
    recordedAt: string;
    temporalSequence: number;
  }>>();
  private readonly transactions: GrowthTemporalTransactionRunner | null;
  private readonly temporalBarrier: GrowthTemporalBarrier | null;
  private readonly publicationTails = new Map<string, Promise<void>>();
  private readonly packageGraphTails = new Map<string, Promise<void>>();

  constructor(options: Readonly<{
    transactions: GrowthTemporalTransactionRunner;
    temporalBarrier: GrowthTemporalBarrier;
  }> | undefined = undefined) {
    if (options) {
      this.transactions = options.transactions;
      this.temporalBarrier = assertGrowthTemporalBarrier(options.temporalBarrier);
    } else {
      this.transactions = null;
      this.temporalBarrier = null;
    }
  }

  private rememberAppend(
    kind: string,
    workspaceId: string,
    id: string,
    stamp: Readonly<{ recordedAt: string; temporalSequence: number }>
  ): void {
    this.appendEvidence.set(`${kind}\u0000${key(workspaceId, id)}`, { ...stamp });
  }

  private replayFromReceipt<T>(
    workspaceId: string,
    command: CommandIdentity,
    operation: CatalogCommandOperation,
    resourceKind: StoredCommandReceipt["resourceKind"],
    read: (resourceId: string) => T | undefined
  ): CatalogCommandResult<T> | null {
    commandIdentity(command);
    const receipt = this.commandReceipts.get(receiptKey(
      workspaceId, command, operation
    ));
    if (!receipt) return null;
    if (receipt.requestHash !== command.requestHash) {
      return { kind: "state_conflict", code: "idempotency_conflict" };
    }
    if (receipt.resourceKind !== resourceKind) {
      return { kind: "state_conflict", code: "catalog_command_receipt_corrupt" };
    }
    const value = read(receipt.resourceId);
    return value === undefined
      ? { kind: "state_conflict", code: "catalog_command_receipt_corrupt" }
      : { kind: "ok", value, replayed: true };
  }

  private recordReceipt(
    workspaceId: string,
    command: CommandIdentity,
    operation: CatalogCommandOperation,
    resourceKind: StoredCommandReceipt["resourceKind"],
    resourceId: string
  ): void {
    this.commandReceipts.set(receiptKey(workspaceId, command, operation), {
      requestHash: command.requestHash, resourceKind, resourceId
    });
  }

  private workspaceJournal(workspaceId: string): () => void {
    const workspacePrefix = `${workspaceId}\u0000`;
    const evidenceMarker = `\u0000${workspaceId}\u0000`;
    const scoped = (mapKey: string) => mapKey.startsWith(workspacePrefix);
    const evidenceScoped = (mapKey: string) => mapKey.includes(evidenceMarker);
    const itemSnapshot = snapshotMap(this.catalogItems, scoped);
    const policySnapshot = snapshotMap(this.pricingPolicies, scoped);
    const versionSnapshot = snapshotMap(this.packageVersions, scoped);
    const componentSnapshot = snapshotMap(this.packageComponents, scoped);
    const costSnapshot = snapshotMap(this.packageCostSnapshots, scoped);
    const receiptSnapshot = snapshotMap(this.commandReceipts, scoped);
    const evidenceSnapshot = snapshotMap(this.appendEvidence, evidenceScoped);
    return () => {
      restoreMap(this.catalogItems, scoped, itemSnapshot);
      restoreMap(this.pricingPolicies, scoped, policySnapshot);
      restoreMap(this.packageVersions, scoped, versionSnapshot);
      restoreMap(this.packageComponents, scoped, componentSnapshot);
      restoreMap(this.packageCostSnapshots, scoped, costSnapshot);
      restoreMap(this.commandReceipts, scoped, receiptSnapshot);
      restoreMap(this.appendEvidence, evidenceScoped, evidenceSnapshot);
    };
  }

  private async acquirePublication(workspaceId: string): Promise<() => void> {
    const predecessor = this.publicationTails.get(workspaceId) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    this.publicationTails.set(workspaceId, current);
    await predecessor;
    return () => {
      resolveCurrent();
      if (this.publicationTails.get(workspaceId) === current) {
        this.publicationTails.delete(workspaceId);
      }
    };
  }

  private async withPackageGraphGuard<T>(
    workspaceId: string,
    command: () => Promise<T>
  ): Promise<T> {
    const predecessor = this.packageGraphTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.packageGraphTails.set(workspaceId, current);
    await predecessor;
    try {
      return await command();
    } finally {
      release();
      if (this.packageGraphTails.get(workspaceId) === current) {
        this.packageGraphTails.delete(workspaceId);
      }
    }
  }

  private async publishedRead<T>(workspaceId: string, read: () => T): Promise<T> {
    for (;;) {
      const tail = this.publicationTails.get(workspaceId);
      if (!tail) return read();
      await tail;
    }
  }

  private async legacyWrite<T>(
    workspaceId: string,
    write: () => T | Promise<T>
  ): Promise<T> {
    const release = await this.acquirePublication(workspaceId);
    try {
      return await write();
    } finally {
      release();
    }
  }

  private findCatalogItemNoWait(workspaceId: string, id: string): CatalogItem | null {
    const item = this.catalogItems.get(key(workspaceId, id));
    return item ? immutableClone(item) as CatalogItem : null;
  }

  private findPricingPolicyVersionNoWait(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): PricingPolicyVersion | null {
    const policy = this.pricingPolicies.get(key(workspaceId, pricingPolicyVersionId));
    return policy ? immutableClone(policy) as PricingPolicyVersion : null;
  }

  private findPackageVersionNoWait(
    workspaceId: string,
    id: string
  ): PackageVersion | null {
    const version = this.packageVersions.get(key(workspaceId, id));
    return version ? immutableClone(version) as PackageVersion : null;
  }

  private listPackageComponentsNoWait(
    workspaceId: string,
    packageVersionId: string
  ): readonly PackageComponent[] {
    if (!this.packageVersions.has(key(workspaceId, packageVersionId))) return [];
    const components = this.packageComponents.get(key(
      workspaceId, packageVersionId
    )) ?? [];
    return immutableClone(components) as readonly PackageComponent[];
  }

  private async command<T>(
    workspaceId: string,
    work: (
      tx: GrowthTemporalTransaction,
      stamp: { recordedAt: string; temporalSequence: number }
    ) => Promise<CatalogCommandResult<T>>,
    packageGraphGuard = false
  ): Promise<CatalogCommandResult<T>> {
    const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
    if (!this.transactions || !this.temporalBarrier) {
      throw new Error("catalog_temporal_adapter_required");
    }
    const transactions = this.transactions;
    const temporalBarrier = this.temporalBarrier;
    const publication: {
      restore?: () => void;
      release?: () => void;
    } = {};
    try {
      return await transactions.run(async (tx) => {
        const stamp = await temporalBarrier.allocateAppend(
          tx,
          concreteWorkspaceId
        );
        publication.release = await this.acquirePublication(concreteWorkspaceId);
        publication.restore = this.workspaceJournal(concreteWorkspaceId);
        try {
          return packageGraphGuard
            ? await this.withPackageGraphGuard(
                concreteWorkspaceId,
                () => work(tx, stamp)
              )
            : await work(tx, stamp);
        } catch (error) {
          publication.restore();
          throw error;
        }
      });
    } catch (error) {
      publication.restore?.();
      if (error instanceof CatalogCommandAbort) {
        return error.result as CatalogCommandResult<T>;
      }
      throw error;
    } finally {
      publication.release?.();
    }
  }

  async appendCatalogItem(item: CatalogItem): Promise<CatalogItem> {
    const input = immutableClone(item) as CatalogItem;
    return this.legacyWrite(input.workspaceId, () => {
      const stored = immutableClone(
        normalizeCatalogItemInstants(input)
      ) as CatalogItem;
      const itemKey = key(stored.workspaceId, stored.id);
      if (this.catalogItems.has(itemKey)) {
        throw conflict("catalog_item_already_exists");
      }
      this.catalogItems.set(itemKey, stored);
      return immutableClone(stored) as CatalogItem;
    });
  }

  async findCatalogItem(workspaceId: string, id: string): Promise<CatalogItem | null> {
    return this.publishedRead(
      workspaceId, () => this.findCatalogItemNoWait(workspaceId, id)
    );
  }

  async listCatalogItems(
    workspaceId: string,
    query: CatalogListQuery
  ): Promise<readonly CatalogItem[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    assertCatalogListQuery(query);
    return this.publishedRead(concrete, () => {
      const values = [...this.catalogItems.values()].filter((item) =>
        item.workspaceId === concrete
        && (query.type === undefined || item.type === query.type)
        && (query.status === undefined || item.status === query.status));
      return immutableClone(paginate(
        values,
        query,
        (item) => catalogSortValue(item, query.sort),
        (item) => item.id
      )) as readonly CatalogItem[];
    });
  }

  async appendPricingPolicyVersion(
    policy: PricingPolicyVersion
  ): Promise<PricingPolicyVersion> {
    const input = immutableClone(policy) as PricingPolicyVersion;
    return this.legacyWrite(input.workspaceId, () => {
      const stored = immutableClone(
        normalizePricingPolicyVersionInstants(input)
      ) as PricingPolicyVersion;
      const policyKey = key(stored.workspaceId, stored.id);
      if (this.pricingPolicies.has(policyKey)) {
        throw conflict("pricing_policy_version_already_exists");
      }
      this.pricingPolicies.set(policyKey, stored);
      return immutableClone(stored) as PricingPolicyVersion;
    });
  }

  async findPricingPolicyVersion(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): Promise<PricingPolicyVersion | null> {
    return this.publishedRead(workspaceId, () =>
      this.findPricingPolicyVersionNoWait(workspaceId, pricingPolicyVersionId));
  }

  async listPricingPolicies(
    workspaceId: string,
    query: CatalogListQuery
  ): Promise<readonly PricingPolicyVersion[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    assertCatalogListQuery(query);
    return this.publishedRead(concrete, () => {
      const values = [...this.pricingPolicies.values()].filter((policy) => {
        if (policy.workspaceId !== concrete) return false;
        const item = this.catalogItems.get(key(concrete, policy.catalogItemId));
        return Boolean(item)
          && (query.type === undefined || item!.type === query.type)
          && (query.status === undefined || item!.status === query.status);
      });
      return immutableClone(paginate(
        values,
        query,
        (policy) => {
          const item = this.catalogItems.get(key(concrete, policy.catalogItemId))!;
          return catalogSortValue(item, query.sort);
        },
        (policy) => policy.id
      )) as readonly PricingPolicyVersion[];
    });
  }

  async appendPackageVersion(version: PackageVersion): Promise<PackageVersion> {
    const input = immutableClone(version) as PackageVersion;
    return this.legacyWrite(input.workspaceId, () => {
      const stored = immutableClone(
        normalizePackageVersionInstants(input)
      ) as PackageVersion;
      const versionKey = key(stored.workspaceId, stored.id);
      if (this.packageVersions.has(versionKey)) {
        throw conflict("package_version_already_exists");
      }
      this.packageVersions.set(versionKey, stored);
      return immutableClone(stored) as PackageVersion;
    });
  }

  async findPackageVersion(workspaceId: string, id: string): Promise<PackageVersion | null> {
    return this.publishedRead(
      workspaceId, () => this.findPackageVersionNoWait(workspaceId, id)
    );
  }

  async listPackageVersions(
    workspaceId: string,
    itemId: string,
    query: CatalogListQuery
  ): Promise<readonly PackageVersion[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    assertCatalogListQuery(query);
    return this.publishedRead(concrete, () => {
      const parent = this.catalogItems.get(key(concrete, itemId));
      if (!parent
        || (query.type !== undefined && parent.type !== query.type)
        || (query.status !== undefined && parent.status !== query.status)) return [];
      const values = [...this.packageVersions.values()].filter((version) =>
        version.workspaceId === concrete
        && version.packageCatalogItemId === itemId);
      return immutableClone(paginate(
        values,
        query,
        (version) => query.sort === "updatedAt"
          ? version.updatedAt
          : catalogSortValue(parent, query.sort),
        (version) => version.id
      )) as readonly PackageVersion[];
    });
  }

  async listPackageComponents(
    workspaceId: string,
    packageVersionId: string
  ): Promise<readonly PackageComponent[]> {
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    return this.publishedRead(concrete, () =>
      this.listPackageComponentsNoWait(concrete, packageVersionId));
  }

  async findPackageCostSnapshot(
    workspaceId: string,
    pricingPolicyVersionId: string
  ): Promise<PackageCostSnapshot | null> {
    return this.publishedRead(workspaceId, () => {
      const snapshot = this.packageCostSnapshots.get(key(
        workspaceId, pricingPolicyVersionId
      ));
      return snapshot
        ? immutableClone(snapshot) as PackageCostSnapshot
        : null;
    });
  }

  async replaceDraftPackageComponents(
    workspaceId: string,
    packageVersionId: string,
    components: readonly PackageComponent[]
  ): Promise<readonly PackageComponent[]> {
    if (components.some((component) =>
      component.workspaceId !== workspaceId
      || component.packageVersionId !== packageVersionId)) {
      throw conflict("invalid_package_component_scope");
    }
    const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
    if (!this.transactions || !this.temporalBarrier) {
      throw new Error("catalog_temporal_adapter_required");
    }
    const temporalBarrier = this.temporalBarrier;
    const publication: {
      restore?: () => void;
      release?: () => void;
    } = {};
    try {
      return await this.transactions.run(async (tx) => {
        const stamped: PackageComponent[] = [];
        const stamps: Array<Readonly<{
          recordedAt: string;
          temporalSequence: number;
        }>> = [];
        const firstStamp = await temporalBarrier.allocateAppend(tx, concrete);
        publication.release = await this.acquirePublication(concrete);
        publication.restore = this.workspaceJournal(concrete);
        try {
          if (components.length === 0) {
            this.rememberAppend(
              "package-component-set", concrete, packageVersionId, firstStamp
            );
          } else {
            stamps.push(firstStamp);
            stamped.push({ ...components[0]! });
            for (const component of components.slice(1)) {
              stamps.push(await temporalBarrier.allocateAppend(tx, concrete));
              stamped.push({ ...component });
            }
          }
          const version = this.packageVersions.get(key(concrete, packageVersionId));
          if (!version) throw conflict("package_version_not_found");
          if (version.status !== "draft") throw conflict("package_version_immutable");
          const stored = immutableClone(stamped) as readonly PackageComponent[];
          this.packageComponents.set(key(concrete, packageVersionId), stored);
          stored.forEach((component, index) => this.rememberAppend(
            "package-component",
            concrete,
            `${packageVersionId}\u0000${component.componentCatalogItemId}\u0000${component.componentPricingPolicyVersionId}`,
            stamps[index]!
          ));
          return immutableClone(stored) as readonly PackageComponent[];
        } catch (error) {
          publication.restore();
          throw error;
        }
      });
    } catch (error) {
      publication.restore?.();
      throw error;
    } finally {
      publication.release?.();
    }
  }

  async createCatalogItem(
    command: CreateCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>> {
    return this.command(command.workspaceId, async (_tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, "catalog_item.create", "catalog_item",
        (resourceId) => {
          const item = this.catalogItems.get(key(command.workspaceId, resourceId));
          return item ? immutableClone(item) as CatalogItem : undefined;
        }
      );
      if (replay) abort(replay);
      const itemKey = key(command.workspaceId, command.id);
      const existing = this.catalogItems.get(itemKey);
      if (existing) {
        abort({ kind: "state_conflict", code: "catalog_item_id_conflict" });
      }
      if ([...this.catalogItems.values()].some((item) =>
        item.workspaceId === command.workspaceId && item.code === command.code)) {
        abort({ kind: "state_conflict", code: "catalog_code_conflict" });
      }
      const item = immutableClone(normalizeCatalogItemInstants({
        id: command.id,
        workspaceId: command.workspaceId,
        type: command.type,
        code: command.code,
        name: command.name,
        description: command.description,
        unit: command.unit,
        status: "active" as const,
        revision: 1,
        createdBy: command.actorId,
        createdAt: stamp.recordedAt,
        updatedAt: stamp.recordedAt
      })) as CatalogItem;
      this.catalogItems.set(itemKey, item);
      this.recordReceipt(
        command.workspaceId, command, "catalog_item.create", "catalog_item", command.id
      );
      this.rememberAppend("catalog-item", command.workspaceId, command.id, stamp);
      return { kind: "ok", value: immutableClone(item) as CatalogItem, replayed: false };
    });
  }

  async updateCatalogItem(
    command: UpdateCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>> {
    return this.command(command.workspaceId, async (_tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, "catalog_item.update", "catalog_item",
        (resourceId) => {
          const item = this.catalogItems.get(key(command.workspaceId, resourceId));
          return item ? immutableClone(item) as CatalogItem : undefined;
        }
      );
      if (replay) abort(replay);
      const itemKey = key(command.workspaceId, command.id);
      const current = this.catalogItems.get(itemKey);
      if (!current) abort({ kind: "not_found" });
      if (current.revision !== command.expectedRevision) {
        abort({ kind: "revision_conflict", actualRevision: current.revision });
      }
      if (current.status !== "active") {
        abort({ kind: "state_conflict", code: "catalog_item_retired" });
      }
      const next = immutableClone(normalizeCatalogItemInstants({
        ...current,
        ...command.patch,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as CatalogItem;
      this.catalogItems.set(itemKey, next);
      this.recordReceipt(
        command.workspaceId, command, "catalog_item.update", "catalog_item", command.id
      );
      this.rememberAppend("catalog-item", command.workspaceId, command.id, stamp);
      return { kind: "ok", value: immutableClone(next) as CatalogItem, replayed: false };
    });
  }

  async retireCatalogItem(
    command: RetireCatalogItemCommand
  ): Promise<CatalogCommandResult<CatalogItem>> {
    return this.command(command.workspaceId, async (_tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, "catalog_item.retire", "catalog_item",
        (resourceId) => {
          const item = this.catalogItems.get(key(command.workspaceId, resourceId));
          return item ? immutableClone(item) as CatalogItem : undefined;
        }
      );
      if (replay) abort(replay);
      const itemKey = key(command.workspaceId, command.id);
      const current = this.catalogItems.get(itemKey);
      if (!current) abort({ kind: "not_found" });
      if (current.revision !== command.expectedRevision) {
        abort({ kind: "revision_conflict", actualRevision: current.revision });
      }
      if (current.status !== "active") {
        abort({ kind: "state_conflict", code: "catalog_item_retired" });
      }
      const next = immutableClone(normalizeCatalogItemInstants({
        ...current,
        status: "retired" as const,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as CatalogItem;
      this.catalogItems.set(itemKey, next);
      this.recordReceipt(
        command.workspaceId, command, "catalog_item.retire", "catalog_item", command.id
      );
      this.rememberAppend("catalog-item", command.workspaceId, command.id, stamp);
      return { kind: "ok", value: immutableClone(next) as CatalogItem, replayed: false };
    });
  }

  private memoryValidationView(): CatalogLockedValidationView {
    return {
      findCatalogItem: async (workspaceId, id) =>
        this.findCatalogItemNoWait(workspaceId, id),
      findPricingPolicyVersion: async (workspaceId, id) =>
        this.findPricingPolicyVersionNoWait(workspaceId, id),
      findPackageVersion: async (workspaceId, id) =>
        this.findPackageVersionNoWait(workspaceId, id),
      listActivePricingPolicyWindowsForUpdate: async (
        workspaceId, catalogItemId, currency
      ) => immutableClone([...this.pricingPolicies.values()]
        .filter((policy) => policy.workspaceId === workspaceId
          && policy.catalogItemId === catalogItemId
          && policy.currency === currency
          && policy.status === "active")
        .sort((left, right) => codePointCompare(left.validFrom, right.validFrom)
          || codePointCompare(left.id, right.id))) as readonly PricingPolicyVersion[],
      listPackageComponents: async (workspaceId, id) =>
        this.listPackageComponentsNoWait(workspaceId, id),
      listActivePackageVersionWindowsForUpdate: async (
        workspaceId, catalogItemId, currency
      ) => immutableClone([...this.packageVersions.values()]
        .filter((version) => version.workspaceId === workspaceId
          && version.packageCatalogItemId === catalogItemId
          && version.currency === currency
          && version.status === "active")
        .sort((left, right) => codePointCompare(left.validFrom, right.validFrom)
          || codePointCompare(left.id, right.id))) as readonly PackageVersion[]
    };
  }

  async createPricingPolicyDraft(
    command: CreatePricingPolicyDraftCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.command(command.workspaceId, async (_tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, "pricing_policy.create_draft", "pricing_policy",
        (resourceId) => {
          const policy = this.pricingPolicies.get(key(command.workspaceId, resourceId));
          return policy ? immutableClone(policy) as PricingPolicyVersion : undefined;
        }
      );
      if (replay) abort(replay);
      assertClosedPricingPolicyRules(command);
      const parent = this.catalogItems.get(key(command.workspaceId, command.catalogItemId));
      if (!parent) abort({ kind: "not_found" });
      if (parent.status !== "active") {
        abort({ kind: "state_conflict", code: "catalog_item_retired" });
      }
      const policyKey = key(command.workspaceId, command.id);
      const existing = this.pricingPolicies.get(policyKey);
      if (existing) {
        abort({ kind: "state_conflict", code: "pricing_policy_id_conflict" });
      }
      const version = Math.max(0, ...[...this.pricingPolicies.values()]
        .filter((policy) => policy.workspaceId === command.workspaceId
          && policy.catalogItemId === command.catalogItemId)
        .map((policy) => policy.version)) + 1;
      const {
        actorId, idempotencyKey: _idempotencyKey,
        requestHash: _requestHash, ...fields
      } = command;
      const policy = immutableClone(normalizePricingPolicyVersionInstants({
        ...fields,
        version,
        status: "draft" as const,
        revision: 1,
        createdBy: actorId,
        createdAt: stamp.recordedAt
      })) as PricingPolicyVersion;
      assertClosedPricingPolicyVersion(policy);
      this.pricingPolicies.set(policyKey, policy);
      this.recordReceipt(
        command.workspaceId, command, "pricing_policy.create_draft",
        "pricing_policy", command.id
      );
      this.rememberAppend("pricing-policy", command.workspaceId, command.id, stamp);
      return {
        kind: "ok", value: immutableClone(policy) as PricingPolicyVersion,
        replayed: false
      };
    });
  }

  private pricingLifecycle(
    command: PricingPolicyLifecycleCommand,
    from: PricingPolicyVersion["status"],
    to: PricingPolicyVersion["status"],
    invalidCode: string,
    operation: Extract<CatalogCommandOperation,
      "pricing_policy.activate" | "pricing_policy.retire">
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.command(command.workspaceId, async (tx, initialStamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, operation, "pricing_policy",
        (resourceId) => {
          const policy = this.pricingPolicies.get(key(command.workspaceId, resourceId));
          return policy ? immutableClone(policy) as PricingPolicyVersion : undefined;
        }
      );
      if (replay) abort(replay);
      const policyKey = key(command.workspaceId, command.id);
      const current = this.pricingPolicies.get(policyKey);
      if (!current) abort({ kind: "not_found" });
      lifecycleState(current, command, from, to, invalidCode);
      const snapshot = command.validate
        ? await command.validate(
          this.memoryValidationView(),
          immutableClone(current) as PricingPolicyVersion,
          immutableClone(this.catalogItems.get(
            key(command.workspaceId, current.catalogItemId)
          )!) as CatalogItem
        ) : undefined;
      let stamp = initialStamp;
      if (snapshot) {
        if (snapshot.workspaceId !== command.workspaceId
          || snapshot.pricingPolicyVersionId !== command.id
          || snapshot.packageVersionId !== current.packageVersionId) {
          abort({ kind: "state_conflict", code: "invalid_package_cost_snapshot" });
        }
        this.packageCostSnapshots.set(
          key(command.workspaceId, command.id),
          immutableClone(snapshot) as PackageCostSnapshot
        );
        this.rememberAppend(
          "package-cost-snapshot", command.workspaceId, command.id, initialStamp
        );
        if (!this.temporalBarrier) throw new Error("catalog_temporal_adapter_required");
        stamp = await this.temporalBarrier.allocateAppend(tx, command.workspaceId);
      }
      if (to === "retired") {
        const inUse = [...this.packageVersions.values()].some((version) =>
          version.workspaceId === command.workspaceId
          && version.status === "active"
          && (this.packageComponents.get(key(command.workspaceId, version.id)) ?? [])
            .some((component) =>
              component.componentPricingPolicyVersionId === command.id));
        if (inUse) abort({
          kind: "state_conflict",
          code: "pricing_policy_in_use_by_active_package"
        });
      }
      const next = immutableClone(normalizePricingPolicyVersionInstants({
        ...current,
        capabilityRegistryVersion: to === "active"
          ? command.capabilityRegistryVersion ?? current.capabilityRegistryVersion
          : current.capabilityRegistryVersion,
        status: to,
        revision: current.revision + 1
      })) as PricingPolicyVersion;
      assertClosedPricingPolicyVersion(next);
      this.pricingPolicies.set(policyKey, next);
      this.recordReceipt(
        command.workspaceId, command, operation, "pricing_policy", command.id
      );
      this.rememberAppend("pricing-policy", command.workspaceId, command.id, stamp);
      return {
        kind: "ok", value: immutableClone(next) as PricingPolicyVersion,
        replayed: false
      };
    }, command.validate !== undefined);
  }

  activatePricingPolicy(
    command: PricingPolicyLifecycleCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.pricingLifecycle(
      command, "draft", "active", "pricing_policy_not_draft",
      "pricing_policy.activate"
    );
  }

  retirePricingPolicy(
    command: PricingPolicyLifecycleCommand
  ): Promise<CatalogCommandResult<PricingPolicyVersion>> {
    return this.pricingLifecycle(
      command, "active", "retired", "pricing_policy_not_active",
      "pricing_policy.retire"
    );
  }

  private async packageComponentsWithStamps(
    tx: GrowthTemporalTransaction,
    workspaceId: string,
    packageVersionId: string,
    components: readonly PackageComponentDraft[]
  ): Promise<readonly PackageComponent[]> {
    if (!this.temporalBarrier) {
      throw new Error("catalog_temporal_adapter_required");
    }
    const temporalBarrier = this.temporalBarrier;
    const stamped: PackageComponent[] = [];
    const stamps: Array<Readonly<{
      recordedAt: string;
      temporalSequence: number;
    }>> = [];
    for (const component of components) {
      if (!Number.isSafeInteger(component.quantityMicros)
        || component.quantityMicros <= 0) {
        throw conflict("invalid_package_component_quantity");
      }
      stamps.push(await temporalBarrier.allocateAppend(tx, workspaceId));
      stamped.push({
        workspaceId,
        packageVersionId,
        ...component
      });
    }
    stamped.forEach((component, index) => this.rememberAppend(
      "package-component",
      workspaceId,
      `${packageVersionId}\u0000${component.componentCatalogItemId}\u0000${component.componentPricingPolicyVersionId}`,
      stamps[index]!
    ));
    return immutableClone(stamped) as readonly PackageComponent[];
  }

  async createPackageVersionDraft(
    command: CreatePackageVersionDraftCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.command(command.workspaceId, async (tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, "package_version.create_draft",
        "package_version", (resourceId) => {
          const version = this.packageVersions.get(key(command.workspaceId, resourceId));
          return version ? immutableClone(version) as PackageVersion : undefined;
        }
      );
      if (replay) abort(replay);
      const parent = this.catalogItems.get(key(
        command.workspaceId, command.packageCatalogItemId
      ));
      if (!parent) abort({ kind: "not_found" });
      if (command.expectedParentRevision !== undefined
        && parent.revision !== command.expectedParentRevision) {
        abort({ kind: "revision_conflict", actualRevision: parent.revision });
      }
      if (parent.type !== "package" || parent.status !== "active") {
        abort({ kind: "state_conflict", code: "invalid_package_catalog_item" });
      }
      const versionKey = key(command.workspaceId, command.id);
      const existing = this.packageVersions.get(versionKey);
      if (existing) {
        abort({ kind: "state_conflict", code: "package_version_id_conflict" });
      }
      const version = Math.max(0, ...[...this.packageVersions.values()]
        .filter((candidate) => candidate.workspaceId === command.workspaceId
          && candidate.packageCatalogItemId === command.packageCatalogItemId)
        .map((candidate) => candidate.version)) + 1;
      const components = await this.packageComponentsWithStamps(
        tx, command.workspaceId, command.id, command.components
      );
      const packageVersion = immutableClone(normalizePackageVersionInstants({
        id: command.id,
        workspaceId: command.workspaceId,
        packageCatalogItemId: command.packageCatalogItemId,
        version,
        currency: command.currency,
        status: "draft" as const,
        validFrom: command.validFrom,
        validTo: command.validTo,
        revision: 1,
        createdBy: command.actorId,
        createdAt: stamp.recordedAt,
        updatedAt: stamp.recordedAt
      })) as PackageVersion;
      if (command.validate) {
        await command.validate(this.memoryValidationView(), packageVersion, components);
      }
      this.packageVersions.set(versionKey, packageVersion);
      this.packageComponents.set(versionKey, components);
      this.recordReceipt(
        command.workspaceId, command, "package_version.create_draft",
        "package_version", command.id
      );
      this.rememberAppend("package-version", command.workspaceId, command.id, stamp);
      return {
        kind: "ok", value: immutableClone(packageVersion) as PackageVersion,
        replayed: false
      };
    }, command.validate !== undefined);
  }

  async updatePackageVersionDraft(
    command: UpdatePackageVersionDraftCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.command(command.workspaceId, async (tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, "package_version.update_draft",
        "package_version", (resourceId) => {
          const version = this.packageVersions.get(key(command.workspaceId, resourceId));
          return version ? immutableClone(version) as PackageVersion : undefined;
        }
      );
      if (replay) abort(replay);
      const versionKey = key(command.workspaceId, command.id);
      const current = this.packageVersions.get(versionKey);
      if (!current) abort({ kind: "not_found" });
      lifecycleState(
        current, command, "draft", "draft", "package_version_immutable"
      );
      const { components: componentPatch, ...fieldPatch } = command.patch;
      const components = componentPatch === undefined
        ? this.packageComponents.get(versionKey) ?? []
        : await this.packageComponentsWithStamps(
          tx, command.workspaceId, command.id, componentPatch
        );
      const next = immutableClone(normalizePackageVersionInstants({
        ...current,
        ...fieldPatch,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as PackageVersion;
      if (command.validate) {
        await command.validate(this.memoryValidationView(), next, components);
      }
      this.packageVersions.set(versionKey, next);
      if (componentPatch !== undefined) this.packageComponents.set(versionKey, components);
      this.recordReceipt(
        command.workspaceId, command, "package_version.update_draft",
        "package_version", command.id
      );
      this.rememberAppend("package-version", command.workspaceId, command.id, stamp);
      return {
        kind: "ok", value: immutableClone(next) as PackageVersion,
        replayed: false
      };
    }, command.validate !== undefined);
  }

  private packageLifecycle(
    command: PackageVersionLifecycleCommand,
    from: PackageVersion["status"],
    to: PackageVersion["status"],
    invalidCode: string,
    operation: Extract<CatalogCommandOperation,
      "package_version.activate" | "package_version.retire">
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.command(command.workspaceId, async (_tx, stamp) => {
      const replay = this.replayFromReceipt(
        command.workspaceId, command, operation, "package_version",
        (resourceId) => {
          const version = this.packageVersions.get(key(command.workspaceId, resourceId));
          return version ? immutableClone(version) as PackageVersion : undefined;
        }
      );
      if (replay) abort(replay);
      const versionKey = key(command.workspaceId, command.id);
      const current = this.packageVersions.get(versionKey);
      if (!current) abort({ kind: "not_found" });
      lifecycleState(current, command, from, to, invalidCode);
      const components = this.packageComponents.get(versionKey) ?? [];
      if (command.validate) {
        await command.validate(
          this.memoryValidationView(),
          immutableClone(current) as PackageVersion,
          immutableClone(components) as readonly PackageComponent[]
        );
      }
      if (to === "retired") {
        const inUse = [...this.pricingPolicies.values()].some((policy) =>
          policy.workspaceId === command.workspaceId
          && policy.status === "active"
          && policy.packageVersionId === command.id);
        if (inUse) abort({
          kind: "state_conflict", code: "package_version_in_use"
        });
      }
      const next = immutableClone(normalizePackageVersionInstants({
        ...current,
        status: to,
        revision: current.revision + 1,
        updatedAt: stamp.recordedAt
      })) as PackageVersion;
      this.packageVersions.set(versionKey, next);
      this.recordReceipt(
        command.workspaceId, command, operation, "package_version", command.id
      );
      this.rememberAppend("package-version", command.workspaceId, command.id, stamp);
      return {
        kind: "ok", value: immutableClone(next) as PackageVersion,
        replayed: false
      };
    }, command.validate !== undefined);
  }

  activatePackageVersion(
    command: PackageVersionLifecycleCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.packageLifecycle(
      command, "draft", "active", "package_version_not_draft",
      "package_version.activate"
    );
  }

  retirePackageVersion(
    command: PackageVersionLifecycleCommand
  ): Promise<CatalogCommandResult<PackageVersion>> {
    return this.packageLifecycle(
      command, "active", "retired", "package_version_not_active",
      "package_version.retire"
    );
  }

  async findCommissionProductLink(
    workspaceId: string,
    commissionProductId: string
  ): Promise<CommissionProductCatalogLink | null> {
    return this.publishedRead(workspaceId, () => {
      const link = this.commissionLinks.get(key(workspaceId, commissionProductId));
      return link ? immutableClone(link) as CommissionProductCatalogLink : null;
    });
  }

  async findCommissionCatalogMigrationRun(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<CommissionCatalogMigrationRun | null> {
    return this.publishedRead(workspaceId, () => {
      const run = this.migrationRuns.get(key(workspaceId, idempotencyKey));
      return run ? immutableClone(run) as CommissionCatalogMigrationRun : null;
    });
  }

  async commitCommissionCatalogMigration(
    commit: CommissionCatalogMigrationCommit
  ): Promise<CommissionCatalogMigrationRun> {
    const input = immutableClone(commit) as CommissionCatalogMigrationCommit;
    return this.legacyWrite(input.run.workspaceId, () => {
      const canonicalCommit = normalizeCommissionCatalogMigrationCommit(input);
      assertCommissionCatalogMigrationCommitInvariant(canonicalCommit);
      return this.commitCommissionCatalogMigrationNoWait(canonicalCommit);
    });
  }

  private commitCommissionCatalogMigrationNoWait(
    commit: CommissionCatalogMigrationCommit
  ): CommissionCatalogMigrationRun {
    const runKey = key(commit.run.workspaceId, commit.run.idempotencyKey);
    const existing = this.migrationRuns.get(runKey);
    if (existing) {
      if (existing.inputSnapshotHash !== commit.run.inputSnapshotHash) {
        throw conflict("commission_catalog_migration_conflict");
      }
      return immutableClone(existing) as CommissionCatalogMigrationRun;
    }

    const entryProductIds = migrationEntryProductIds(commit);
    for (const result of commit.run.items) {
      if (result.status !== "migrated"
        || entryProductIds.has(result.commissionProductId)) continue;
      if (result.catalogItemId === null
        || result.pricingPolicyVersionId === null) throw invalidMigrationCommit();
      const link = this.commissionLinks.get(key(
        commit.run.workspaceId, result.commissionProductId
      ));
      const item = this.catalogItems.get(key(
        commit.run.workspaceId, result.catalogItemId
      ));
      const policy = this.pricingPolicies.get(key(
        commit.run.workspaceId, result.pricingPolicyVersionId
      ));
      if (!link || !item || !policy
        || link.workspaceId !== commit.run.workspaceId
        || link.catalogItemId !== result.catalogItemId
        || link.pricingPolicyVersionId !== result.pricingPolicyVersionId
        || item.workspaceId !== commit.run.workspaceId
        || item.id !== result.catalogItemId
        || policy.workspaceId !== commit.run.workspaceId
        || policy.id !== result.pricingPolicyVersionId
        || policy.catalogItemId !== result.catalogItemId) {
        throw invalidMigrationCommit();
      }
    }

    const seenItems = new Set<string>();
    const seenPolicies = new Set<string>();
    const seenLinks = new Set<string>();
    for (const entry of commit.entries) {
      const itemKey = key(entry.item.workspaceId, entry.item.id);
      const policyKey = key(entry.pricingPolicy.workspaceId, entry.pricingPolicy.id);
      const linkKey = key(entry.link.workspaceId, entry.link.commissionProductId);
      if (this.catalogItems.has(itemKey) || seenItems.has(itemKey)) {
        throw conflict("catalog_item_already_exists");
      }
      if (this.pricingPolicies.has(policyKey) || seenPolicies.has(policyKey)) {
        throw conflict("pricing_policy_version_already_exists");
      }
      if (this.commissionLinks.has(linkKey) || seenLinks.has(linkKey)) {
        throw conflict("commission_product_already_migrated");
      }
      seenItems.add(itemKey);
      seenPolicies.add(policyKey);
      seenLinks.add(linkKey);
    }

    for (const entry of commit.entries) {
      this.catalogItems.set(
        key(entry.item.workspaceId, entry.item.id),
        immutableClone(entry.item) as CatalogItem
      );
      this.pricingPolicies.set(
        key(entry.pricingPolicy.workspaceId, entry.pricingPolicy.id),
        immutableClone(entry.pricingPolicy) as PricingPolicyVersion
      );
      this.commissionLinks.set(
        key(entry.link.workspaceId, entry.link.commissionProductId),
        immutableClone(entry.link) as CommissionProductCatalogLink
      );
    }
    const storedRun = immutableClone(commit.run) as CommissionCatalogMigrationRun;
    this.migrationRuns.set(runKey, storedRun);
    return immutableClone(storedRun) as CommissionCatalogMigrationRun;
  }
}

export type { CommissionCatalogMigrationItemResult };
