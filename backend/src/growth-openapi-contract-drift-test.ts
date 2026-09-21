import assert from "node:assert/strict";
import test from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import express from "express";
import { operationSurface } from "./acquisition-openapi-contract-test-helpers.js";
import {
  createGrowthOpenApiComponents,
  createGrowthOpenApiPaths
} from "./growth-openapi.js";
import { createOpenApiDocument } from "./swagger.js";

const methods = ["get", "post", "put", "patch", "delete"] as const;

test("every immutable Growth operation equals the production OpenAPI operation", async () => {
  const released = await SwaggerParser.validate({
    openapi: "3.0.3",
    info: { title: "Growth release projection", version: "release" },
    paths: createGrowthOpenApiPaths(),
    components: createGrowthOpenApiComponents()
  }) as any;
  const productionSource = createOpenApiDocument(express());
  assert.equal(productionSource.openapi, "3.0.3");
  const production = await SwaggerParser.validate(
    structuredClone(productionSource)
  ) as any;

  for (const [path, pathItem] of Object.entries(
    released.paths
  ) as Array<[string, Record<string, any>]>) {
    for (const method of methods) {
      if (!pathItem[method]) continue;
      assert.ok(production.paths[path]?.[method], `${method.toUpperCase()} ${path}`);
      assert.deepEqual(
        operationSurface(production.paths[path][method]),
        operationSurface(pathItem[method]),
        `${method.toUpperCase()} ${path}`
      );
    }
  }
});
