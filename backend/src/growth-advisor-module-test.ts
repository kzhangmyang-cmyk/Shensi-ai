import assert from "node:assert/strict";
import test from "node:test";
import {
  createGrowthAdvisorModule,
  GROWTH_ADVISOR_SERVICES,
  type GrowthAdvisorResources
} from "./growth-advisor-module.js";
import {
  createGrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import {
  GROWTH_FOUNDATION_SERVICES,
  type GrowthFoundationServices
} from "./growth-foundation-module.js";
import {
  GROWTH_QUOTE_AUTHORITY_READERS
} from "./growth-quote-module.js";
import {
  GROWTH_FINANCE_SERVICES
} from "./growth-finance-module.js";
import {
  GROWTH_ROI_SERVICES
} from "./growth-roi-module.js";
import type express from "express";

function resourceStub() {
  let expiryStarts = 0;
  let recoveryStarts = 0;
  let closes = 0;
  const resources: GrowthAdvisorResources = {
    today: {
      async getToday() {
        throw new Error("unused");
      }
    },
    recommendations: {
      async create() {
        throw new Error("unused");
      },
      async accept() {
        throw new Error("unused");
      },
      async ignore() {
        throw new Error("unused");
      },
      async complete() {
        throw new Error("unused");
      },
      async getProjection() {
        throw new Error("unused");
      }
    } as never,
    dispatcher: {
      async dispatch() {
        throw new Error("unused");
      }
    } as never,
    recommendationExpiry: {
      start() {
        expiryStarts += 1;
      },
      async sweep() {},
      async close() {}
    } as never,
    actionRecovery: {
      async sweep() {},
      async close() {},
      start() {
        recoveryStarts += 1;
      }
    } as never,
    async closeAdvisorResources() {
      closes += 1;
    }
  };
  return {
    resources,
    counts() {
      return { expiryStarts, recoveryStarts, closes };
    }
  };
}

function growthAdvisorModuleFixture(
  options: {
    omit?: string;
    createResources?: (
      input: Parameters<NonNullable<
        Parameters<typeof createGrowthAdvisorModule>[0]["createResources"]
      >>[0]
    ) => Promise<GrowthAdvisorResources>;
  } = {}
) {
  const registry = createGrowthPrivateServiceRegistry();
  const foundation: GrowthFoundationServices = {
    httpIdempotency: {
      async reserve() {
        throw new Error("unused");
      },
      async complete() {},
      async release() {}
    },
    workspaceSettings: {
      async get() {
        throw new Error("unused");
      },
      async getAt() {
        throw new Error("unused");
      }
    } as never,
    workspaceContext: (() => {
      throw new Error("unused");
    }) as never,
    acquisitionWorkspace: {
      async resolve() {
        return null;
      }
    } as never,
    temporalTransactions: {
      async run() {
        throw new Error("unused");
      }
    },
    temporalBarrier: {
      async allocateAppend() {
        throw new Error("unused");
      },
      async sealReadCutoff() {
        throw new Error("unused");
      }
    } as never,
    commandContextFactory: (() => {
      throw new Error("unused");
    }) as never
  };
  if (options.omit !== "GROWTH_FOUNDATION_SERVICES") {
    registry.provide(GROWTH_FOUNDATION_SERVICES, foundation);
  }
  if (options.omit !== "GROWTH_QUOTE_AUTHORITY_READERS") {
    registry.provide(GROWTH_QUOTE_AUTHORITY_READERS, {} as never);
  }
  if (options.omit !== "GROWTH_FINANCE_SERVICES") {
    registry.provide(GROWTH_FINANCE_SERVICES, {} as never);
  }
  if (options.omit !== "GROWTH_ROI_SERVICES") {
    registry.provide(GROWTH_ROI_SERVICES, {} as never);
  }
  let mountedRoutes = 0;
  const router = {
    use() {
      mountedRoutes += 1;
    }
  } as unknown as express.Router;
  let resourceInput: Parameters<NonNullable<
    Parameters<typeof createGrowthAdvisorModule>[0]["createResources"]
  >>[0] | null = null;
  const stub = resourceStub();
  const module = createGrowthAdvisorModule({
    async createResources(input) {
      resourceInput = input;
      if (options.createResources) {
        return options.createResources(input);
      }
      return stub.resources;
    }
  });
  return {
    module,
    registry,
    router,
    foundation,
    stub,
    get mountedRoutes() {
      return mountedRoutes;
    },
    get resourceInput() {
      return resourceInput;
    },
    async install() {
      return module.install({
        router,
        toolPorts: {
          register() {},
          async execute() {
            throw new Error("unused");
          }
        } as never,
        privateServices: registry
      });
    }
  };
}

test("advisor module requires Foundation first and reuses its singletons", async () => {
  const fixture = growthAdvisorModuleFixture();
  const handle = await fixture.install();
  assert.equal(fixture.resourceInput?.foundation, fixture.foundation);
  assert.equal(
    fixture.resourceInput?.foundation.httpIdempotency,
    fixture.foundation.httpIdempotency
  );
  assert.equal(fixture.mountedRoutes, 1);
  assert.equal(fixture.stub.counts().expiryStarts, 1);
  assert.equal(fixture.stub.counts().recoveryStarts, 1);
  assert.equal(fixture.registry.require(GROWTH_ADVISOR_SERVICES).today, fixture.stub.resources.today);
  await handle.close();
  await handle.close();
  assert.equal(fixture.stub.counts().closes, 1);
});

test("missing Foundation fails before Advisor construction or route mounting", async () => {
  const fixture = growthAdvisorModuleFixture({
    omit: "GROWTH_FOUNDATION_SERVICES"
  });
  await assert.rejects(
    fixture.install(),
    (error: unknown) =>
      (error as { code?: string }).code === "MISSING_GROWTH_PRIVATE_SERVICE"
  );
  assert.equal(fixture.mountedRoutes, 0);
  assert.equal(fixture.stub.counts().expiryStarts, 0);
});

test("missing upstream services fail before route mounting", async () => {
  for (const omit of [
    "GROWTH_QUOTE_AUTHORITY_READERS",
    "GROWTH_FINANCE_SERVICES",
    "GROWTH_ROI_SERVICES"
  ]) {
    const fixture = growthAdvisorModuleFixture({ omit });
    await assert.rejects(
      fixture.install(),
      (error: unknown) =>
        (error as { code?: string }).code === "MISSING_GROWTH_PRIVATE_SERVICE"
    );
    assert.equal(fixture.mountedRoutes, 0);
  }
});

test("resource construction failure closes nothing and mounts no route", async () => {
  const fixture = growthAdvisorModuleFixture({
    createResources: async () => {
      throw new Error("resource-failure");
    }
  });
  await assert.rejects(fixture.install(), /resource-failure/u);
  assert.equal(fixture.mountedRoutes, 0);
  assert.equal(fixture.stub.counts().closes, 0);
  assert.equal(fixture.stub.counts().expiryStarts, 0);
});

test("duplicate install is rejected", async () => {
  const fixture = growthAdvisorModuleFixture();
  await fixture.install();
  await assert.rejects(
    fixture.install(),
    /GROWTH_ADVISOR_MODULE_ALREADY_INSTALLED/u
  );
});
