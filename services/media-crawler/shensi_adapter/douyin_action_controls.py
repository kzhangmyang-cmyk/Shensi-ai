"""Bounded, fail-closed locators for one approved Douyin browser action."""

from __future__ import annotations

import re
import secrets
from collections.abc import Mapping
from datetime import UTC, datetime
from dataclasses import dataclass
from typing import Callable, NamedTuple
from urllib.parse import urlsplit

from .schemas import ActionReconciliationRequest, ActionRequest
from .visual_locator import VisualLocator, VisualLocatorFailure


COMMENT_COMPOSERS = (
    ".public-DraftEditor-content",
    '[contenteditable="true"][aria-label*="评论"]',
    '[contenteditable="true"][data-placeholder*="评论"]',
    'textarea[placeholder*="评论"]',
)
COMMENT_POST_SUBMITS = ('div[data-e2e="comment-post"]',)
COMMENT_SUBMITS = (
    'button:has-text("发送")',
    '[role="button"]:has-text("发送")',
)
COMMENT_COMPOSER_ACTIVATION_CONTAINER = ".comment-input-inner-container"
COMMENT_COMPOSER_ACTIVATION_TEXT = "留下你的精彩评论吧"
DIRECT_MESSAGE_ENTRIES = (
    ('button:has-text("发私信")', "发私信"),
    ('[role="button"]:has-text("发私信")', "发私信"),
    ('span:has-text("发私信")', "发私信"),
    ('button:has-text("私信")', "私信"),
    ('[role="button"]:has-text("私信")', "私信"),
    ('span:has-text("私信")', "私信"),
)
DIRECT_MESSAGE_COMPOSERS = (
    '.DraftEditor-editor [contenteditable="true"]',
    '.DraftEditor-root [contenteditable="true"]',
    '[data-contents="true"] [contenteditable="true"]',
    '[class*="chat-input-"] [contenteditable="true"]',
    '[contenteditable="true"][data-placeholder*="发消息"]',
)
DIRECT_MESSAGE_SUBMITS = (
    ".e2e-send-msg-btn",
    '[class*="chat-btn"]',
)

_FIXTURE_CONTROLS = {
    "comment": ('[data-e2e="comment-input"]', '[data-e2e="comment-submit"]'),
    "direct_message": ('[data-e2e="message-input"]', '[data-e2e="message-submit"]'),
}
_FIXTURE_MESSAGE_ENTRY = '[data-e2e="message-entry"]'
_PAGE_FAILURES = (
    ("#captcha-verify-image", "douyin_verification_required"),
    ("#captcha_container", "douyin_verification_required"),
    ('text="操作频繁，请稍后再试"', "douyin_rate_limited"),
    ('text="请稍后再试"', "douyin_rate_limited"),
    ('text="当前操作存在风险"', "douyin_account_warning"),
    ('iframe[src^="https://passport.douyin.com/login"]', "douyin_login_expired"),
    ('form[action^="https://passport.douyin.com/login"]', "douyin_login_expired"),
    ('[data-e2e="verification"]', "douyin_verification_required"),
    ('[data-e2e="rate-limit"]', "douyin_rate_limited"),
    ('[data-e2e="account-warning"]', "douyin_account_warning"),
    ('[data-e2e="login-required"]', "douyin_login_expired"),
)
_COMMENT_ITEMS = (
    '[data-e2e="comment-item"], .comment-item, [data-comment-id], [data-cid]'
)
_COMMENT_TOOLTIP_IDS = '[id^="tooltip_"]'
_MESSAGE_ITEMS = (
    '[data-direction="outgoing"][data-message-id], '
    '[data-direction="outgoing"][data-msg-id], '
    '[data-message-direction="outgoing"][data-message-id], '
    '[data-message-direction="outgoing"][data-msg-id], '
    '[data-owner="self"][data-message-id], '
    '[data-owner="self"][data-msg-id], '
    '[aria-label="我发送的消息"][data-message-id], '
    '[aria-label="我发送的消息"][data-msg-id]'
)
_EDITOR_DESCENDANTS = '[contenteditable], textarea, input, [role="textbox"]'
_FIXTURE_RECEIPT = '[data-e2e-receipt-id]'
_PLATFORM_ID = re.compile(r"[A-Za-z0-9_-]{1,200}")
_RECIPIENT_ID = re.compile(r"[A-Za-z0-9_-]{1,300}")
_FIXTURE_ID = re.compile(r"[A-Za-z0-9:_-]{1,255}")
_MAX_MATCHES = 100
_BOUND_ACTION_ATTRIBUTE = "data-shensi-bound-action"
_BOUND_COMPOSER_ATTRIBUTE = "data-shensi-bound-composer"

_DIRECT_MESSAGE_RECIPIENT_BINDING_SCRIPT = r"""
(element) => {
  // __shensiDirectMessageRecipientBinding
  const panelSelector = [
    '[data-e2e="message-panel"]',
    '[data-e2e="conversation-panel"]',
    '[class*="chat-area"]',
    '[class*="chatArea"]',
    '[class*="chat-panel"]',
    '[class*="chatPanel"]',
    '[class*="conversation-panel"]',
    '[class*="conversationPanel"]'
  ].join(',');
  const panel = element.closest(panelSelector);
  if (!panel) return { panelFound: false, markers: [] };
  const markerSelector = [
    '[data-e2e="message-recipient"][href]',
    '[data-e2e="message-recipient"][data-sec-uid]',
    '[data-e2e="message-recipient"] a[href]',
    '[class*="chat-header"] a[href*="/user/"]',
    '[class*="chatHeader"] a[href*="/user/"]',
    '[class*="conversation-header"] a[href*="/user/"]',
    '[class*="conversationHeader"] a[href*="/user/"]',
    '[class*="message-header"] a[href*="/user/"]',
    '[class*="messageHeader"] a[href*="/user/"]'
  ].join(',');
  const visible = (candidate) => {
    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return candidate.getAttribute('aria-hidden') !== 'true'
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0
      && rect.width > 0
      && rect.height > 0;
  };
  const markers = Array.from(panel.querySelectorAll(markerSelector))
    .filter(visible)
    .map((marker) => ({
      href: marker.getAttribute('href'),
      secUid: marker.getAttribute('data-sec-uid')
        || marker.closest('[data-sec-uid]')?.getAttribute('data-sec-uid')
        || null
    }));
  return { panelFound: true, markers };
}
"""

