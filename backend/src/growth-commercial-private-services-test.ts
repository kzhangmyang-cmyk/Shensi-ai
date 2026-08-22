import assert from "node:assert/strict";
import test from "node:test";
import {
  createGrowthPrivateServiceRegistry,
  defineGrowthPrivateServiceKey
} from "./growth-commercial-private-services.js";

test("typed private services preserve identity and fail closed when absent", () => {
  const services = createGrowthPrivateServiceRegistry();
  const key = defineGrowthPrivateServiceKey<{ read(): string }>(
    "catalog-services"
  );
  const value = Object.freeze({ read: () => "catalog" });
  assert.equal(services.get(key), null);
  assert.throws(() => services.require(key), /MISSING_GROWTH_PRIVATE_SERVICE/u);
  services.provide(key, value);
  assert.equal(services.get(key), value);
  assert.equal(services.require(key), value);
});

test("a private service key cannot be provided twice", () => {
  const services = createGrowthPrivateServiceRegistry();
  const key = defineGrowthPrivateServiceKey<{ read(): string }>(
    "catalog-services"
  );
  services.provide(key, { read: () => "first" });
  assert.throws(
    () => services.provide(key, { read: () => "second" }),
    /DUPLICATE_GROWTH_PRIVATE_SERVICE/u
  );
});

test("same-description keys remain identity isolated", () => {
  const services = createGrowthPrivateServiceRegistry();
  const first = defineGrowthPrivateServiceKey<string>("shared");
  const second = defineGrowthPrivateServiceKey<string>("shared");
  services.provide(first, "first");
  assert.equal(services.get(second), null);
});
