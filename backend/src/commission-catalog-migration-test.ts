import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { CommissionProduct } from "./types.js";
import {
  CommissionCatalogMigrationService,
  type CommissionProductMigrationSource
} from "./commission-catalog-migration.js";
import {
  commissionProductMigrationSourceFromRow
} from "./migrate-commission-products-to-catalog.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";
import type { CommissionCatalogMigrationCommit } from "./catalog-repository.js";

const BASE_PRODUCT: CommissionProduct = {
  id: "cp-1", ownerId: "admin-1", teamId: "team-a",
  name: "标准服务", category: "服务", model: "标准",
  defaultPrice: 29_800, costPrice: 8_000, currency: "CNY",
  status: "active", remark: "", updatedAt: "2026-08-09T08:00:00.000Z"
};

function migrationFixture(overrides: Partial<CommissionProduct> = {}) {
  const repository = new InMemoryCatalogRepository();
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [{ ...BASE_PRODUCT, ...overrides }],
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-1`
  });
  return { repository, service };
}

function rawMigrationFixture(defaultPrice: unknown, costPrice: unknown) {
  const repository = new InMemoryCatalogRepository();
  const product = {
    ...BASE_PRODUCT,
    defaultPrice,
    costPrice
  } as CommissionProductMigrationSource;
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [product],
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-raw`
  });
  return { repository, service };
}

test("migration creates one traceable catalog item and initial policy", async () => {
  const state = migrationFixture();
  const result = await state.service.execute(
    "team-a", "admin-1", "commission-migration-0001"
  );
  assert.equal(result.migrated, 1);
  const link = await state.repository.findCommissionProductLink("team-a", "cp-1");
  assert.ok(link);
  const item = await state.repository.findCatalogItem("team-a", link.catalogItemId);
  const policy = await state.repository.findPricingPolicyVersion(
    "team-a", link.pricingPolicyVersionId
  );
  assert.equal(item?.status, "active");
  assert.equal(policy?.source, "legacy_commission_product");
  assert.equal(policy?.status, "draft");
  assert.equal(policy?.listUnitPriceMinor, 2_980_000);
  assert.equal(policy?.unitStandardCostMinor, 800_000);
  assert.equal(policy?.absoluteFloorUnitPriceMinor, 800_000);
  assert.deepEqual(policy?.approvalThresholds, {
    discountCapability: "quote.exception.discount.approve",
    marginCapability: "quote.exception.margin.approve",
    paymentTermsCapability: "quote.exception.payment_terms.approve",
    giftCapability: "quote.exception.gift.approve",
    creditCapability: "quote.exception.credit.approve",
    manualCapability: "quote.exception.manual.approve",
    creditRiskThresholdBps: 0,
    manualEscalationEnabled: false
  });
  assert.match(result.items[0]!.snapshotHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.reportHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.items), true);
});

test("invalid currency enters repair queue and cannot be quoted", async () => {
  const state = migrationFixture({ currency: "RMB" });
  const result = await state.service.execute(
    "team-a", "admin-1", "commission-migration-0002"
  );
  assert.equal(result.repairRequired, 1);
  assert.equal(result.items[0]?.code, "invalid_currency");
  assert.equal(await state.repository.findCommissionProductLink(
    "team-a", "cp-1"
  ), null);
});

test("migration rejects decimal precision beyond the ISO exponent", async () => {
  const state = migrationFixture({ currency: "JPY", defaultPrice: 1.5 });
  const result = await state.service.preview("team-a");
  assert.equal(result.repairRequired, 1);
  assert.equal(result.items[0]?.code, "invalid_default_price_precision");
  assert.equal(await state.repository.findCatalogItem("team-a", "catalog_item-1"), null);
});

test("migration parses raw decimals exactly and repairs null or malformed amounts", async () => {
  const valid = rawMigrationFixture("29800.10", "8000.01");
  const migrated = await valid.service.execute("team-a", "admin-1", "raw-valid");
  const link = await valid.repository.findCommissionProductLink("team-a", "cp-1");
  assert.ok(link);
  const policy = await valid.repository.findPricingPolicyVersion(
    "team-a", link.pricingPolicyVersionId
  );
  assert.equal(migrated.migrated, 1);
  assert.equal(policy?.listUnitPriceMinor, 2_980_010);
  assert.equal(policy?.unitStandardCostMinor, 800_001);

  const nullPrice = await rawMigrationFixture(null, "8000.00")
    .service.preview("team-a");
  assert.equal(nullPrice.items[0]?.code, "invalid_default_price");

  const malformedCost = await rawMigrationFixture("29800.00", "8,000")
    .service.preview("team-a");
  assert.equal(malformedCost.items[0]?.code, "invalid_cost_price");
});