_TAG_BOUND_ACTION_CONTROL_SCRIPT = r"""
(element, binding) => {
  // __shensiTagBoundActionControl
  if (!element || !element.isConnected
      || element.hasAttribute(binding.attribute)) return false;
  const visible = (candidate) => {
    if (!candidate || !candidate.isConnected) return false;
    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return candidate.getAttribute('aria-hidden') !== 'true'
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0
      && rect.width > 0
      && rect.height > 0;
  };
  const profileReference = (href) => {
    if (typeof href !== 'string' || !href) return null;
    try {
      const parsed = new URL(href, 'https://www.douyin.com/');
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.douyin.com'
          || (parsed.port !== '' && parsed.port !== '443')
          || parsed.username || parsed.password || parsed.search || parsed.hash) {
        return null;
      }
      const match = parsed.pathname.match(/^\/user\/([A-Za-z0-9_-]{1,300})$/);
      return match ? match[1] : null;
    } catch (_error) {
      return null;
    }
  };
  const panelSelector = [
    '[data-e2e="message-panel"]',
    '[data-e2e="conversation-panel"]',
    '[class*="chat-area"]', '[class*="chatArea"]',
    '[class*="chat-panel"]', '[class*="chatPanel"]',
    '[class*="conversation-panel"]', '[class*="conversationPanel"]'
  ].join(',');
  const markerSelector = [
    '[data-e2e="message-recipient"][href]',
    '[data-e2e="message-recipient"][data-sec-uid]',
    '[data-e2e="message-recipient"] a[href]',
    '[class*="chat-header"] a[href*="/user/"]',
    '[class*="chatHeader"] a[href*="/user/"]',
    '[class*="conversation-header"] a[href*="/user/"]',
    '[class*="conversationHeader"] a[href*="/user/"]',
    '[class*="message-header"] a[href*="/user/"]',
    '[class*="messageHeader"] a[href*="/user/"]'
  ].join(',');
  const failureCode = () => {
    if (!visible(element) || element.disabled
        || element.getAttribute('aria-disabled') === 'true'
        || window.location.href !== binding.targetUrl) {
      return 'douyin_action_control_missing';
    }
    const composers = Array.from(document.querySelectorAll(
      `[${binding.composerAttribute}]`
    )).filter((candidate) =>
      candidate.getAttribute(binding.composerAttribute)
        === binding.composerNonce
    );
    if (composers.length !== 1) {
      return 'douyin_action_content_mismatch';
    }
    const composer = composers[0];
    const tag = composer.tagName.toLowerCase();
    const editable = composer.isContentEditable
      || tag === 'textarea' || tag === 'input';
    const content = tag === 'textarea' || tag === 'input'
      ? composer.value : composer.textContent;
    if (!visible(composer) || !editable || composer.disabled
        || composer.getAttribute('aria-disabled') === 'true'
        || content !== binding.content) {
      return 'douyin_action_content_mismatch';
    }
    const senderLinks = Array.from(document.querySelectorAll([
      'header a[href]', 'nav a[href]', '[role="navigation"] a[href]',
      '[data-e2e="douyin-header"] a[href]', '#douyin-header a[href]'
    ].join(','))).filter(visible);
    const senderReferences = new Set();
    for (const link of senderLinks) {
      const reference = profileReference(link.getAttribute('href'));
      if (reference) senderReferences.add(reference);
    }
    if (senderReferences.size !== 1
        || !senderReferences.has(binding.senderReference)) {
      return 'douyin_account_identity_changed';
    }
    if (binding.kind !== 'direct_message') return null;
    const panel = element.closest(panelSelector);
    if (!visible(panel) || composer.closest(panelSelector) !== panel) {
      return 'douyin_direct_message_unavailable';
    }
    const markers = Array.from(panel.querySelectorAll(markerSelector))
      .filter(visible);
    if (markers.length !== 1) {
      return 'douyin_direct_message_unavailable';
    }
    const marker = markers[0];
    const identities = [];
    const href = marker.getAttribute('href');
    if (href !== null) {
      const reference = profileReference(href);
      if (!reference) return 'douyin_direct_message_unavailable';
      identities.push(reference);
    }
    const secUid = marker.getAttribute('data-sec-uid')
      || marker.closest('[data-sec-uid]')?.getAttribute('data-sec-uid');
    if (secUid !== null && secUid !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,300}$/.test(secUid)) {
        return 'douyin_direct_message_unavailable';
      }
      identities.push(secUid);
    }
    const recipientMatches = identities.length > 0
      && new Set(identities).size === 1
      && identities[0] === binding.recipientReference;
    return recipientMatches ? null : 'douyin_direct_message_unavailable';
  };
  const initialFailure = failureCode();
  if (initialFailure !== null) return initialFailure;
  element.setAttribute(binding.attribute, binding.nonce);
  if (element.getAttribute(binding.attribute) !== binding.nonce) return false;
  element.addEventListener('click', (event) => {
    const failure = failureCode();
    if (failure === null) {
      window[binding.resultKey] = 'allowed';
      return;
    }
    window[binding.resultKey] = failure;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, {capture: true});
  return true;
}
"""

_TAG_BOUND_ACTION_COMPOSER_SCRIPT = r"""
(element, binding) => {
  // __shensiTagBoundActionComposer
  if (!element || !element.isConnected
      || element.hasAttribute(binding.attribute)) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const visible = element.getAttribute('aria-hidden') !== 'true'
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity || '1') > 0
    && rect.width > 0
    && rect.height > 0;
  const tag = element.tagName.toLowerCase();
  const editable = element.isContentEditable
    || tag === 'textarea' || tag === 'input';
  const content = tag === 'textarea' || tag === 'input'
    ? element.value : element.textContent;
  if (!visible || !editable || element.disabled
      || element.getAttribute('aria-disabled') === 'true'
      || content !== binding.content) return false;
  element.setAttribute(binding.attribute, binding.nonce);
  return element.getAttribute(binding.attribute) === binding.nonce;
}
"""

_READ_GUARDED_ACTION_RESULT_SCRIPT = r"""
(key) => Object.prototype.hasOwnProperty.call(window, key)
  ? window[key]
  : null
"""

