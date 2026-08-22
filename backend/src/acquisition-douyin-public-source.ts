import { isSafeDouyinSearchQuery } from "./acquisition-douyin-discovery-plan.js";

export type DouyinPublicSourceType =
  | "profile"
  | "video"
  | "comment_signal"
  | "short_link"
  | "other";

export interface DouyinPublicSourceClassification {
  sourcePlatform: "douyin";
  sourceType: DouyinPublicSourceType;
}

const INDEXED_COMMENT_SIGNAL =
  /(?:评论区|(?:评论|回复|留言)(?:中|里|称|说|问|写|表示|提到|咨询|[:：]))/u;

export function classifyDouyinPublicSource(
  value: string | URL,
  title = "",
  snippet = ""
): DouyinPublicSourceClassification | null {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password) return null;
  const hostname = url.hostname.replace(/\.$/u, "")
    .toLocaleLowerCase("en-US");
  const isAllowedHost = ["douyin.com", "iesdouyin.com"].some((root) =>
    hostname === root || hostname.endsWith(`.${root}`)
  );
  if (!isAllowedHost) return null;

  const indexedText = `${title}\n${snippet}`.normalize("NFKC");
  if (INDEXED_COMMENT_SIGNAL.test(indexedText)) {
    return { sourcePlatform: "douyin", sourceType: "comment_signal" };
  }
  if (hostname === "v.douyin.com") {
    return { sourcePlatform: "douyin", sourceType: "short_link" };
  }
  if (/^\/user\/[^/]+\/?$/u.test(url.pathname)) {
    return { sourcePlatform: "douyin", sourceType: "profile" };
  }
  if (/^\/(?:video|share\/video)\/[^/]+\/?$/u.test(url.pathname)) {
    return { sourcePlatform: "douyin", sourceType: "video" };
  }
  return { sourcePlatform: "douyin", sourceType: "other" };
}

export function isDouyinBoundPublicSearchQuery(query: string) {
  return isSafeDouyinSearchQuery(query);
}