test("CLI row mapping preserves nullable legacy updated_at without aborting migration", async () => {
  const source = commissionProductMigrationSourceFromRow({
    id: "cp-null-time", name: "空时间产品", category: "服务", model: "标准",
    currency: "CNY", default_price: "10.00", cost_price: "2.00",
    status: "active", remark: null, owner_id: "admin-1", team_id: "team-a",
    updated_at: null
  });
  assert.equal(source.updatedAt, null);
  const service = new CommissionCatalogMigrationService({
    repository: new InMemoryCatalogRepository(),
    products: async () => [source],
    now: () => "2026-08-09T08:00:00.000Z"
  });
  const preview = await service.preview("team-a");
  assert.equal(preview.scanned, 1);
  assert.equal(preview.migrated, 1);
  assert.match(
    JSON.stringify(preview.items[0]!.snapshot),
    /"updatedAt",\["null"\]/u
  );
});

test("same idempotency key replays only an identical deterministic snapshot", async () => {
  const products: CommissionProduct[] = [{ ...BASE_PRODUCT }];
  const repository = new InMemoryCatalogRepository();
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => products,
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-1`
  });
  const first = await service.execute("team-a", "admin-1", "migration-key");
  const replay = await service.execute("team-a", "admin-1", "migration-key");
  assert.deepEqual(replay, first);
  products[0] = { ...products[0]!, defaultPrice: 30_000 };
  await assert.rejects(
    () => service.execute("team-a", "admin-1", "migration-key"),
    (error: unknown) => (error as { code?: string }).code
      === "commission_catalog_migration_conflict"
  );
});

test("incremental runs reuse exact existing catalog authority", async () => {
  const products: CommissionProduct[] = [{ ...BASE_PRODUCT }];
  const repository = new InMemoryCatalogRepository();
  let sequence = 0;
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => products,
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-incremental-${sequence++}`
  });

  const first = await service.execute("team-a", "admin-1", "incremental-key-1");
  const second = await service.execute("team-a", "admin-1", "incremental-key-2");
  const replay = await service.execute("team-a", "admin-1", "incremental-key-2");
  assert.equal(first.migrated, 1);
  assert.equal(second.migrated, 1);
  assert.deepEqual(replay, second);
  assert.equal(
    second.items[0]!.catalogItemId,
    first.items[0]!.catalogItemId
  );

  products.push({ ...BASE_PRODUCT, id: "cp-2", name: "增量服务" });
  const incremental = await service.execute(
    "team-a", "admin-1", "incremental-key-3"
  );
  assert.equal(incremental.migrated, 2);
  assert.equal(
    incremental.items.find((item) => item.commissionProductId === "cp-1")
      ?.catalogItemId,
    first.items[0]!.catalogItemId
  );
  assert.ok(await repository.findCommissionProductLink("team-a", "cp-2"));
});