_DIRECT_MESSAGE_RECEIPT_SNAPSHOT_SCRIPT = r"""
(element, binding) => {
  // __shensiDirectMessageReceiptSnapshot
  const visible = (candidate) => {
    if (!candidate || !candidate.isConnected) return false;
    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    return candidate.getAttribute('aria-hidden') !== 'true'
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || '1') > 0
      && rect.width > 0
      && rect.height > 0;
  };
  const profileReference = (href) => {
    if (typeof href !== 'string' || !href) return null;
    try {
      const parsed = new URL(href, 'https://www.douyin.com/');
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.douyin.com'
          || (parsed.port !== '' && parsed.port !== '443')
          || parsed.username || parsed.password || parsed.search || parsed.hash) {
        return null;
      }
      const match = parsed.pathname.match(/^\/user\/([A-Za-z0-9_-]{1,300})$/);
      return match ? match[1] : null;
    } catch (_error) {
      return null;
    }
  };
  const ambiguous = () => ({ state: 'ambiguous' });
  if (!visible(element)) return { state: 'not_match' };
  if (element.matches('[contenteditable],textarea,input,[role="textbox"]')
      || element.querySelector('[contenteditable],textarea,input,[role="textbox"]')) {
    return { state: 'not_match' };
  }

  const directions = [
    element.getAttribute('data-direction'),
    element.getAttribute('data-message-direction'),
    element.getAttribute('data-owner'),
    element.getAttribute('aria-label')
  ].filter((value) => value !== null)
    .map((value) => value.trim().toLowerCase());
  const outgoing = new Set(['outgoing', 'sent', 'self', '我发送的消息']);
  const incoming = new Set(['incoming', 'received', 'other', '对方发送的消息']);
  const hasOutgoing = directions.some((value) => outgoing.has(value));
  const hasIncoming = directions.some((value) => incoming.has(value));
  if (hasOutgoing && hasIncoming) return ambiguous();
  if (!hasOutgoing) return hasIncoming ? { state: 'not_match' } : ambiguous();

  const textNodes = [element, ...element.querySelectorAll('*')];
  if (!textNodes.some((node) => visible(node)
      && node.textContent === binding.content)) {
    return { state: 'not_match' };
  }

  const panelSelector = [
    '[data-e2e="message-panel"]',
    '[data-e2e="conversation-panel"]',
    '[class*="chat-area"]', '[class*="chatArea"]',
    '[class*="chat-panel"]', '[class*="chatPanel"]',
    '[class*="conversation-panel"]', '[class*="conversationPanel"]'
  ].join(',');
  const panel = element.closest(panelSelector);
  if (!panel) return ambiguous();
  const markerSelector = [
    '[data-e2e="message-recipient"][href]',
    '[data-e2e="message-recipient"][data-sec-uid]',
    '[data-e2e="message-recipient"] a[href]',
    '[class*="chat-header"] a[href*="/user/"]',
    '[class*="chatHeader"] a[href*="/user/"]',
    '[class*="conversation-header"] a[href*="/user/"]',
    '[class*="conversationHeader"] a[href*="/user/"]',
    '[class*="message-header"] a[href*="/user/"]',
    '[class*="messageHeader"] a[href*="/user/"]'
  ].join(',');
  const markers = Array.from(panel.querySelectorAll(markerSelector))
    .filter(visible);
  if (markers.length !== 1) return ambiguous();
  const marker = markers[0];
  const identities = [];
  const href = marker.getAttribute('href');
  if (href !== null) {
    const reference = profileReference(href);
    if (!reference) return ambiguous();
    identities.push(reference);
  }
  const secUid = marker.getAttribute('data-sec-uid')
    || marker.closest('[data-sec-uid]')?.getAttribute('data-sec-uid');
  if (secUid !== null && secUid !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,300}$/.test(secUid)) return ambiguous();
    identities.push(secUid);
  }
  if (identities.length === 0
      || new Set(identities).size !== 1
      || identities[0] !== binding.recipientReference) {
    return ambiguous();
  }

  if (binding.senderReference !== null) {
    const senderLinks = Array.from(document.querySelectorAll([
      'header a[href]', 'nav a[href]', '[role="navigation"] a[href]',
      '[data-e2e="douyin-header"] a[href]', '#douyin-header a[href]'
    ].join(','))).filter(visible);
    const senderReferences = new Set();
    for (const link of senderLinks) {
      const reference = profileReference(link.getAttribute('href'));
      if (reference) senderReferences.add(reference);
    }
    if (senderReferences.size !== 1
        || !senderReferences.has(binding.senderReference)) {
      return ambiguous();
    }
  }

  const rawIds = [
    element.getAttribute('data-message-id'),
    element.getAttribute('data-msg-id')
  ].filter((value) => value !== null);
  if (rawIds.some((value) => !/^[A-Za-z0-9_-]{1,200}$/.test(value))
      || new Set(rawIds).size > 1) {
    return ambiguous();
  }
  const receiptTimes = [
    element.getAttribute('data-created-at'),
    element.getAttribute('data-create-time'),
    element.getAttribute('datetime')
  ].filter((value) => value !== null);
  if (receiptTimes.some((value) => typeof value !== 'string'
      || value.length === 0 || value.length > 100)) {
    return ambiguous();
  }
  return {
    state: 'match',
    platformId: rawIds.length ? rawIds[0] : null,
    receiptTimes
  };
}
"""


class ActionControls(NamedTuple):
    composer: object
    submit: object


@dataclass(frozen=True)
class ReceiptBaseline:
    """Bounded pre-submit identities; never includes comment text or page data."""

    platform_ids: frozenset[str] = frozenset()
    exact_match_count: int = 0
    has_unidentified_match: bool = False


class _CommentMatch(NamedTuple):
    item: object
    platform_id: str | None


class _MessageMatch(NamedTuple):
    item: object
    platform_id: str | None
    observed_at: datetime | None


