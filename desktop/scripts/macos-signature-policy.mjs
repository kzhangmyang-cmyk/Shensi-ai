import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertEntitlementAllowlist,
  entitlementKeysForCodeObject,
} from "./macos-entitlements-policy.mjs";

const execFileAsync = promisify(execFile);

export function assertDeveloperIdSignature(details, expected, requireRuntime = true) {
  if (/^Signature=adhoc$/mu.test(details) || /^CodeDirectory .*flags=.*\badhoc\b/mu.test(details)) {
    throw new Error("release code signature is ad hoc");
  }
  const authorities = [...details.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1]);
  const authority = authorities[0];
  if (!authority || !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(authority)) {
    throw new Error("release code signature lacks a Developer ID Application authority");
  }
  const teamId = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(details)?.[1];
  if (!teamId || !authority.endsWith(`(${teamId})`)) {
    throw new Error("release code signature has a missing or inconsistent Team ID");
  }
  if (requireRuntime && !/^CodeDirectory .*flags=.*\bruntime\b/mu.test(details)) {
    throw new Error("release code signature lacks hardened runtime");
  }
  if (expected && (authority !== expected.authority || teamId !== expected.teamId)) {
    throw new Error("nested release signature does not match the outer Developer ID authority and Team ID");
  }
  return { authority, teamId };
}

async function codesignDetails(target) {
  const { stderr } = await execFileAsync("/usr/bin/codesign", ["-d", "--verbose=4", target], {
    encoding: "utf8", maxBuffer: 2_000_000,
  });
  return stderr;
}

async function verifyCodesign(target, deep = false) {
  const arguments_ = ["--verify"];
  if (deep) arguments_.push("--deep");
  arguments_.push("--strict", "--verbose=2", target);
  await execFileAsync("/usr/bin/codesign", arguments_, {
    encoding: "utf8", maxBuffer: 2_000_000,
  });
}

async function codesignEntitlements(target) {
  const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-d", "--entitlements", "-", target], {
    encoding: "utf8", maxBuffer: 2_000_000,
  });
  return `${stdout}\n${stderr}`;
}

async function isMachO(target) {
  const { stdout } = await execFileAsync("/usr/bin/file", ["-b", target], {
    encoding: "utf8", maxBuffer: 100_000,
  });
  return stdout.includes("Mach-O");
}

const defaultReleaseOperations = {
  verifyCodesign,
  codesignDetails,
  codesignEntitlements,
  isMachO,
};

async function verifyReleaseCodeObject(target, appPath, expected, operations) {
  await operations.verifyCodesign(target, false);
  const identity = assertDeveloperIdSignature(await operations.codesignDetails(target), expected);
  const expectedEntitlements = entitlementKeysForCodeObject(target, appPath);
  assertEntitlementAllowlist(await operations.codesignEntitlements(target), expectedEntitlements);
  return identity;
}

export async function enumerateReleaseCodeObjects(root, identifyMachO = isMachO) {
  const objects = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".app") || entry.name.endsWith(".framework")) objects.push(candidate);
        queue.push(candidate);
      } else if (entry.isFile() && await identifyMachO(candidate)) objects.push(candidate);
    }
  }
  return objects;
}

export async function verifyReleaseAppSignatures(appPath, operations = defaultReleaseOperations) {
  await operations.verifyCodesign(appPath, true);
  const expected = await verifyReleaseCodeObject(appPath, appPath, undefined, operations);
  const codeObjects = await enumerateReleaseCodeObjects(appPath, operations.isMachO);
  for (const candidate of codeObjects) {
    await verifyReleaseCodeObject(candidate, appPath, expected, operations);
  }
  if (codeObjects.length === 0) throw new Error("release app contains no nested code signing objects");
  return expected;
}

export async function verifyReleaseDmgSignature(dmgPath, expected) {
  await verifyCodesign(dmgPath, false);
  return assertDeveloperIdSignature(await codesignDetails(dmgPath), expected, false);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === "app" && first && !second) {
    const identity = await verifyReleaseAppSignatures(first);
    console.log(JSON.stringify({ ok: true, machOIdentity: identity }));
  } else if (mode === "app-and-dmg" && first && second) {
    const identity = await verifyReleaseAppSignatures(first);
    await verifyReleaseDmgSignature(second, identity);
    console.log(JSON.stringify({ ok: true, containerIdentity: identity }));
  } else {
    throw new Error("usage: macos-signature-policy.mjs app <app> | app-and-dmg <app> <dmg>");
  }
}