test("tagged snapshots preserve invalid JavaScript values and bind idempotency bytes", async () => {
  const product = {
    ...BASE_PRODUCT,
    defaultPrice: Number.NaN,
    diagnostic: {
      positive: Number.POSITIVE_INFINITY,
      negative: Number.NEGATIVE_INFINITY,
      missing: undefined
    }
  } as CommissionProduct & { diagnostic: Record<string, unknown> };
  const repository = new InMemoryCatalogRepository();
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [product],
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-tagged`
  });
  const first = await service.execute("team-a", "admin-1", "tagged-key");
  const snapshotBytes = JSON.stringify(first.items[0]!.snapshot);
  assert.deepEqual(JSON.parse(snapshotBytes), first.items[0]!.snapshot);
  assert.match(snapshotBytes, /"number","NaN"/u);
  assert.match(snapshotBytes, /"number","Infinity"/u);
  assert.match(snapshotBytes, /"number","-Infinity"/u);
  assert.match(snapshotBytes, /"undefined"/u);
  assert.equal(
    first.items[0]!.snapshotHash,
    `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`
  );

  product.defaultPrice = Number.POSITIVE_INFINITY;
  await assert.rejects(
    () => service.execute("team-a", "admin-1", "tagged-key"),
    { code: "commission_catalog_migration_conflict" }
  );
});

test("structured snapshot tags are deterministic and reject unsupported prototypes", async () => {
  const diagnostic = new Map<unknown, unknown>([
    ["beta", new Set([2, 1])],
    ["alpha", /legacy/giu]
  ]);
  const product = { ...BASE_PRODUCT, diagnostic };
  const repository = new InMemoryCatalogRepository();
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [product],
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-structured`
  });
  const first = await service.execute("team-a", "admin-1", "structured-key");
  const firstBytes = JSON.stringify(first.items[0]!.snapshot);
  assert.match(firstBytes, /"map"/u);
  assert.match(firstBytes, /"set"/u);
  assert.match(firstBytes, /"regexp"/u);

  diagnostic.clear();
  diagnostic.set("different", 3);
  await assert.rejects(
    () => service.execute("team-a", "admin-1", "structured-key"),
    { code: "commission_catalog_migration_conflict" }
  );

  const reordered = {
    ...BASE_PRODUCT,
    diagnostic: new Map<unknown, unknown>([
      ["alpha", /legacy/giu],
      ["beta", new Set([1, 2])]
    ])
  };
  const reorderedPreview = await new CommissionCatalogMigrationService({
    repository: new InMemoryCatalogRepository(),
    products: async () => [reordered],
    now: () => "2026-08-09T08:00:00.000Z"
  }).preview("team-a");
  assert.equal(reorderedPreview.items[0]!.snapshotHash, first.items[0]!.snapshotHash);

  class UnsupportedSnapshotValue {}
  const unsupportedRepository = new InMemoryCatalogRepository();
  const unsupported = new CommissionCatalogMigrationService({
    repository: unsupportedRepository,
    products: async () => [{
      ...BASE_PRODUCT,
      diagnostic: new UnsupportedSnapshotValue()
    }],
    now: () => "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(
    () => unsupported.execute("team-a", "admin-1", "unsupported-key"),
    { code: "unsupported_commission_product_snapshot_value" }
  );
  assert.equal(await unsupportedRepository.findCommissionCatalogMigrationRun(
    "team-a", "unsupported-key"
  ), null);

  class UnsupportedProductPrototype {}
  const unsupportedProduct = Object.assign(
    new UnsupportedProductPrototype(),
    BASE_PRODUCT
  ) as CommissionProductMigrationSource;
  const unsupportedProductRepository = new InMemoryCatalogRepository();
  const unsupportedProductService = new CommissionCatalogMigrationService({
    repository: unsupportedProductRepository,
    products: async () => [unsupportedProduct],
    now: () => "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(
    () => unsupportedProductService.execute(
      "team-a", "admin-1", "unsupported-product-key"
    ),
    { code: "unsupported_commission_product_snapshot_value" }
  );

  const symbolKey = Symbol("unsupported-key");
  const symbolKeyService = new CommissionCatalogMigrationService({
    repository: new InMemoryCatalogRepository(),
    products: async () => [{
      ...BASE_PRODUCT,
      diagnostic: { [symbolKey]: "not-json-safe" }
    }],
    now: () => "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(
    () => symbolKeyService.preview("team-a"),
    { code: "unsupported_commission_product_snapshot_value" }
  );
});

test("array snapshots reject noncanonical own properties before repository mutation", async () => {
  const diagnostic = Object.assign([1, 2], { extra: "first" });
  const repository = new InMemoryCatalogRepository();
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [{ ...BASE_PRODUCT, diagnostic }],
    now: () => "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(
    () => service.execute("team-a", "admin-1", "array-extra-key"),
    { code: "unsupported_commission_product_snapshot_value" }
  );
  diagnostic.extra = "second";
  await assert.rejects(
    () => service.execute("team-a", "admin-1", "array-extra-key"),
    { code: "unsupported_commission_product_snapshot_value" }
  );
  assert.equal(await repository.findCommissionCatalogMigrationRun(
    "team-a", "array-extra-key"
  ), null);

  let accessorReads = 0;
  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    configurable: true,
    enumerable: true,
    get: () => {
      accessorReads += 1;
      return "must-not-run";
    }
  });
  const accessorService = new CommissionCatalogMigrationService({
    repository: new InMemoryCatalogRepository(),
    products: async () => [{ ...BASE_PRODUCT, diagnostic: accessorArray }],
    now: () => "2026-08-09T08:00:00.000Z"
  });
  await assert.rejects(
    () => accessorService.preview("team-a"),
    { code: "unsupported_commission_product_snapshot_value" }
  );
  assert.equal(accessorReads, 0);
});