class ActionControlsFailure(RuntimeError):
    """A closed failure code without page or approved-content text."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class _GuardedActionSubmit:
    """Click one tagged node with a synchronous capture-phase DOM guard."""

    def __init__(self, page: object, locator: object, result_key: str):
        self._page = page
        self._locator = locator
        self._result_key = result_key

    def click(self, **kwargs: object) -> None:
        self._locator.click(**kwargs)  # type: ignore[attr-defined]
        try:
            result = self._page.evaluate(  # type: ignore[attr-defined]
                _READ_GUARDED_ACTION_RESULT_SCRIPT,
                self._result_key,
            )
        except Exception:
            # A valid click may synchronously navigate. The executor still
            # requires an official response or a bound DOM receipt and never
            # retries this uncertain external write.
            return
        if result in {
            "douyin_action_control_missing",
            "douyin_action_content_mismatch",
            "douyin_account_identity_changed",
            "douyin_direct_message_unavailable",
        }:
            raise ActionControlsFailure(result)
        if result != "allowed":
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")


def _evaluate_control(
    control: object,
    expression: str,
    arg: object | None = None,
) -> object:
    """Evaluate on either Locator or ElementHandle without API guesswork."""
    try:
        # Locator exposes ``element_handle`` and accepts a timeout; the pinned
        # ElementHandle intentionally does not. Choose once rather than retry
        # a JavaScript expression after an arbitrary TypeError.
        is_locator = callable(getattr(control, "element_handle", None))
        kwargs = {"timeout": 250} if is_locator else {}
        if arg is None:
            return control.evaluate(  # type: ignore[attr-defined]
                expression, **kwargs,
            )
        return control.evaluate(  # type: ignore[attr-defined]
            expression, arg, **kwargs,
        )
    except Exception as error:
        raise ActionControlsFailure(
            "douyin_action_control_missing"
        ) from error


def pin_action_control(control: object) -> object:
    """Resolve a live Locator once so later actions cannot target a new node."""
    element_handle = getattr(control, "element_handle", None)
    if not callable(element_handle):
        return control
    try:
        pinned = element_handle(timeout=250)
    except Exception as error:
        raise ActionControlsFailure(
            "douyin_action_control_missing"
        ) from error
    if pinned is None:
        raise ActionControlsFailure("douyin_action_control_missing")
    return pinned


def prepare_guarded_action_submit(
    page: object,
    concrete_submit: object,
    *,
    concrete_composer: object,
    approved_content: str,
    kind: str,
    target_public_url: str,
    sender_reference: str,
) -> object:
    """Return one live selector whose guards are re-evaluated at dispatch.

    The concrete editor and submit nodes receive independent one-use random DOM
    tags. The returned locator resolves only the tagged submit; its synchronous
    capture listener rechecks the exact editor/content, URL, sender, and (for
    private messages) recipient panel immediately before platform dispatch.
    """
    if _RECIPIENT_ID.fullmatch(sender_reference) is None:
        raise ActionControlsFailure("douyin_account_identity_changed")
    recipient = _recipient_from_profile_reference(target_public_url)
    if kind == "direct_message" and recipient is None:
        raise ActionControlsFailure("douyin_direct_message_unavailable")
    if kind not in {"comment", "direct_message"}:
        raise ActionControlsFailure("douyin_action_control_missing")

    concrete = pin_action_control(concrete_submit)
    composer = pin_action_control(concrete_composer)
    nonce = secrets.token_urlsafe(24)
    composer_nonce = secrets.token_urlsafe(24)
    result_key = f"__shensi_action_guard_{secrets.token_urlsafe(24)}"
    composer_tagged = _evaluate_control(
        composer,
        _TAG_BOUND_ACTION_COMPOSER_SCRIPT,
        {
            "attribute": _BOUND_COMPOSER_ATTRIBUTE,
            "nonce": composer_nonce,
            "content": approved_content,
        },
    )
    if composer_tagged is not True:
        raise ActionControlsFailure("douyin_action_content_mismatch")
    tagged = _evaluate_control(
        concrete,
        _TAG_BOUND_ACTION_CONTROL_SCRIPT,
        {
            "attribute": _BOUND_ACTION_ATTRIBUTE,
            "nonce": nonce,
            "resultKey": result_key,
            "kind": kind,
            "targetUrl": target_public_url,
            "senderReference": sender_reference,
            "recipientReference": recipient,
            "composerAttribute": _BOUND_COMPOSER_ATTRIBUTE,
            "composerNonce": composer_nonce,
            "content": approved_content,
        },
    )
    if tagged in {
        "douyin_action_control_missing",
        "douyin_action_content_mismatch",
        "douyin_account_identity_changed",
        "douyin_direct_message_unavailable",
    }:
        raise ActionControlsFailure(tagged)
    if tagged is not True:
        raise ActionControlsFailure("douyin_action_control_missing")

    control_marker = f'[{_BOUND_ACTION_ATTRIBUTE}="{nonce}"]:visible'
    try:
        # The random one-use marker alone resolves the exact concrete submit
        # node. Authorization state remains entirely in the synchronous
        # capture listener so drift produces its precise closed failure code
        # instead of causing Playwright selector re-resolution to time out.
        guarded = page.locator(control_marker)  # type: ignore[attr-defined]
        matches = _visible_matches(
            guarded,
            "douyin_action_control_ambiguous",
        )
    except ActionControlsFailure:
        raise
    except Exception as error:
        raise ActionControlsFailure(
            "douyin_action_control_missing"
        ) from error
    if len(matches) != 1:
        raise ActionControlsFailure("douyin_action_control_missing")
    return _GuardedActionSubmit(page, matches[0], result_key)


def _recipient_from_profile_reference(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        target = urlsplit(value)
        port = target.port
    except ValueError:
        return None
    if target.query or target.fragment:
        return None
    if target.scheme or target.netloc:
        if (target.scheme != "https" or target.hostname != "www.douyin.com"
                or port not in {None, 443}
                or target.username is not None
                or target.password is not None):
            return None
    elif not value.startswith("/user/"):
        return None
    match = re.fullmatch(r"/user/([A-Za-z0-9_-]{1,300})", target.path)
    return match.group(1) if match is not None else None


def require_direct_message_recipient_binding(
    control: object,
    target_public_url: str,
) -> None:
    """Prove one control belongs to the frozen recipient conversation.

    The browser script returns only bounded public identifiers. It never reads
    message text, cookies, storage, or profile state. Missing markers may still
    be rendering and are retryable; malformed, ambiguous, or wrong-recipient
    bindings fail closed before a send click.
    """

    expected = _recipient_from_profile_reference(target_public_url)
    if expected is None:
        raise ActionControlsFailure("douyin_direct_message_unavailable")
    try:
        observed = _evaluate_control(
            control,
            _DIRECT_MESSAGE_RECIPIENT_BINDING_SCRIPT,
        )
    except Exception as error:
        raise ActionControlsFailure(
            "douyin_direct_message_unavailable"
        ) from error
    if not isinstance(observed, Mapping):
        raise ActionControlsFailure("douyin_direct_message_unavailable")
    panel_found = observed.get("panelFound")
    markers = observed.get("markers")
    if panel_found is False or markers == []:
        raise ActionControlsFailure("douyin_action_control_missing")
    if panel_found is not True or not isinstance(markers, list):
        raise ActionControlsFailure("douyin_direct_message_unavailable")
    if len(markers) != 1 or len(markers) > _MAX_MATCHES:
        raise ActionControlsFailure("douyin_direct_message_unavailable")
    marker = markers[0]
    if not isinstance(marker, Mapping):
        raise ActionControlsFailure("douyin_direct_message_unavailable")
    identities: list[str] = []
    href = marker.get("href")
    if href is not None:
        recipient = _recipient_from_profile_reference(href)
        if recipient is None:
            raise ActionControlsFailure("douyin_direct_message_unavailable")
        identities.append(recipient)
    sec_uid = marker.get("secUid")
    if sec_uid is not None:
        if (not isinstance(sec_uid, str)
                or _RECIPIENT_ID.fullmatch(sec_uid) is None):
            raise ActionControlsFailure("douyin_direct_message_unavailable")
        identities.append(sec_uid)
    if (not identities or len(set(identities)) != 1
            or identities[0] != expected):
        raise ActionControlsFailure("douyin_direct_message_unavailable")


def _visible_matches(locator: object, ambiguous_code: str, *,
                     require_unique: bool = True) -> list[object]:
    try:
        count = locator.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    if not isinstance(count, int) or count < 0:
        raise ActionControlsFailure("douyin_action_control_missing")
    if count > _MAX_MATCHES:
        raise ActionControlsFailure(ambiguous_code)

    matches: list[object] = []
    for index in range(count):
        try:
            candidate = locator if count == 1 else locator.nth(index)  # type: ignore[attr-defined]
            if candidate.is_visible(timeout=250):  # type: ignore[attr-defined]
                matches.append(candidate)
        except Exception as error:
            raise ActionControlsFailure("douyin_action_control_missing") from error
        if require_unique and len(matches) > 1:
            raise ActionControlsFailure(ambiguous_code)
    return matches


def _is_usable(locator: object, *, editable: bool) -> bool:
    try:
        if not locator.is_enabled(timeout=250):  # type: ignore[attr-defined]
            return False
        return not editable or bool(locator.is_editable(timeout=250))  # type: ignore[attr-defined]
    except Exception:
        return False


def _first_unique(page: object, candidates: tuple[str, ...], *, editable: bool,
                  exact_send_role: bool = False,
                  exact_text: str | None = None) -> object | None:
    try:
        locator = page.locator(", ".join(candidates))  # type: ignore[attr-defined]
        if exact_send_role:
            locator = locator.and_(  # type: ignore[attr-defined]
                page.get_by_role("button", name="发送", exact=True),  # type: ignore[attr-defined]
            )
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    try:
        count = locator.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    if not isinstance(count, int) or count < 0:
        raise ActionControlsFailure("douyin_action_control_missing")
    if count > 1:
        raise ActionControlsFailure("douyin_action_control_ambiguous")
    if count == 0:
        return None
    try:
        visible = locator.is_visible(timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_control_missing") from error
    if not visible or not _is_usable(locator, editable=editable):
        raise ActionControlsFailure("douyin_action_control_missing")
    if exact_text is not None:
        try:
            if locator.text_content(timeout=250) != exact_text:  # type: ignore[attr-defined]
                raise ActionControlsFailure("douyin_action_control_missing")
        except ActionControlsFailure:
            raise
        except Exception as error:
            raise ActionControlsFailure("douyin_action_control_missing") from error
    return locator


def detect_page_failure(page: object) -> str | None:
    try:
        current_url = page.url  # type: ignore[attr-defined]
    except Exception:
        current_url = None
    if isinstance(current_url, str) and re.fullmatch(
        r"https://passport\.douyin\.com/(?:login|sso/login)(?:[/?#].*)?",
        current_url,
    ):
        return "douyin_login_expired"
    try:
        title = page.title()  # type: ignore[attr-defined]
    except Exception:
        title = None
    if isinstance(title, str) and "验证码中间页" in title:
        return "douyin_verification_required"
    for selector, code in _PAGE_FAILURES:
        try:
            matches = _visible_matches(
                page.locator(selector),  # type: ignore[attr-defined]
                "douyin_action_control_ambiguous",
            )
        except ActionControlsFailure:
            return "douyin_action_control_missing"
        if matches:
            return code
    return None


def open_direct_message_panel(
    page: object,
    *,
    visual_locator: VisualLocator | None = None,
    deadline_at: datetime | None = None,
    before_visual_click: Callable[[], int] | None = None,
) -> None:
    actionable_selectors = tuple(
        selector for selector, _ in DIRECT_MESSAGE_ENTRIES
        if not selector.startswith("span")
    )
    fallback_selectors = tuple(
        selector for selector, _ in DIRECT_MESSAGE_ENTRIES
        if selector.startswith("span")
    )
    entry = _first_unique(page, actionable_selectors, editable=False)
    if entry is None:
        entry = _first_unique(page, fallback_selectors, editable=False)
    if entry is not None:
        try:
            entry = pin_action_control(entry)
            raw_label = entry.text_content()  # type: ignore[attr-defined]
            normalized_label = (
                "".join(raw_label.split())
                if isinstance(raw_label, str) else None
            )
            if normalized_label not in {"发私信", "私信"}:
                raise ActionControlsFailure("douyin_direct_message_unavailable")
            entry.click(timeout=5_000)  # type: ignore[attr-defined]
        except ActionControlsFailure:
            raise
        except Exception as error:
            raise ActionControlsFailure(
                "douyin_direct_message_unavailable"
            ) from error
        return
    fixture_entry = _first_unique(
        page,
        (_FIXTURE_MESSAGE_ENTRY,),
        editable=False,
    )
    if fixture_entry is not None:
        try:
            fixture_entry = pin_action_control(fixture_entry)
            fixture_entry.click(timeout=5_000)  # type: ignore[attr-defined]
        except Exception as error:
            raise ActionControlsFailure(
                "douyin_direct_message_unavailable"
            ) from error
        return
    if visual_locator is not None and deadline_at is not None:
        try:
            entry = visual_locator.locate_control(
                page,
                purpose="direct_message_entry",
                deadline_at=deadline_at,
            )
        except VisualLocatorFailure as error:
            code = (
                "douyin_direct_message_unavailable"
                if error.code == "douyin_action_control_missing"
                else error.code
            )
            raise ActionControlsFailure(code) from None
        except Exception:
            raise ActionControlsFailure(
                "douyin_direct_message_unavailable"
            ) from None
        if before_visual_click is None:
            raise ActionControlsFailure("douyin_direct_message_unavailable")
        click_timeout_ms = before_visual_click()
        try:
            entry = pin_action_control(entry)
            entry.click(timeout=click_timeout_ms)  # type: ignore[attr-defined]
        except Exception:
            raise ActionControlsFailure(
                "douyin_direct_message_unavailable"
            ) from None
        return
    raise ActionControlsFailure("douyin_direct_message_unavailable")


def locate_action_composer(page: object, kind: str) -> object:
    if kind == "comment":
        composer = _first_unique(page, COMMENT_COMPOSERS, editable=True)
    elif kind == "direct_message":
        composer = _first_unique(
            page,
            DIRECT_MESSAGE_COMPOSERS,
            editable=True,
        )
    else:
        raise ActionControlsFailure("douyin_action_control_missing")

    fixture_composer, _fixture_submit = _FIXTURE_CONTROLS[kind]
    if composer is None:
        composer = _first_unique(page, (fixture_composer,), editable=True)
    if composer is None:
        raise ActionControlsFailure("douyin_action_control_missing")
    return composer


def open_comment_composer(
    page: object,
    *,
    before_click: Callable[[], int],
) -> None:
    """Activate Douyin's lazy-mounted comment editor without publishing."""
    try:
        locate_action_composer(page, "comment")
        return
    except ActionControlsFailure as error:
        if error.code != "douyin_action_control_missing":
            raise

    try:
        activation_containers = _visible_matches(
            page.locator(  # type: ignore[attr-defined]
                COMMENT_COMPOSER_ACTIVATION_CONTAINER
            ),
            "douyin_action_control_ambiguous",
        )
        if len(activation_containers) != 1:
            raise ActionControlsFailure("douyin_action_control_missing")
        entries = _visible_matches(
            activation_containers[0].get_by_text(  # type: ignore[attr-defined]
                COMMENT_COMPOSER_ACTIVATION_TEXT,
                exact=True,
            ),
            "douyin_action_control_ambiguous",
        )
        if len(entries) != 1 or not _is_usable(entries[0], editable=False):
            raise ActionControlsFailure("douyin_action_control_missing")
        entry = pin_action_control(entries[0])
    except ActionControlsFailure:
        raise
    except Exception as error:
        raise ActionControlsFailure(
            "douyin_action_control_missing"
        ) from error

    click_timeout_ms = before_click()
    if type(click_timeout_ms) is not int or click_timeout_ms < 1:
        raise ActionControlsFailure("douyin_action_control_missing")
    try:
        still_bound = _evaluate_control(
            entry,
            """
            (element, expected) => {
              const normalized = (value) =>
                String(value || '').replace(/\\s+/g, ' ').trim();
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const visible = element.isConnected
                && rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && style.opacity !== '0'
                && element.getAttribute('aria-hidden') !== 'true';
              const disabled = element.matches(':disabled')
                || element.getAttribute('aria-disabled') === 'true';
              return visible
                && !disabled
                && element.closest(expected.container) !== null
                && normalized(element.textContent) === expected.text;
            }
            """,
            {
                "container": COMMENT_COMPOSER_ACTIVATION_CONTAINER,
                "text": COMMENT_COMPOSER_ACTIVATION_TEXT,
            },
        )
        if still_bound is not True:
            raise ActionControlsFailure("douyin_action_control_missing")
        entry.click(timeout=click_timeout_ms)  # type: ignore[attr-defined]
    except ActionControlsFailure:
        raise
    except Exception as error:
        raise ActionControlsFailure(
            "douyin_action_control_missing"
        ) from error


