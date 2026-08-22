import {
  READER_VERSION,
  canonicalDouyinVideoUrl,
  type VisualObservationSubmission
} from "./protocol";

export interface PixelRect { x: number; y: number; width: number; height: number }

export interface DouyinDomAdapter {
  queryAll(root: Document | Element, selector: string): Element[];
  role(element: Element): string | null;
  accessibleName(element: Element): string;
  innerText(element: Element): string;
  attribute(element: Element, name: string): string | null;
  parent(element: Element): Element | null;
  visible(element: Element): boolean;
  bounds(element: Element): PixelRect;
  textTruncated?(element: Element): boolean;
  viewport(): { width: number; height: number; deviceScaleFactor: number };
  now(): Date;
}

export type ExtractionResult = {
  status: "ok" | "blocked";
  reason: null | "login_required" | "captcha_present" | "security_verification" | "selector_drift";
  observations: VisualObservationSubmission[];
};

const CURRENT_VIDEO_NAMES = new Set(["当前视频"]);
const COMMENT_FEED_NAMES = new Set(["评论", "评论区"]);
const ACTION_NAMES = new Set(["查看评论", "打开评论区", "展开", "展开全文"]);
const BLOCKED_DIALOGS = new Map([
  ["登录抖音", "login_required"],
  ["登录后查看评论", "login_required"],
  ["验证码", "captcha_present"],
  ["安全验证", "security_verification"]
] as const);
type BlockedDialogName = "登录抖音" | "登录后查看评论" | "验证码" | "安全验证";
const PROFILE = /^https:\/\/www\.douyin\.com\/user\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})\/?$/u;
const COMMENT_ID = /^comment-([1-9][0-9]{0,31})$/u;

function ownedByCard(element: Element, card: Element, adapter: DouyinDomAdapter): boolean {
  let current = adapter.parent(element);
  while (current && current !== card) {
    if (adapter.role(current) === "article") return false;
    current = adapter.parent(current);
  }
  return current === card;
}

function firstOwned(
  card: Element,
  selector: string,
  adapter: DouyinDomAdapter
): Element | null {
  return adapter.queryAll(card, selector).find((item) => ownedByCard(item, card, adapter)) ?? null;
}