test("migration planning uses one pre-await isolated product capture", async () => {
  const product = { ...BASE_PRODUCT };
  let categoryReads = 0;
  let identityReads = 0;
  let workspaceReads = 0;
  Object.defineProperty(product, "id", {
    configurable: true,
    enumerable: true,
    get: () => {
      identityReads += 1;
      return "cp-1";
    }
  });
  Object.defineProperty(product, "teamId", {
    configurable: true,
    enumerable: true,
    get: () => {
      workspaceReads += 1;
      return "team-a";
    }
  });
  Object.defineProperty(product, "category", {
    configurable: true,
    enumerable: true,
    get: () => {
      categoryReads += 1;
      return "服务";
    }
  });
  const repository = new InMemoryCatalogRepository();
  const originalFindRun = repository.findCommissionCatalogMigrationRun.bind(repository);
  let enterFindRun!: () => void;
  let releaseFindRun!: () => void;
  const enteredFindRun = new Promise<void>((resolve) => { enterFindRun = resolve; });
  const findRunGate = new Promise<void>((resolve) => { releaseFindRun = resolve; });
  repository.findCommissionCatalogMigrationRun = async (workspaceId, key) => {
    enterFindRun();
    await findRunGate;
    return originalFindRun(workspaceId, key);
  };
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [product],
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-isolated`
  });

  const executing = service.execute("team-a", "admin-1", "isolated-key");
  await enteredFindRun;
  product.name = "await 后名称";
  product.defaultPrice = 99_999;
  releaseFindRun();
  const run = await executing;
  const link = await repository.findCommissionProductLink("team-a", "cp-1");
  assert.ok(link);
  const item = await repository.findCatalogItem("team-a", link.catalogItemId);
  const policy = await repository.findPricingPolicyVersion(
    "team-a", link.pricingPolicyVersionId
  );
  const snapshotBytes = JSON.stringify(run.items[0]!.snapshot);
  assert.match(snapshotBytes, /"name",\["string","标准服务"\]/u);
  assert.match(snapshotBytes, /"defaultPrice",\["number","29800"\]/u);
  assert.equal(item?.name, "标准服务");
  assert.equal(policy?.listUnitPriceMinor, 2_980_000);
  assert.equal(categoryReads, 1);
  assert.equal(identityReads, 1);
  assert.equal(workspaceReads, 1);
});

test("repository returns immutable independent clones", async () => {
  const state = migrationFixture();
  const result = await state.service.execute("team-a", "admin-1", "clone-key");
  const link = await state.repository.findCommissionProductLink("team-a", "cp-1");
  assert.ok(link);
  const first = await state.repository.findPricingPolicyVersion(
    "team-a", link.pricingPolicyVersionId
  );
  const second = await state.repository.findPricingPolicyVersion(
    "team-a", link.pricingPolicyVersionId
  );
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.approvalThresholds), true);
  assert.equal(result.scanned, 1);
});

test("migration CLI rejects every ambiguous argument form before database setup", () => {
  const cli = fileURLToPath(new URL(
    "./migrate-commission-products-to-catalog.ts",
    import.meta.url
  ));
  const cases: ReadonlyArray<readonly [readonly string[], RegExp]> = [
    [["--actor", "admin", "--idempotency", "key"], /missing --workspace/u],
    [["--workspace", "team-a", "--workspace=team-b", "--actor", "admin", "--idempotency", "key"], /duplicate --workspace/u],
    [["--workspace", "team-a", "--actor", "admin", "--idempotency", "key", "--extra", "x"], /unknown argument --extra/u],
    [["--workspace", "team-a", "--actor", "--idempotency", "key"], /flag-looking value for --actor/u],
    [["--workspace=--actor", "--actor", "admin", "--idempotency", "key"], /flag-looking value for --workspace/u],
    [["--workspace", " --actor", "--actor", "admin", "--idempotency", "key"], /flag-looking value for --workspace/u],
    [["--workspace=", "--actor", "admin", "--idempotency", "key"], /blank --workspace/u],
    [["--workspace", "all", "--actor", "admin", "--idempotency", "key"], /invalid --workspace/u]
  ];
  for (const [args, expected] of cases) {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "", MYSQL_URL: "" }
      }
    );
    const output = `${child.stdout}${child.stderr}`;
    assert.notEqual(child.status, 0);
    assert.match(output, expected);
    assert.doesNotMatch(output, /requires DATABASE_URL or MYSQL_URL/u);
  }
});

function crossWorkspaceCommit(): CommissionCatalogMigrationCommit {
  const snapshot = ["object", []] as const;
  const snapshotHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(snapshot)).digest("hex")}` as const;
  const item = {
    workspaceId: "team-a", commissionProductId: "cp-1",
    status: "migrated", code: "migrated", snapshot, snapshotHash,
    catalogItemId: "item-1", pricingPolicyVersionId: "policy-1"
  } as const;
  const inputSnapshotHash = `sha256:${createHash("sha256").update(JSON.stringify([
    "commission-catalog-migration-input.v1", "team-a", [snapshot]
  ])).digest("hex")}` as const;
  const reportHash = `sha256:${createHash("sha256").update(JSON.stringify([
    "commission-catalog-migration-report.v1", "team-a",
    [["cp-1", "migrated", "migrated", snapshotHash]]
  ])).digest("hex")}` as const;
  return {
    run: {
      id: "run-1", workspaceId: "team-a", actorId: "admin-1",
      idempotencyKey: "invalid-commit", inputSnapshotHash,
      startedAt: "2026-08-09T08:00:00.000Z",
      completedAt: "2026-08-09T08:00:00.000Z", status: "completed",
      scanned: 1, migrated: 1, repairRequired: 0, reportHash, items: [item]
    },
    entries: [{
      item: { id: "item-1", workspaceId: "team-b" },
      pricingPolicy: {
        id: "policy-1", workspaceId: "team-a", catalogItemId: "item-1"
      },
      link: {
        workspaceId: "team-a", commissionProductId: "cp-1",
        catalogItemId: "item-1", pricingPolicyVersionId: "policy-1"
      }
    }]
  } as CommissionCatalogMigrationCommit;
}

test("memory migration commit rejects cross-workspace references before mutation", async () => {
  const repository = new InMemoryCatalogRepository();
  await assert.rejects(
    () => repository.commitCommissionCatalogMigration(crossWorkspaceCommit()),
    { code: "invalid_commission_catalog_migration_commit" }
  );
  assert.equal(await repository.findCatalogItem("team-b", "item-1"), null);
  assert.equal(await repository.findCommissionCatalogMigrationRun(
    "team-a", "invalid-commit"
  ), null);

  const missingEntry = crossWorkspaceCommit();
  missingEntry.entries = [];
  await assert.rejects(
    () => repository.commitCommissionCatalogMigration(missingEntry),
    { code: "invalid_commission_catalog_migration_commit" }
  );
});

test("memory migration commit rejects a false existing-authority claim", async () => {
  const state = migrationFixture();
  const first = await state.service.execute(
    "team-a", "admin-1", "existing-authority-key-1"
  );
  const falseClaim: CommissionCatalogMigrationCommit = {
    run: {
      ...first,
      id: "run-false-existing-authority",
      idempotencyKey: "existing-authority-key-2",
      items: first.items.map((item) => ({
        ...item,
        catalogItemId: "catalog-item-that-is-not-linked"
      }))
    },
    entries: []
  };
  await assert.rejects(
    () => state.repository.commitCommissionCatalogMigration(falseClaim),
    { code: "invalid_commission_catalog_migration_commit" }
  );
  assert.equal(await state.repository.findCommissionCatalogMigrationRun(
    "team-a", "existing-authority-key-2"
  ), null);
});
