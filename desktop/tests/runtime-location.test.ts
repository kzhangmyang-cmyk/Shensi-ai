import { strict as assert } from "node:assert";
import test from "node:test";
import {
  desktopExecutionPaths,
  rendererLocation,
} from "../src/main/runtime-location.ts";

test("both renderer modes use the Main gateway and fixed built assets", () => {
  assert.deepEqual(rendererLocation({ production: true, resourcesPath: "/r" }), {
    kind: "static-gateway",
    distDir: "/r/frontend",
  });
  assert.deepEqual(rendererLocation({
    production: false,
    resourcesPath: "/r",
    repositoryRoot: "/repo",
  }), {
    kind: "static-gateway",
    distDir: "/repo/frontend/dist-desktop",
  });

  assert.throws(() => rendererLocation({ production: false, resourcesPath: "/r" }));
  assert.throws(() => rendererLocation({
    production: false,
    resourcesPath: "/r",
    repositoryRoot: "relative",
  }));
  assert.throws(() => rendererLocation({
    production: false,
    resourcesPath: "/r",
    repositoryRoot: "/repo/../other",
  }));
});

test("development execution paths derive from the compiled Main module, not app.getAppPath", () => {
  assert.deepEqual(desktopExecutionPaths({
    production: false,
    mainModuleDirectory: "/repo/desktop/dist/main",
    appPath: "/repo",
  }), {
    preloadPath: "/repo/desktop/dist/preload/preload.cjs",
    repositoryRoot: "/repo",
  });
  assert.deepEqual(desktopExecutionPaths({
    production: true,
    mainModuleDirectory: "/irrelevant/app.asar/dist/main",
    appPath: "/Applications/Shensi.app/Contents/Resources/app.asar",
  }), {
    preloadPath: "/Applications/Shensi.app/Contents/Resources/app.asar/dist/preload/preload.cjs",
    repositoryRoot: undefined,
  });
});
