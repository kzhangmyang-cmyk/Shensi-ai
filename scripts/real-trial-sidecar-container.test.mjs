import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupTrialSidecarContainer,
  inspectTrialSidecarContainer,
  runVirtualSidecar,
  TRIAL_COLIMA_PROFILE,
  TRIAL_SIDECAR_IMAGE,
  trialSidecarContainerIdentity,
  virtualSidecarBuildInvocation,
  virtualSidecarRunInvocation
} from "./real-trial-sidecar-container.mjs";

const hostEnvironment = Object.freeze({
  PATH: "/fixture/bin",
  HOME: "/fixture/home",
  LIMA_HOME: "/fixture/lima",
  TMPDIR: "/fixture/tmp",
  LANG: "C.UTF-8"
});

function dockerVerb(args) {
  return args[args.indexOf("docker") + 1];
}

function isColimaStatus(args) {
  return args.join(" ") === "--profile shensi-trial status --json";
}

function missingContainer() {
  return Object.assign(new Error("missing fixture container"), {
    stderr: "error: no such object: fixture"
  });
}

const environment = Object.freeze({
  MEDIACRAWLER_ENCRYPTED_VOLUME: "/private/runtime/state/mediacrawler",
  MEDIACRAWLER_PROFILE_ROOT: "/private/runtime/state/mediacrawler/profile",
  MEDIACRAWLER_CRAWL_OUTPUT_ROOT: "/private/runtime/state/mediacrawler/output",
  MEDIACRAWLER_SERVICE_SECRET_FILE: "/private/runtime/secrets/mediacrawler/service_secret",
  DOUYIN_OUTREACH_ACTIONS_ENABLED: "true",
  DOUYIN_ACTION_VISUAL_LOCATOR: "rapidocr",
  DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS: "120"
});

test("trial sidecar image includes isolated X display and loopback VNC runtime dependencies", () => {
  const dockerfile = readFileSync(new URL(
    "../services/media-crawler/Dockerfile.shensi", import.meta.url
  ), "utf8");
  assert.match(
    dockerfile,
    /apt-get install -y --no-install-recommends[^\n]*\bxvfb\b[^\n]*\bx11vnc\b/u
  );
  assert.doesNotMatch(dockerfile, /EXPOSE\s+(?:5900|5901|9222)/u);
});

test("production gateway exposes only the token-bound live-login WebSocket on the private sidecar network", () => {
  const compose = readFileSync(new URL("../deploy/compose.yaml", import.meta.url), "utf8");
  const nginx = readFileSync(new URL("../deploy/nginx/default.conf", import.meta.url), "utf8");
  const media = compose.split("\n  media-crawler:\n")[1]
    ?.split(/\n  (?:mysql|backend|frontend|gateway):\n|\n(?:secrets|volumes|networks):\n/u)[0] ?? "";
  const gateway = compose.split("\n  gateway:\n")[1]
    ?.split(/\n(?:secrets|volumes|networks):\n/u)[0] ?? "";

  assert.doesNotMatch(media, /^\s+(?:ports|expose):/mu);
  assert.match(gateway, /shensi_mediacrawler/u);
  assert.match(nginx, /location ~ "\^\/douyin-live\/\(\?<live_token>\[A-Za-z0-9_-\]\{43,128\}\)\$"/u);
  assert.match(nginx, /proxy_pass http:\/\/media-crawler:8899\/internal\/v1\/douyin\/live\/\$live_token;/u);
  assert.match(nginx, /proxy_http_version 1\.1;/u);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade;/u);
  assert.match(nginx, /proxy_set_header Connection "upgrade";/u);
});

test("trial sidecar image is built inside Colima with the exact visual-locator variant", () => {
  const invocation = virtualSidecarBuildInvocation(
    "/workspace/shensi", "rapidocr", "/fixture/colima"
  );
  assert.equal(invocation.command, "/fixture/colima");
  assert.deepEqual(invocation.args, [
    "--profile", TRIAL_COLIMA_PROFILE,
    "ssh", "--", "docker", "build",
    "--file", join("/workspace/shensi", "services/media-crawler/Dockerfile.shensi"),
    "--tag", TRIAL_SIDECAR_IMAGE,
    "--build-arg", "DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr",
    "--build-arg", "HTTP_PROXY",
    "--build-arg", "HTTPS_PROXY",
    "--build-arg", "NO_PROXY",
    "--build-arg", "http_proxy",
    "--build-arg", "https_proxy",
    "--build-arg", "no_proxy",
    "/workspace/shensi"
  ]);
});