def locate_action_submit(page: object, kind: str) -> object:
    if kind == "comment":
        submit = _first_unique(page, COMMENT_POST_SUBMITS, editable=False)
        if submit is None:
            submit = _first_unique(
                page, COMMENT_SUBMITS, editable=False, exact_send_role=True,
                exact_text="发送",
            )
    elif kind == "direct_message":
        submit = _first_unique(
            page,
            DIRECT_MESSAGE_SUBMITS,
            editable=False,
            exact_text="发送",
        )
    else:
        raise ActionControlsFailure("douyin_action_control_missing")

    _fixture_composer, fixture_submit = _FIXTURE_CONTROLS[kind]
    if submit is None:
        submit = _first_unique(page, (fixture_submit,), editable=False)
    if submit is None:
        raise ActionControlsFailure("douyin_action_control_missing")
    return submit


def locate_action_controls(page: object, kind: str) -> ActionControls:
    composer = locate_action_composer(page, kind)
    submit = locate_action_submit(page, kind)
    return ActionControls(composer=composer, submit=submit)


def read_composer_content(composer: object) -> str | None:
    try:
        value = composer.input_value(timeout=250)  # type: ignore[attr-defined]
    except Exception:
        try:
            if callable(getattr(composer, "element_handle", None)):
                value = composer.text_content(timeout=250)  # type: ignore[attr-defined]
            else:
                value = composer.text_content()  # type: ignore[attr-defined]
        except Exception:
            return None
    return value if isinstance(value, str) else None