function countFromName(value: string, label: "点赞" | "回复"): number | null {
  const match = new RegExp(`^${label}\\s+([0-9]{1,10})$`, "u").exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function visibleBounds(bounds: PixelRect, viewport: { width: number; height: number }): boolean {
  return Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
    && bounds.width > 0 && bounds.height > 0
    && bounds.x < viewport.width && bounds.y < viewport.height
    && bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
}

function clampBounds(bounds: PixelRect, viewport: { width: number; height: number }): PixelRect {
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const right = Math.min(viewport.width, bounds.x + bounds.width);
  const bottom = Math.min(viewport.height, bounds.y + bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function digestHex(value: string, byteLength: 16 | 32): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("浏览器缺少安全摘要支持");
  const bytes = new TextEncoder().encode(value);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.slice(0, byteLength), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function profileFromLiteral(value: string | null): { url: string; secUid: string } | null {
  if (!value || /^javascript:/iu.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://www.douyin.com");
  } catch {
    return null;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const canonical = `${parsed.origin}${parsed.pathname}`;
  const match = PROFILE.exec(canonical);
  if (!match) return null;
  return { url: `https://www.douyin.com/user/${match[1]}`, secUid: match[1] };
}

function blockedReason(document: Document, adapter: DouyinDomAdapter): ExtractionResult["reason"] {
  for (const dialog of adapter.queryAll(document, '[role="dialog"]')) {
    if (!adapter.visible(dialog)) continue;
    const reason = BLOCKED_DIALOGS.get(adapter.accessibleName(dialog) as BlockedDialogName);
    if (reason) return reason;
  }
  return null;
}

export async function extractVisibleTopLevelComments(input: {
  document: Document;
  adapter: DouyinDomAdapter;
  sourceUrl: string;
  visualFallback?(input: {
    observation: VisualObservationSubmission;
    domTextState: "missing" | "truncated";
    avatarBounds: PixelRect | null;
    regions: Array<{ kind: "body" | "metadata"; bounds: PixelRect }>;
  }): Promise<VisualObservationSubmission | null>;
}): Promise<ExtractionResult> {
  const source = canonicalDouyinVideoUrl(input.sourceUrl);
  if (!source) throw new Error("抖音视频地址无效");
  const { document, adapter } = input;
  const blocked = blockedReason(document, adapter);
  if (blocked) return { status: "blocked", reason: blocked, observations: [] };

  const videos = adapter.queryAll(document, '[role="region"]')
    .filter((element) => adapter.visible(element)
      && CURRENT_VIDEO_NAMES.has(adapter.accessibleName(element)));
  if (videos.length !== 1) {
    return { status: "blocked", reason: "selector_drift", observations: [] };
  }
  const feeds = adapter.queryAll(videos[0], '[role="feed"]')
    .filter((element) => adapter.visible(element)
      && COMMENT_FEED_NAMES.has(adapter.accessibleName(element)));
  if (feeds.length !== 1) {
    return { status: "blocked", reason: "selector_drift", observations: [] };
  }

  const feed = feeds[0];
  const viewport = adapter.viewport();
  const cards = adapter.queryAll(feed, '[role="article"]')
    .filter((card) => adapter.parent(card) === feed
      && adapter.visible(card)
      && adapter.accessibleName(card) !== "广告"
      && visibleBounds(adapter.bounds(card), viewport));
  const observations: VisualObservationSubmission[] = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const body = firstOwned(card, '[aria-label="评论内容"]', adapter);
    if (!body || !adapter.visible(body)) continue;
    const visibleText = adapter.innerText(body).trim();
    const domTextState = !visibleText
      ? "missing" as const
      : adapter.textTruncated?.(body)
        ? "truncated" as const
        : "complete" as const;
    if ((!visibleText && !input.visualFallback) || visibleText.length > 2_000) continue;
    const author = firstOwned(card, 'a[aria-label="评论作者"]', adapter);
    const displayName = author && adapter.visible(author) ? adapter.innerText(author).trim() || null : null;
    const profile = profileFromLiteral(author ? adapter.attribute(author, "href") : null);
    const time = firstOwned(card, "time", adapter);
    const visibleTimeText = time && adapter.visible(time) ? adapter.innerText(time).trim() || null : null;
    const buttons = adapter.queryAll(card, '[role="button"]')
      .filter((button) => ownedByCard(button, card, adapter) && adapter.visible(button));
    const publicCounterButtons = buttons.filter((button) => {
      const name = adapter.accessibleName(button);
      return countFromName(name, "点赞") !== null || countFromName(name, "回复") !== null;
    });
    const likeCount = publicCounterButtons
      .map((button) => countFromName(adapter.accessibleName(button), "点赞"))
      .find((value) => value !== null) ?? null;
    const replyCount = publicCounterButtons
      .map((button) => countFromName(adapter.accessibleName(button), "回复"))
      .find((value) => value !== null) ?? null;
    const idLiteral = adapter.attribute(card, "id");
    const platformCommentId = idLiteral ? COMMENT_ID.exec(idLiteral)?.[1] ?? null : null;
    const bounds = clampBounds(adapter.bounds(card), viewport);
    const fingerprintMaterial = platformCommentId
      ? `${source.videoId}|${platformCommentId}`
      : JSON.stringify({
          version: 1,
          videoId: source.videoId,
          visibleText: visibleText.normalize("NFC"),
          displayName: displayName?.normalize("NFC") ?? null,
          publicProfileUrl: profile?.url ?? null,
          secUid: profile?.secUid ?? null
        });
    const fieldConfidences: Record<string, number> = { visibleText: 0.99 };
    if (displayName) fieldConfidences.displayName = 0.96;
    if (visibleTimeText) fieldConfidences.visibleTimeText = 0.95;
    if (likeCount !== null) fieldConfidences.likeCount = 0.94;
    if (replyCount !== null) fieldConfidences.replyCount = 0.94;
    if (platformCommentId) fieldConfidences.platformCommentId = 0.98;
    if (profile) {
      fieldConfidences.publicProfileUrl = 0.98;
      fieldConfidences.secUid = 0.98;
    }
    let observation: VisualObservationSubmission = {
      clientObservationKey: `dom:${await digestHex(fingerprintMaterial, platformCommentId ? 16 : 32)}`,
      sourceUrl: source.sourceUrl,
      videoId: source.videoId,
      visibleText,
      domTextHash: visibleText ? `sha256:${await digestHex(visibleText, 32)}` : null,
      ocrTextHash: null,
      displayName,
      visibleTimeText,
      likeCount,
      replyCount,
      platformCommentId,
      publicProfileUrl: profile?.url ?? null,
      secUid: profile?.secUid ?? null,
      extractionMethod: "dom",
      fieldConfidences,
      viewport,
      cardBounds: bounds,
      readerVersion: READER_VERSION,
      capturedAt: adapter.now().toISOString(),
      redactedCrop: null
    };
    if (domTextState !== "complete") {
      if (!input.visualFallback) {
        if (domTextState === "missing") continue;
        observation.fieldConfidences.visibleText = 0.84;
        observations.push(observation);
        continue;
      }
      const avatar = firstOwned(card,
        '[role="img"][aria-label="评论作者头像"], img[aria-label="评论作者头像"]', adapter);
      const avatarBounds = avatar && adapter.visible(avatar)
        && visibleBounds(adapter.bounds(avatar), viewport)
        ? adapter.bounds(avatar)
        : null;
      const regions = [
        { kind: "body" as const, element: body },
        { kind: "metadata" as const, element: time },
        ...publicCounterButtons.map((element) => ({ kind: "metadata" as const, element }))
      ].flatMap(({ kind, element }) => {
        if (!element || !adapter.visible(element)) return [];
        const elementBounds = adapter.bounds(element);
        return visibleBounds(elementBounds, viewport) ? [{ kind, bounds: elementBounds }] : [];
      });
      if (!regions.some((region) => region.kind === "body")) continue;
      const fallback = await input.visualFallback({
        observation,
        domTextState,
        avatarBounds,
        regions
      });
      if (!fallback) continue;
      observation = fallback;
    }
    observations.push(observation);
  }
  return { status: "ok", reason: null, observations };
}

export type ReadOnlyActionSelection =
  | { status: "none" | "ambiguous"; accessibleName: null; element: null }
  | { status: "one"; accessibleName: string; element: Element };

export function findExactReadOnlyAction(
  document: Document,
  adapter: DouyinDomAdapter
): ReadOnlyActionSelection {
  const videos = adapter.queryAll(document, '[role="region"]')
    .filter((element) => adapter.visible(element)
      && CURRENT_VIDEO_NAMES.has(adapter.accessibleName(element)));
  if (videos.length !== 1) return { status: "none", accessibleName: null, element: null };
  const candidates = adapter.queryAll(videos[0], '[role="button"]')
    .filter((button) => adapter.visible(button)
      && ACTION_NAMES.has(adapter.accessibleName(button)));
  if (candidates.length === 0) return { status: "none", accessibleName: null, element: null };
  if (candidates.length > 1) return { status: "ambiguous", accessibleName: null, element: null };
  return {
    status: "one",
    accessibleName: adapter.accessibleName(candidates[0]),
    element: candidates[0]
  };
}
