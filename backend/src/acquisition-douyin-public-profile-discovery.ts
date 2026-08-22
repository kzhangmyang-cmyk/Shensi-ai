import { createHash } from "node:crypto";
import {
  classifyDouyinPublicSource
} from "./acquisition-douyin-public-source.js";
import {
  isVerifiedAcquisitionPublicProfileUrl,
  normalizeAcquisitionPublicUrl
} from "./acquisition-public-identity-resolver.js";
import {
  fetchProviderHttpWithRedirectTrace,
  type ProviderHttpRedirectTrace
} from "./provider-http-client.js";
import { ProviderContractError, type ProviderNetworkPolicy } from "./provider-contract.js";

const DOUYIN_PUBLIC_PROFILE_POLICY: ProviderNetworkPolicy = {
  allowedHosts: [
    "douyin.com",
    "www.douyin.com",
    "v.douyin.com",
    "iesdouyin.com",
    "www.iesdouyin.com"
  ],
  redirectHosts: [
    "douyin.com",
    "www.douyin.com",
    "v.douyin.com",
    "iesdouyin.com",
    "www.iesdouyin.com"
  ],
  allowedPathPrefixes: ["/"],
  allowedMethods: ["GET"]
};

const EXACT_DOUYIN_HOSTS = new Set(DOUYIN_PUBLIC_PROFILE_POLICY.allowedHosts);
const RESTRICTED_PATH = /\/(?:login|verify|verification|captcha|challenge)(?:\/|$)/iu;
const RESTRICTED_PAGE_MARKER = /<(?:html|body|main|section|form|div)\b[^>]*\b(?:id|class|data-[\w-]+)\s*=\s*["'][^"']*(?:captcha(?:[-_ ]?(?:container|challenge))?|verification(?:[-_ ]?page)?|challenge(?:[-_ ]?page)?|security[-_ ]?check)[^"']*["'][^>]*>/iu;

export type DouyinPublicProfileDiscoveryResult =
  | {
      status: "succeeded";
      redirectChain: string[];
      publicProfileUrls: string[];
      rawArtifactHash: string;
      contentHash: string;
    }
  | {
      status: "access_restricted" | "redirect_not_allowed" | "not_found";
      redirectChain: string[];
      publicProfileUrls: [];
    };

export interface AcquisitionDouyinPublicProfileDiscoveryPort {
  discover(input: {
    sourceUrl: string;
    sourceEvidenceId: string;
    signal?: AbortSignal;
  }): Promise<DouyinPublicProfileDiscoveryResult>;
}

export interface AcquisitionDouyinPublicProfileDiscoveryOptions {
  fetchWithRedirectTrace?: (
    policy: ProviderNetworkPolicy,
    rawUrl: string,
    init?: RequestInit
  ) => Promise<ProviderHttpRedirectTrace>;
  hash?: (value: string) => string;
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactAllowedPublicUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && EXACT_DOUYIN_HOSTS.has(url.hostname.toLocaleLowerCase("en-US"));
  } catch {
    return false;
  }
}

function validSourceUrl(value: string) {
  if (!exactAllowedPublicUrl(value)) return false;
  const sourceType = classifyDouyinPublicSource(value)?.sourceType;
  return sourceType === "profile" || sourceType === "video" || sourceType === "short_link";
}

function normalizeProfileUrl(value: string) {
  try {
    const url = new URL(value);
    if (!exactAllowedPublicUrl(url.toString())) return null;
    url.search = "";
    url.hash = "";
    const normalized = normalizeAcquisitionPublicUrl(url.toString());
    return normalized
      && classifyDouyinPublicSource(normalized)?.sourceType === "profile"
      && isVerifiedAcquisitionPublicProfileUrl(normalized)
      ? normalized
      : null;
  } catch {
    return null;
  }
}

function structuredJsonValues(html: string) {
  const documents = [html.trim()];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)) {
    if (/\btype\s*=\s*["']application\/(?:ld\+)?json["']/iu.test(match[1] || "")) {
      documents.push((match[2] || "").trim());
    }
  }
  const values: string[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 30 || values.length >= 1_000) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (["url", "canonical", "profileUrl"].includes(key) && typeof nested === "string") {
        values.push(nested);
      }
      visit(nested, depth + 1);
    }
  };
  for (const document of documents) {
    try {
      visit(JSON.parse(document));
    } catch {
      // The surrounding HTML or malformed structured data is not evidence.
    }
  }
  return values;
}

function explicitPublicUrls(html: string, pageUrl: string) {
  const candidates = new Set<string>();
  const addCandidate = (raw: string) => {
    try {
      const normalized = normalizeProfileUrl(new URL(raw, pageUrl).toString());
      if (normalized) candidates.add(normalized);
    } catch {
      // A malformed explicit URL is not evidence.
    }
  };
  for (const match of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/giu)) {
    addCandidate(match[2] || "");
  }
  for (const raw of structuredJsonValues(html)) {
    addCandidate(raw);
  }
  return [...candidates].sort((left, right) => left.localeCompare(right));
}

function restricted(response: Response, body: string, redirectChain: string[]) {
  return response.status === 401
    || response.status === 403
    || response.status === 429
    || RESTRICTED_PATH.test(new URL(redirectChain.at(-1) || "https://invalid.invalid/").pathname)
    || RESTRICTED_PAGE_MARKER.test(body);
}

export function createAcquisitionDouyinPublicProfileDiscovery(
  options: AcquisitionDouyinPublicProfileDiscoveryOptions = {}
): AcquisitionDouyinPublicProfileDiscoveryPort {
  const fetchWithRedirectTrace = options.fetchWithRedirectTrace
    || fetchProviderHttpWithRedirectTrace;
  const hash = options.hash || sha256;

  return {
    async discover(input) {
      if (!validSourceUrl(input.sourceUrl)) {
        return {
          status: "redirect_not_allowed",
          redirectChain: [],
          publicProfileUrls: []
        };
      }
      let traced: ProviderHttpRedirectTrace;
      try {
        traced = await fetchWithRedirectTrace(
          DOUYIN_PUBLIC_PROFILE_POLICY,
          input.sourceUrl,
          { method: "GET", signal: input.signal }
        );
      } catch (error) {
        if (error instanceof ProviderContractError) {
          return {
            status: "redirect_not_allowed",
            redirectChain: [],
            publicProfileUrls: []
          };
        }
        return {
          status: "access_restricted",
          redirectChain: [],
          publicProfileUrls: []
        };
      }
      const redirectChain = traced.redirectChain;
      if (!redirectChain.every(exactAllowedPublicUrl)) {
        return { status: "redirect_not_allowed", redirectChain, publicProfileUrls: [] };
      }
      const body = await traced.response.text();
      if (restricted(traced.response, body, redirectChain)) {
        return { status: "access_restricted", redirectChain, publicProfileUrls: [] };
      }
      if (traced.response.status === 404) {
        return { status: "not_found", redirectChain, publicProfileUrls: [] };
      }
      if (!traced.response.ok) {
        return { status: "access_restricted", redirectChain, publicProfileUrls: [] };
      }
      const publicProfileUrls = explicitPublicUrls(body, redirectChain.at(-1) || input.sourceUrl);
      if (!publicProfileUrls.length) {
        return { status: "not_found", redirectChain, publicProfileUrls: [] };
      }
      return {
        status: "succeeded",
        redirectChain,
        publicProfileUrls,
        rawArtifactHash: hash(body),
        contentHash: hash(JSON.stringify(publicProfileUrls))
      };
    }
  };
}
