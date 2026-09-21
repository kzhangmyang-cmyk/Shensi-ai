import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertDeveloperIdSignature } from "../scripts/macos-signature-policy.mjs";

type SignaturePolicyModule = {
  enumerateReleaseCodeObjects?: (
    appPath: string,
    isMachO: (candidate: string) => Promise<boolean>,
  ) => Promise<string[]>;
  verifyReleaseAppSignatures?: (appPath: string, operations?: {
    verifyCodesign: (target: string, deep: boolean) => Promise<void>;
    codesignDetails: (target: string) => Promise<string>;
    codesignEntitlements: (target: string) => Promise<string>;
    isMachO: (target: string) => Promise<boolean>;
  }) => Promise<{ authority: string; teamId: string }>;
};

const policyUrl = new URL("../scripts/macos-signature-policy.mjs", import.meta.url).href;
const signaturePolicy = await import(policyUrl) as SignaturePolicyModule;

const valid = `Executable=/Applications/Shensi.app/Contents/MacOS/Shensi
Identifier=com.shensi.desktop
CodeDirectory v=20500 size=500 flags=0x10000(runtime) hashes=10+7 location=embedded
Authority=Developer ID Application: Shensi Ltd (A1B2C3D4E5)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=A1B2C3D4E5
`;

test("release signature policy accepts Developer ID, Team ID, and hardened runtime", () => {
  assert.deepEqual(assertDeveloperIdSignature(valid), {
    authority: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)",
    teamId: "A1B2C3D4E5",
  });
});

test("release signature policy rejects adhoc, missing authority/team, and missing runtime", () => {
  assert.throws(() => assertDeveloperIdSignature(valid.replace("flags=0x10000(runtime)", "flags=0x2(adhoc)")), /ad hoc/u);
  assert.throws(() => assertDeveloperIdSignature(valid.replace(/^Authority=.*\n/mu, "")), /Developer ID Application/u);
  assert.throws(() => assertDeveloperIdSignature(valid.replace("TeamIdentifier=A1B2C3D4E5", "TeamIdentifier=not set")), /Team ID/u);
  assert.throws(() => assertDeveloperIdSignature(valid.replace("flags=0x10000(runtime)", "flags=0x0(none)")), /hardened runtime/u);
});

test("nested project signatures must match the outer authority and Team ID", () => {
  assert.throws(() => assertDeveloperIdSignature(
    valid.replaceAll("A1B2C3D4E5", "Z9Y8X7W6V5").replace("Shensi Ltd", "Other Ltd"),
    { authority: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)", teamId: "A1B2C3D4E5" },
  ), /does not match/u);
  assert.deepEqual(assertDeveloperIdSignature(valid, {
    authority: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)",
    teamId: "A1B2C3D4E5",
  }), { authority: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)", teamId: "A1B2C3D4E5" });
});

test("disk images require matching Developer ID and Team ID but no executable runtime flag", () => {
  const dmg = valid.replace("flags=0x10000(runtime)", "flags=0x0(none)");
  assert.deepEqual(assertDeveloperIdSignature(dmg, {
    authority: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)",
    teamId: "A1B2C3D4E5",
  }, false), { authority: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)", teamId: "A1B2C3D4E5" });
});

async function signingFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "shensi-signing-policy-"));
  const app = path.join(temporaryRoot, "Shensi.app");
  const main = path.join(app, "Contents", "MacOS", "Shensi");
  const helper = path.join(app, "Contents", "Frameworks", "Shensi Helper (Renderer).app");
  const helperMain = path.join(helper, "Contents", "MacOS", "Shensi Helper (Renderer)");
  const framework = path.join(app, "Contents", "Frameworks", "Electron Framework.framework");
  const frameworkMain = path.join(framework, "Versions", "A", "Electron Framework");
  const external = path.join(temporaryRoot, "External.app");
  await Promise.all([
    mkdir(path.dirname(main), { recursive: true }),
    mkdir(path.dirname(helperMain), { recursive: true }),
    mkdir(path.dirname(frameworkMain), { recursive: true }),
    mkdir(external, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(main, "mach-o"),
    writeFile(helperMain, "mach-o"),
    writeFile(frameworkMain, "mach-o"),
    writeFile(path.join(external, "outside"), "mach-o"),
  ]);
  await symlink(external, path.join(app, "Contents", "Frameworks", "Linked.app"));
  return { temporaryRoot, app, main, helper, helperMain, framework, frameworkMain, external };
}

test("release code-object enumeration includes nested bundles without following symlinks", async (context) => {
  assert.equal(typeof signaturePolicy.enumerateReleaseCodeObjects, "function");
  if (!signaturePolicy.enumerateReleaseCodeObjects) return;
  const fixture = await signingFixture();
  context.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));

  const objects = await signaturePolicy.enumerateReleaseCodeObjects(
    fixture.app,
    async (candidate) => [fixture.main, fixture.helperMain, fixture.frameworkMain].includes(candidate),
  );
  assert.deepEqual(new Set(objects), new Set([
    fixture.main,
    fixture.helper,
    fixture.helperMain,
    fixture.framework,
    fixture.frameworkMain,
  ]));
  assert.equal(objects.some((candidate) => candidate.startsWith(fixture.external)), false);
  assert.equal(objects.some((candidate) => candidate.endsWith("Linked.app")), false);
});

test("release verification deep-checks the outer app and individually checks nested bundles", async (context) => {
  assert.equal(typeof signaturePolicy.verifyReleaseAppSignatures, "function");
  if (!signaturePolicy.verifyReleaseAppSignatures) return;
  const fixture = await signingFixture();
  context.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const verifications: Array<{ target: string; deep: boolean }> = [];
  const jitPlist = "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>";
  const jitObjects = new Set([fixture.app, fixture.main, fixture.helper, fixture.helperMain]);

  await signaturePolicy.verifyReleaseAppSignatures(fixture.app, {
    verifyCodesign: async (target, deep) => { verifications.push({ target, deep }); },
    codesignDetails: async () => valid,
    codesignEntitlements: async (target) => jitObjects.has(target) ? jitPlist : "",
    isMachO: async (target) => [fixture.main, fixture.helperMain, fixture.frameworkMain].includes(target),
  });

  assert.equal(verifications.some(({ target, deep }) => target === fixture.app && deep), true);
  assert.equal(verifications.some(({ target, deep }) => target === fixture.helper && !deep), true);
  assert.equal(verifications.some(({ target, deep }) => target === fixture.framework && !deep), true);
});

test("release verification rejects a tampered nested framework identity", async (context) => {
  const verifyReleaseAppSignatures = signaturePolicy.verifyReleaseAppSignatures;
  assert.equal(typeof verifyReleaseAppSignatures, "function");
  if (!verifyReleaseAppSignatures) return;
  const fixture = await signingFixture();
  context.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  const tampered = valid.replaceAll("A1B2C3D4E5", "Z9Y8X7W6V5").replace("Shensi Ltd", "Other Ltd");

  await assert.rejects(() => verifyReleaseAppSignatures(fixture.app, {
    verifyCodesign: async () => undefined,
    codesignDetails: async (target) => target === fixture.framework ? tampered : valid,
    codesignEntitlements: async (target) => target === fixture.app || target === fixture.main
      || target === fixture.helper || target === fixture.helperMain
      ? "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>"
      : "",
    isMachO: async (target) => [fixture.main, fixture.helperMain, fixture.frameworkMain].includes(target),
  }), /does not match/u);
});
