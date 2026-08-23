import assert from "node:assert/strict";
import test from "node:test";
import { createGrowthFinanceModule } from "./growth-finance-module.js";

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