test("trial sidecar runs headed Chromium only inside an unexposed virtual display", () => {
  const invocation = virtualSidecarRunInvocation(environment, {
    colimaBinary: "/fixture/colima",
    uid: 501,
    gid: 20
  });
  assert.equal(invocation.command, "/fixture/colima");
  assert.deepEqual(invocation.args.slice(0, 6), [
    "--profile", TRIAL_COLIMA_PROFILE, "ssh", "--", "docker", "run"
  ]);
  const identity = trialSidecarContainerIdentity(environment);
  assert.ok(invocation.args.includes(`--name=${identity.name}`));
  assert.ok(invocation.args.includes(`--label=io.shensi.trial-runtime=${identity.id}`));
  assert.ok(invocation.args.includes("--detach"));
  assert.ok(invocation.args.includes("--publish=127.0.0.1:5612:8899"));
  assert.ok(invocation.args.includes("--cpus=1.5"));
  assert.ok(invocation.args.includes("--memory=2048m"));
  assert.equal(invocation.args.some((argument) => argument.startsWith("--user=")), false);
  assert.ok(invocation.args.includes("--env=MEDIACRAWLER_BROWSER_HEADLESS=false"));
  assert.ok(invocation.args.includes("--env=MEDIACRAWLER_BROWSER_CHANNEL="));
  assert.ok(invocation.args.includes("--env=MEDIACRAWLER_BROWSER_DISPLAY=virtual"));
  for (const name of [
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy"
  ]) {
    assert.ok(invocation.args.includes(`--env=${name}`),
      `trial sidecar must inherit Colima ${name}`);
  }
  assert.ok(invocation.args.includes("--env=HOME=/tmp/shensi-browser-home"));
  assert.ok(invocation.args.includes(
    "--mount=type=bind,source=/private/runtime/secrets/mediacrawler,target=/run/secrets,readonly"
  ));
  assert.ok(invocation.args.includes(
    "--mount=type=bind,source=/private/runtime/state/mediacrawler,target=/var/lib/shensi-mediacrawler"
  ));
  assert.equal(invocation.args.at(-1), TRIAL_SIDECAR_IMAGE);
  assert.ok(invocation.args.includes("--shm-size=1g"));
  const rendered = invocation.args.join(" ");
  assert.doesNotMatch(rendered, /source=\/private\/runtime\/state,target=/u);
  assert.doesNotMatch(rendered, /source=\/private\/runtime\/secrets,target=/u);
  assert.doesNotMatch(rendered, /(?:5900|9222|vnc|--network=host)/iu);
  assert.doesNotMatch(rendered, /MEDIACRAWLER_SERVICE_SECRET=/u);
});

test("trial sidecar container identity is fixed and narrowly owned", () => {
  const first = trialSidecarContainerIdentity(environment);
  const repeated = trialSidecarContainerIdentity(environment);
  const other = trialSidecarContainerIdentity({
    ...environment,
    MEDIACRAWLER_ENCRYPTED_VOLUME: "/private/other/state/mediacrawler",
    MEDIACRAWLER_PROFILE_ROOT: "/private/other/state/mediacrawler/profile",
    MEDIACRAWLER_CRAWL_OUTPUT_ROOT: "/private/other/state/mediacrawler/output"
  });
  assert.deepEqual(first, repeated);
  assert.match(first.name, /^shensi-real-trial-mediacrawler-[a-f0-9]{16}$/u);
  assert.match(first.id, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.name, other.name);
  assert.equal(TRIAL_SIDECAR_IMAGE, "shensi-mediacrawler-trial:virtual-display");
});

test("cleanup stops only the exact labeled container id without a forced removal", async () => {
  const identity = trialSidecarContainerIdentity(environment);
  const calls = [];
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    if (isColimaStatus(args)) return { stdout: "{}\n" };
    if (dockerVerb(args) === "inspect") {
      return { stdout: `${identity.id}\t${"a".repeat(64)}\ttrue\n` };
    }
    if (dockerVerb(args) === "stop") return { stdout: `${"a".repeat(64)}\n` };
    throw new Error(`unexpected docker call: ${args.join(" ")}`);
  };

  const result = await cleanupTrialSidecarContainer(environment, {
    colimaBinary: "/fixture/colima",
    execFile,
    hostEnvironment
  });

  assert.deepEqual(result, {
    exists: true,
    stopped: true,
    id: "a".repeat(64)
  });
  assert.deepEqual(calls.filter((call) => !isColimaStatus(call.args)).map((call) => [
    dockerVerb(call.args), call.args.at(-1)
  ]), [
    ["inspect", identity.name],
    ["stop", "a".repeat(64)]
  ]);
  assert.equal(calls.some((call) => call.args.includes("--force")), false);
  assert.ok(calls.every((call) => call.options.env.HOME === "/fixture/home"));
  assert.ok(calls.every((call) => call.options.env.LIMA_HOME === "/fixture/lima"));
});

test("cleanup refuses a same-name container with a different owner label", async () => {
  const calls = [];
  await assert.rejects(cleanupTrialSidecarContainer(environment, {
    colimaBinary: "/fixture/colima",
    hostEnvironment,
    execFile: async (command, args, options) => {
      calls.push({ command, args, options });
      if (isColimaStatus(args)) return { stdout: "{}\n" };
      return {
        stdout: `${"f".repeat(64)}\t${"a".repeat(64)}\ttrue\n`
      };
    }
  }), /TRIAL_SIDECAR_CONTAINER_OWNERSHIP_MISMATCH/u);
  assert.deepEqual(calls.filter((call) => !isColimaStatus(call.args))
    .map((call) => dockerVerb(call.args)), ["inspect"]);
});