def type_action_content(
    composer: object,
    content: str,
    *,
    delay: int,
    timeout: int,
) -> None:
    """Type through either a live Locator or a pinned ElementHandle."""
    sequential = getattr(composer, "press_sequentially", None)
    if callable(sequential):
        sequential(content, delay=delay, timeout=timeout)
        return
    native_type = getattr(composer, "type", None)
    if not callable(native_type):
        raise ActionControlsFailure("douyin_action_control_missing")
    native_type(content, delay=delay, timeout=timeout)


def _receipt_attribute(item: object, name: str) -> str | None:
    try:
        value = item.get_attribute(name, timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if value is not None and not isinstance(value, str):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return value


def _platform_id(item: object, attributes: tuple[str, ...]) -> str | None:
    values: list[str] = []
    for attribute in attributes:
        value = _receipt_attribute(item, attribute)
        if value is None:
            continue
        if _PLATFORM_ID.fullmatch(value) is None:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        values.append(value)
    if len(set(values)) > 1:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return values[0] if values else None


def _comment_platform_id(item: object) -> str | None:
    attribute_id = _platform_id(item, ("data-comment-id", "data-cid"))
    try:
        anchors = item.locator(_COMMENT_TOOLTIP_IDS)  # type: ignore[attr-defined]
        count = anchors.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if not isinstance(count, int) or count < 0 or count > 1:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    tooltip_id = None
    if count == 1:
        try:
            anchor = anchors
            raw_id = anchor.get_attribute("id", timeout=250)  # type: ignore[attr-defined]
        except Exception as error:
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from error
        if (not isinstance(raw_id, str)
                or not raw_id.startswith("tooltip_")
                or _PLATFORM_ID.fullmatch(raw_id[8:]) is None):
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        tooltip_id = raw_id[8:]
    if (attribute_id is not None and tooltip_id is not None
            and attribute_id != tooltip_id):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return attribute_id or tooltip_id


def _is_editor(item: object) -> bool:
    contenteditable = _receipt_attribute(item, "contenteditable")
    if (contenteditable is not None
            and contenteditable.strip().lower() != "false"):
        return True
    role = _receipt_attribute(item, "role")
    if isinstance(role, str) and role.strip().lower() == "textbox":
        return True
    try:
        descendants = item.locator(_EDITOR_DESCENDANTS)  # type: ignore[attr-defined]
        descendant_count = descendants.count()  # type: ignore[attr-defined]
        editable = item.is_editable(timeout=250)  # type: ignore[attr-defined]
        textboxes = item.get_by_role("textbox")  # type: ignore[attr-defined]
        textbox_count = textboxes.count()  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if not isinstance(descendant_count, int) or descendant_count < 0:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if (not isinstance(textbox_count, int) or textbox_count < 0
            or descendant_count > _MAX_MATCHES
            or textbox_count > _MAX_MATCHES):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return descendant_count > 0 or textbox_count > 0 or bool(editable)


def _match_comment_item(item: object, request: ActionRequest) -> _CommentMatch | None:
    try:
        if not item.is_visible(timeout=250):  # type: ignore[attr-defined]
            return None
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if _is_editor(item):
        return None
    try:
        text_locator = item.get_by_text(  # type: ignore[attr-defined]
            request.content, exact=True,
        )
        text_matches = _visible_matches(
            text_locator,
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure:
        raise
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    exact = False
    for text_match in text_matches:
        try:
            if text_match.text_content(timeout=250) == request.content:  # type: ignore[attr-defined]
                exact = True
        except Exception as error:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    if not exact:
        return None
    return _CommentMatch(
        item=item,
        platform_id=_comment_platform_id(item),
    )


def _match_message_item(
    item: object,
    request: ActionRequest,
    *,
    sender_reference: str | None = None,
) -> _MessageMatch | None:
    recipient = _recipient_from_profile_reference(
        str(request.target_public_url)
    )
    if recipient is None:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if (sender_reference is not None
            and _RECIPIENT_ID.fullmatch(sender_reference) is None):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    try:
        snapshot = _evaluate_control(
            item,
            _DIRECT_MESSAGE_RECEIPT_SNAPSHOT_SCRIPT,
            {
                "content": request.content,
                "recipientReference": recipient,
                "senderReference": sender_reference,
            },
        )
    except ActionControlsFailure as error:
        raise ActionControlsFailure(
            "douyin_action_receipt_ambiguous"
        ) from error
    if not isinstance(snapshot, Mapping):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    state = snapshot.get("state")
    if state == "not_match":
        return None
    if state != "match" or set(snapshot) != {
        "state", "platformId", "receiptTimes",
    }:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    platform_id = snapshot.get("platformId")
    if (platform_id is not None
            and (not isinstance(platform_id, str)
                 or _PLATFORM_ID.fullmatch(platform_id) is None)):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    raw_times = snapshot.get("receiptTimes")
    if (not isinstance(raw_times, list) or len(raw_times) > 3
            or any(not isinstance(value, str) for value in raw_times)):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return _MessageMatch(
        item=item,
        platform_id=platform_id,
        observed_at=_parse_receipt_times(raw_times),
    )


def _matching_comment_items(page: object, request: ActionRequest) -> list[_CommentMatch]:
    try:
        candidates = _visible_matches(
            page.locator(_COMMENT_ITEMS),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure as error:
        if error.code == "douyin_action_control_missing":
            raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
        raise
    matches = []
    for item in candidates:
        match = _match_comment_item(item, request)
        if match is not None:
            matches.append(match)
    return matches


def _matching_message_items(
    page: object,
    request: ActionRequest,
    *,
    sender_reference: str | None = None,
) -> list[_MessageMatch]:
    try:
        candidates = _visible_matches(
            page.locator(_MESSAGE_ITEMS),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
            require_unique=False,
        )
    except ActionControlsFailure as error:
        if error.code == "douyin_action_control_missing":
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from error
        raise
    matches = []
    for item in candidates:
        try:
            concrete = pin_action_control(item)
        except ActionControlsFailure as error:
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from error
        match = _match_message_item(
            concrete,
            request,
            sender_reference=sender_reference,
        )
        if match is not None:
            matches.append(match)
    return matches


def capture_receipt_baseline(
    page: object,
    request: ActionRequest,
    *,
    sender_reference: str | None = None,
) -> ReceiptBaseline:
    if request.kind == "comment":
        matches = _matching_comment_items(page, request)
    elif request.kind == "direct_message":
        matches = _matching_message_items(
            page,
            request,
            sender_reference=sender_reference,
        )
    else:
        return ReceiptBaseline()
    platform_ids = [match.platform_id for match in matches
                    if match.platform_id is not None]
    if len(platform_ids) != len(set(platform_ids)):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return ReceiptBaseline(
        platform_ids=frozenset(platform_ids),
        exact_match_count=len(matches),
        has_unidentified_match=any(
            match.platform_id is None for match in matches
        ),
    )


def find_visible_receipt(
    page: object,
    request: ActionRequest,
    baseline: ReceiptBaseline,
    *,
    sender_reference: str | None = None,
) -> str | None:
    if request.kind == "comment":
        matches = _matching_comment_items(page, request)
        if baseline.has_unidentified_match:
            new_platform_ids = [
                match for match in matches
                if (match.platform_id is not None
                    and match.platform_id not in baseline.platform_ids)
            ]
            if new_platform_ids:
                raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        eligible = [
            match for match in matches
            if (match.platform_id is not None
                and match.platform_id not in baseline.platform_ids)
        ]
        if len(eligible) > 1:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        if eligible:
            match = eligible[0]
            if not _comment_is_self_owned(match.item):
                return None
            revalidated = _match_comment_item(match.item, request)
            if (revalidated is None
                    or revalidated.platform_id != match.platform_id
                    or not _comment_is_self_owned(revalidated.item)):
                raise ActionControlsFailure("douyin_action_receipt_ambiguous")
            return f"douyin-comment:{revalidated.platform_id}"
    elif request.kind == "direct_message":
        matches = _matching_message_items(
            page,
            request,
            sender_reference=sender_reference,
        )
        if baseline.has_unidentified_match:
            new_platform_ids = [
                match for match in matches
                if (match.platform_id is not None
                    and match.platform_id not in baseline.platform_ids)
            ]
            if new_platform_ids:
                raise ActionControlsFailure(
                    "douyin_action_receipt_ambiguous"
                )
        eligible = [
            match for match in matches
            if (
                match.platform_id is not None
                and match.platform_id not in baseline.platform_ids
            ) or (
                match.platform_id is None
                and baseline.exact_match_count == 0
            )
        ]
        if len(eligible) > 1:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        if eligible:
            match = eligible[0]
            revalidated = _match_message_item(
                match.item,
                request,
                sender_reference=sender_reference,
            )
            if (revalidated is None
                    or revalidated.platform_id != match.platform_id):
                raise ActionControlsFailure(
                    "douyin_action_receipt_ambiguous"
                )
            if revalidated.platform_id is not None:
                return f"douyin-message:{revalidated.platform_id}"
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")

        return None

    try:
        fixture = _visible_matches(
            page.locator(_FIXTURE_RECEIPT),  # type: ignore[attr-defined]
            "douyin_action_receipt_ambiguous",
        )
    except ActionControlsFailure as error:
        if error.code == "douyin_action_control_missing":
            raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
        raise
    if not fixture:
        return None
    try:
        value = fixture[0].get_attribute("data-e2e-receipt-id", timeout=250)  # type: ignore[attr-defined]
    except Exception as error:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous") from error
    return value if isinstance(value, str) and _FIXTURE_ID.fullmatch(value) else None


def _comment_is_self_owned(item: object) -> bool:
    markers = {
        _receipt_attribute(item, "data-direction"),
        _receipt_attribute(item, "data-owner"),
        _receipt_attribute(item, "aria-label"),
    }
    markers.discard(None)
    normalized = {
        marker.strip().lower()
        for marker in markers
        if isinstance(marker, str)
    }
    positive = {"outgoing", "self", "true", "我的评论"}
    negative = {"incoming", "other", "false", "他人的评论"}
    if normalized & positive:
        if normalized & negative:
            raise ActionControlsFailure("douyin_action_receipt_ambiguous")
        return True
    if normalized & negative:
        return False
    return False


def _receipt_time(item: object) -> datetime | None:
    raw_values = [
        _receipt_attribute(item, "data-created-at"),
        _receipt_attribute(item, "data-create-time"),
        _receipt_attribute(item, "datetime"),
    ]
    values = [value for value in raw_values if value is not None]
    return _parse_receipt_times(values)


def _parse_receipt_times(values: list[str]) -> datetime | None:
    if not values:
        return None
    parsed: list[datetime] = []
    for value in values:
        try:
            if re.fullmatch(r"[0-9]{10,13}", value):
                raw = int(value)
                seconds = raw / 1_000 if len(value) == 13 else raw
                timestamp = datetime.fromtimestamp(seconds, UTC)
            else:
                timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    raise ValueError("naive timestamp")
                timestamp = timestamp.astimezone(UTC)
        except (OverflowError, ValueError):
            raise ActionControlsFailure(
                "douyin_action_receipt_ambiguous"
            ) from None
        parsed.append(timestamp)
    if len(set(parsed)) != 1:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return parsed[0]


def find_existing_outgoing_receipt(
    page: object,
    request: ActionReconciliationRequest,
    *,
    sender_reference: str | None = None,
) -> str | None:
    """Find one already-present, stable, self-owned receipt without writing.

    This deliberately has no synthetic-reference or fixture fallback.  A
    post-timeout reconciliation is allowed to succeed only when the current
    account's outgoing item is uniquely identifiable by a platform DOM ID.
    """
    if request.kind == "comment":
        eligible = [
            match for match in _matching_comment_items(page, request)
            if _comment_is_self_owned(match.item)
        ]
        prefix = "douyin-comment:"
        rematch = _match_comment_item
    elif request.kind == "direct_message":
        eligible = _matching_message_items(
            page,
            request,
            sender_reference=sender_reference,
        )
        prefix = "douyin-message:"
        rematch = None
    else:
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if len(eligible) != 1 or eligible[0].platform_id is None:
        return None
    match = eligible[0]
    observed_at = (
        match.observed_at
        if request.kind == "direct_message"
        else _receipt_time(match.item)
    )
    not_before = request.not_before.astimezone(UTC)
    if observed_at is None or observed_at < not_before:
        return None
    revalidated = (
        _match_message_item(
            match.item,
            request,
            sender_reference=sender_reference,
        )
        if request.kind == "direct_message"
        else rematch(match.item, request)
    )
    if (revalidated is None
            or revalidated.platform_id != match.platform_id):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    if request.kind == "comment" and not _comment_is_self_owned(match.item):
        raise ActionControlsFailure("douyin_action_receipt_ambiguous")
    return f"{prefix}{match.platform_id}"
