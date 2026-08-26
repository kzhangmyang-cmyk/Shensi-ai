import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  createGrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import {
  createGrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import { createGrowthFinanceModule } from "./growth-finance-module.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import { GROWTH_QUOTE_AUTHORITY_READERS } from "./growth-quote-module.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

function financeDependencies() {
  const privateServices = createGrowthPrivateServiceRegistry();
  const temporalTransactions = new InMemoryGrowthTemporalTransactionRunner();
  privateServices.provide(GROWTH_FOUNDATION_SERVICES, Object.freeze({
    httpIdempotency: {},
    workspaceSettings: {},
    workspaceContext: () => null,
    acquisitionWorkspace: { resolve: async () => null },
    commandContextFactory: () => { throw new Error("not used"); },
    temporalTransactions,
    temporalBarrier: new DefaultGrowthTemporalBarrier(temporalTransactions)
  }) as never);
  privateServices.provide(GROWTH_QUOTE_AUTHORITY_READERS, Object.freeze({
    commercialBindingVerifier: {},
    dealAuthoritativeQuotes: {}
  }) as never);
  return privateServices;
}

test("growth finance module remains one composition boundary for imports and packages",
  () => {
    const module = createGrowthFinanceModule({
      mode: "memory",
      recoveryAuthorizer: { async authorize() { return null; } } as never,
      processWorkerId: "test-worker",
      startRecovery: false
    });
    assert.equal(module.name, "growth-finance");
    assert.equal(typeof module.install, "function");
  });

test("growth finance MySQL install ensures cost estimate storage", async () => {
  const statements: string[] = [];
  const connection = {
    async query(statement: string) {
      statements.push(statement);
      if (statement.includes("GET_LOCK")) return [[{ acquired: 1 }], []];
      return [[], []];
    },
    release() {}
  };
  const pool = {
    async query(statement: string) {
      statements.push(statement);
      return [[], []];
    },
    async getConnection() { return connection; }
  };
  const module = createGrowthFinanceModule({
    mode: "mysql",
    pool: pool as never,
    recoveryAuthorizer: { async authorize() { return null; } } as never,
    processWorkerId: "test-worker",
    startRecovery: false
  });

  const handle = await module.install({
    router: express.Router(),
    toolPorts: createGrowthCommercialToolPorts(),
    privateServices: financeDependencies()
  });

  assert.ok(statements.some((statement) =>
    statement.includes("CREATE TABLE IF NOT EXISTS acquisition_cost_estimates")
  ));
  await handle.close();
});