test("container inspection reports an owned orphan without changing it", async () => {
  const identity = trialSidecarContainerIdentity(environment);
  const calls = [];
  const result = await inspectTrialSidecarContainer(environment, {
    colimaBinary: "/fixture/colima",
    hostEnvironment,
    execFile: async (command, args, options) => {
      calls.push({ command, args, options });
      if (isColimaStatus(args)) return { stdout: "{}\n" };
      return {
        stdout: `${identity.id}\t${"b".repeat(64)}\ttrue\n`
      };
    }
  });
  assert.deepEqual(result, {
    exists: true,
    running: true,
    id: "b".repeat(64)
  });
  assert.deepEqual(calls.filter((call) => !isColimaStatus(call.args))
    .map((call) => dockerVerb(call.args)), ["inspect"]);
});

test("inspection treats a missing or stopped Colima profile as no running container", async () => {
  const calls = [];
  const result = await inspectTrialSidecarContainer(environment, {
    colimaBinary: "/fixture/colima",
    hostEnvironment,
    execFile: async (command, args, options) => {
      calls.push({ command, args, options });
      throw Object.assign(new Error("profile unavailable"), {
        stderr: "colima [profile=shensi-trial] is not running"
      });
    }
  });
  assert.deepEqual(result, {
    exists: false,
    running: false,
    id: null
  });
  assert.equal(calls.length, 1);
  assert.equal(isColimaStatus(calls[0].args), true);
  assert.equal(calls[0].options.env.HOME, "/fixture/home");
  assert.equal(calls[0].options.env.LIMA_HOME, "/fixture/lima");
});

test("wrapper wait failure still stops the exact owned container id", async () => {
  const identity = trialSidecarContainerIdentity(environment);
  const containerId = "c".repeat(64);
  const calls = [];
  const logs = { killCalls: [], kill(signal) { this.killCalls.push(signal); } };
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    if (isColimaStatus(args)) return { stdout: "{}\n" };
    const verb = dockerVerb(args);
    if (verb === "inspect" && args.at(-1) === identity.name) {
      throw missingContainer();
    }
    if (verb === "run") return { stdout: `${containerId}\n` };
    if (verb === "wait") throw new Error("fixture_wait_failed");
    if (verb === "inspect" && args.at(-1) === containerId) {
      return { stdout: `${identity.id}\t${containerId}\ttrue\n` };
    }
    if (verb === "stop" && args.at(-1) === containerId) {
      return { stdout: `${containerId}\n` };
    }
    throw new Error(`unexpected docker call: ${args.join(" ")}`);
  };

  await assert.rejects(runVirtualSidecar(environment, {
    colimaBinary: "/fixture/colima",
    execFile,
    hostEnvironment,
    spawn: () => logs,
    signalSource: new EventEmitter()
  }), /fixture_wait_failed/u);

  assert.equal(calls.filter((call) => dockerVerb(call.args) === "stop"
    && call.args.at(-1) === containerId).length, 1);
  assert.deepEqual(logs.killCalls, ["SIGTERM"]);
  assert.ok(calls.every((call) => call.options.env.HOME === "/fixture/home"));
  assert.ok(calls.every((call) => call.options.env.LIMA_HOME === "/fixture/lima"));
});

test("signal stop failure is observed by the wrapper without an unhandled rejection", async () => {
  const identity = trialSidecarContainerIdentity(environment);
  const containerId = "d".repeat(64);
  const signalSource = new EventEmitter();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  let markWaitStarted;
  const waitStarted = new Promise((resolveWait) => {
    markWaitStarted = resolveWait;
  });
  process.on("unhandledRejection", onUnhandled);
  try {
    const execFile = async (command, args) => {
      if (isColimaStatus(args)) return { stdout: "{}\n" };
      const verb = dockerVerb(args);
      if (verb === "inspect" && args.at(-1) === identity.name) {
        throw missingContainer();
      }
      if (verb === "run") return { stdout: `${containerId}\n` };
      if (verb === "wait") {
        markWaitStarted();
        await new Promise((resolveWait) => setImmediate(resolveWait));
        return { stdout: "143\n" };
      }
      if (verb === "inspect" && args.at(-1) === containerId) {
        return { stdout: `${identity.id}\t${containerId}\ttrue\n` };
      }
      if (verb === "stop") throw new Error("fixture_stop_failed");
      throw new Error(`unexpected docker call: ${args.join(" ")}`);
    };
    const running = runVirtualSidecar(environment, {
      colimaBinary: "/fixture/colima",
      execFile,
      hostEnvironment,
      spawn: () => ({ kill() {} }),
      signalSource
    });
    await waitStarted;
    signalSource.emit("SIGTERM");
    await assert.rejects(running, /fixture_stop_failed/u);
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
