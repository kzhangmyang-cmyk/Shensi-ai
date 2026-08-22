import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSubjectStableKey,
  AcquisitionCanonicalSubjectResolver
} from "./acquisition-canonical-subject.js";

const DOUYIN_ACTOR =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_CREDIT_CODE = "91310000MA1FL0000N";

test("two owners discovering one Douyin actor share a workspace canonical key", () => {
  const first = canonicalSubjectStableKey(
    "workspace-a",
    {
      kind: "individual",
      platform: "DOUYIN",
      publicActorKey: ` Public:Douyin:${DOUYIN_ACTOR} `,
      canonicalProfileUrl: "https://www.douyin.com/user/MS4wLjABAAAA"
    }
  );
  const second = canonicalSubjectStableKey(
    "workspace-a",
    {
      kind: "individual",
      platform: "douyin",
      publicActorKey: `public:douyin:${DOUYIN_ACTOR}`,
      canonicalProfileUrl: null
    }
  );
  assert.equal(first.subjectStableKey, second.subjectStableKey);
  assert.equal(first.basis, "platform_public_actor");
});

test("workspace and platform remain part of individual identity", () => {
  const actor = {
    kind: "individual" as const,
    platform: "douyin",
    publicActorKey: `public:douyin:sha256:${"b".repeat(64)}`,
    canonicalProfileUrl: null
  };
  assert.notEqual(
    canonicalSubjectStableKey("workspace-a", actor).subjectStableKey,
    canonicalSubjectStableKey("workspace-b", actor).subjectStableKey
  );
  assert.notEqual(
    canonicalSubjectStableKey("workspace-a", actor).subjectStableKey,
    canonicalSubjectStableKey("workspace-a", {
      ...actor,
      platform: "kuaishou"
    }).subjectStableKey
  );
});

test("organization subjects resolve by credit code or domain and reject empty", () => {
  const byCredit = canonicalSubjectStableKey("workspace-a", {
    kind: "organization",
    platform: "tianyancha",
    creditCode: ` ${VALID_CREDIT_CODE} `,
    domain: null
  });
  assert.equal(byCredit.status, "resolved");
  assert.equal(byCredit.basis, "organization_credit_code");
  const byDomain = canonicalSubjectStableKey("workspace-a", {
    kind: "organization",
    platform: "tianyancha",
    creditCode: null,
    domain: " EXAMPLE.COM "
  });
  assert.equal(byDomain.basis, "organization_domain");
  const empty = canonicalSubjectStableKey("workspace-a", {
    kind: "organization",
    platform: "tianyancha",
    creditCode: null,
    domain: null
  });
  assert.equal(empty.status, "unassignable");
  assert.equal(empty.subjectStableKey, null);
});

test("resolver chooses the platform public actor before organization material", () => {
  const resolver = new AcquisitionCanonicalSubjectResolver();
  const result = resolver.resolve("workspace-a", {
    platform: "douyin",
    publicActorKey: `public:douyin:${DOUYIN_ACTOR}`,
    creditCode: VALID_CREDIT_CODE,
    domain: "example.com"
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.basis, "platform_public_actor");
  const organization = resolver.resolve("workspace-a", {
    platform: "tianyancha",
    publicActorKey: null,
    creditCode: VALID_CREDIT_CODE,
    domain: null
  });
  assert.equal(organization.basis, "organization_credit_code");
});
