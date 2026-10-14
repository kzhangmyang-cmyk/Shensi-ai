import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

export interface DouyinAutomationSchedule {
  enabled: boolean;
  localTime: string;
  timeZone: string;
}

export interface DouyinAutomationLimits {
  maxComments?: number;
  maxVideos: number;
  maxCommentsPerVideo: number;
  maxPagesPerVideo: number;
  maxDurationSeconds: number;
}

export interface DouyinAutomationPolicyInput {
  keywords: string[];
  schedule: DouyinAutomationSchedule;
  dailyCandidateLimit?: number;
  collectCreators: boolean;
  collectDemandComments: boolean;
  limits: DouyinAutomationLimits;
}

export interface NormalizedDouyinAutomationPolicyInput
extends Omit<DouyinAutomationPolicyInput, "dailyCandidateLimit"> {
  dailyCandidateLimit: number;
}

interface DouyinAutomationPolicyAuthority {
  workspaceId: string;
  planId: string;
  planVersionId: string;
  planVersion: number;
  planSnapshotHash: string;
  accountId: string | null;
  accountLoginStateVersion: number | null;
}

export interface DouyinAutomationPolicyResource
extends NormalizedDouyinAutomationPolicyInput,
  DouyinAutomationPolicyAuthority {
  id: string | null;
  source: "default" | "version";
  version: number;
  revision: number;
  etag: string;
  policyHash: string;
  createdBy: string | null;
  createdAt: string | null;
}

export interface DouyinAutomationPolicyVersion
extends DouyinAutomationPolicyResource {
  id: string;
  source: "version";
  accountId: string;
  accountLoginStateVersion: number;
  createdBy: string;
  createdAt: string;
}

export interface DouyinAutomationRunNowInput {
  reason?: string;
}

export interface DouyinAutomationRunIntent {
  id: string;
  acquisitionRunId: string;
  workspaceId: string;
  planId: string;
  planVersionId: string;
  planVersion: number;
  planSnapshotHash: string;
  policyVersionId: string;
  policyHash: string;
  accountId: string;
  accountLoginStateVersion: number;
  dailyBudgetId: string;
  localDate: string;
  trigger: "run_now" | "scheduled";
  collectCreators: boolean;
  collectDemandComments: boolean;
  status: "queued";
  reason: string | null;
  createdBy: string;
  createdAt: string;
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string
) {
  if (!Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum) {
    throw new TypeError(code);
  }
  return Number(value);
}

function normalizedKeywords(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new TypeError("invalid_automation_keywords");
  }
  const keywords = value.map((item) => {
    if (typeof item !== "string") {
      throw new TypeError("invalid_automation_keywords");
    }
    const keyword = item.trim();
    if (!keyword || [...keyword].length > 100) {
      throw new TypeError("invalid_automation_keywords");
    }
    return keyword;
  });
  const identities = keywords.map((keyword) =>
    keyword.toLocaleLowerCase("en-US"));
  if (new Set(identities).size !== identities.length) {
    throw new TypeError("invalid_automation_keywords");
  }
  return keywords;
}

function normalizedTimeZone(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new TypeError("invalid_automation_time_zone");
  }
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new TypeError("invalid_automation_time_zone");
  }
  return timeZone;
}

export function normalizeDouyinAutomationPolicyInput(
  input: DouyinAutomationPolicyInput
): NormalizedDouyinAutomationPolicyInput {
  if (!input || typeof input !== "object") {
    throw new TypeError("invalid_automation_policy");
  }
  if (typeof input.schedule?.enabled !== "boolean") {
    throw new TypeError("invalid_automation_schedule");
  }
  if (typeof input.schedule.localTime !== "string"
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.schedule.localTime)) {
    throw new TypeError("invalid_automation_local_time");
  }
  if (typeof input.collectCreators !== "boolean"
    || typeof input.collectDemandComments !== "boolean") {
    throw new TypeError("invalid_automation_collection");
  }
  if (!input.collectCreators && !input.collectDemandComments) {
    throw new TypeError("automation_collection_required");
  }
  return Object.freeze({
    keywords: Object.freeze(normalizedKeywords(input.keywords)) as string[],
    schedule: Object.freeze({
      enabled: input.schedule.enabled,
      localTime: input.schedule.localTime,
      timeZone: normalizedTimeZone(input.schedule.timeZone)
    }),
    dailyCandidateLimit: integerInRange(
      input.dailyCandidateLimit ?? 50,
      1,
      200,
      "invalid_daily_candidate_limit"
    ),
    collectCreators: input.collectCreators,
    collectDemandComments: input.collectDemandComments,
    limits: Object.freeze({
      ...(input.limits?.maxComments === undefined ? {} : { maxComments: integerInRange(input.limits.maxComments, 1, 10000, "invalid_automation_limits") }),
      maxVideos: integerInRange(
        input.limits?.maxVideos,
        1,
        200,
        "invalid_automation_limits"
      ),
      maxCommentsPerVideo: integerInRange(
        input.limits?.maxCommentsPerVideo,
        1,
        200,
        "invalid_automation_limits"
      ),
      maxPagesPerVideo: integerInRange(
        input.limits?.maxPagesPerVideo,
        1,
        20,
        "invalid_automation_limits"
      ),
      maxDurationSeconds: integerInRange(
        input.limits?.maxDurationSeconds,
        60,
        14_400,
        "invalid_automation_limits"
      )
    })
  });
}

export function defaultDouyinAutomationPolicyInput(
  keywords: string[] = ["公开采购需求"]
): NormalizedDouyinAutomationPolicyInput {
  return normalizeDouyinAutomationPolicyInput({
    keywords,
    schedule: {
      enabled: false,
      localTime: "09:30",
      timeZone: "Asia/Shanghai"
    },
    dailyCandidateLimit: 50,
    collectCreators: false,
    collectDemandComments: true,
    limits: {
      maxVideos: 30,
      maxCommentsPerVideo: 50,
      maxPagesPerVideo: 3,
      maxDurationSeconds: 3_600
    }
  });
}

export function douyinAutomationHash(value: unknown) {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex")}`;
}

export function douyinAutomationDefaultEtag(
  planId: string,
  planVersionId: string
) {
  return `"douyin-automation-default-${douyinAutomationHash({
    planId,
    planVersionId
  }).slice(7, 31)}"`;
}

export function douyinAutomationVersionEtag(
  planId: string,
  revision: number
) {
  return `"douyin-automation:${planId}:${revision}"`;
}

export function localDateInTimeZone(instant: string, timeZone: string) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("invalid_automation_clock");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new TypeError("invalid_automation_clock");
  return `${year}-${month}-${day}`;
}
