"""Focused DouYin_Spider adapter for one approved text direct message.

Browser credentials remain inside the MediaCrawler sidecar.  This module reads
the authenticated persistent context only at execution time, binds the public
profile URL to the API-resolved recipient, and returns a sanitized receipt.
"""

from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import json
import re
from typing import Callable, Mapping, NamedTuple, Protocol
from urllib.parse import urlsplit
import uuid

from .douyin_actions import DouyinActionFailure
from .schemas import ActionReceipt, ActionRequest


_KEY_STORAGE = "security-sdk/s_sdk_crypt_sdk"
_WEB_PROTECT_STORAGE = "security-sdk/s_sdk_sign_data_key/web_protect"
_SERVER_CERT_STORAGE = "security-sdk/s_sdk_server_cert_key"
_STORAGE_KEYS = (_KEY_STORAGE, _WEB_PROTECT_STORAGE, _SERVER_CERT_STORAGE)
_TARGET_SEC_UID = re.compile(r"[A-Za-z0-9_-]{1,300}")
_RECIPIENT_UID = re.compile(r"[0-9]{1,32}")
_LOGIN_COOKIE_NAMES = frozenset({
    "sessionid",
    "sessionid_ss",
    "sid_tt",
})


class _Bindings(Protocol):
    def authenticate(
        self,
        *,
        cookie_header: str,
        key_storage: str,
        web_protect_storage: str,
        server_cert_storage: str | None,
        browser_fingerprint: Mapping[str, object],
    ) -> object: ...

    def resolve_recipient(
        self, auth: object, target_url: str,
    ) -> Mapping[str, object]: ...

    def create_conversation(
        self, auth: object, recipient_uid: str,
    ) -> tuple[str, int, str]: ...

    def send_text(
        self,
        auth: object,
        *,
        conversation_id: str,
        conversation_short_id: int,
        ticket: str,
        content: str,
        client_message_id: str,
    ) -> bool: ...


def _closed_unavailable() -> DouyinActionFailure:
    return DouyinActionFailure("douyin_direct_message_unavailable")


class _BrowserCredentials(NamedTuple):
    cookie_header: str
    key_storage: str
    web_protect_storage: str
    server_cert_storage: str | None
    fingerprint: Mapping[str, object]


def _bounded_dimension(value: object) -> int:
    if type(value) is not int or not 1 <= value <= 16_384:
        raise _closed_unavailable()
    return value


def _browser_fingerprint(raw: object) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise _closed_unavailable()
    user_agent = raw.get("userAgent")
    platform = raw.get("platform")
    language = raw.get("language")
    screen = raw.get("screen")
    viewport = raw.get("viewport")
    if (not isinstance(user_agent, str) or not 20 <= len(user_agent) <= 1_000
            or "Chrome/" not in user_agent
            or not isinstance(platform, str) or not 1 <= len(platform) <= 100
            or not isinstance(language, str)
            or re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?", language)
            is None
            or not isinstance(screen, Mapping)
            or not isinstance(viewport, Mapping)):
        raise _closed_unavailable()
    safe_screen = {
        "width": _bounded_dimension(screen.get("width")),
        "height": _bounded_dimension(screen.get("height")),
    }
    safe_viewport = {
        key: _bounded_dimension(viewport.get(key))
        for key in (
            "innerWidth",
            "innerHeight",
            "outerWidth",
            "outerHeight",
            "availWidth",
            "availHeight",
        )
    }
    hardware_concurrency = raw.get("hardwareConcurrency")
    if (type(hardware_concurrency) is not int
            or not 1 <= hardware_concurrency <= 512):
        raise _closed_unavailable()
    device_memory = raw.get("deviceMemory")
    if (not isinstance(device_memory, (int, float))
            or isinstance(device_memory, bool)
            or not 0.25 <= float(device_memory) <= 1_024):
        raise _closed_unavailable()
    safe: dict[str, object] = {
        "userAgent": user_agent,
        "platform": platform,
        "language": language,
        "screen": safe_screen,
        "viewport": safe_viewport,
        "hardwareConcurrency": hardware_concurrency,
        "deviceMemory": device_memory,
    }
    ua_data = raw.get("uaData")
    if isinstance(ua_data, Mapping):
        ua_platform = ua_data.get("platform")
        brands = ua_data.get("brands")
        safe_brands: list[dict[str, str]] = []
        if isinstance(brands, list):
            for brand in brands[:8]:
                if not isinstance(brand, Mapping):
                    continue
                name, version = brand.get("brand"), brand.get("version")
                if (isinstance(name, str)
                        and re.fullmatch(r"[A-Za-z0-9 _.?=-]{1,64}", name)
                        and isinstance(version, str)
                        and re.fullmatch(r"[0-9.]{1,20}", version)):
                    safe_brands.append({"brand": name, "version": version})
        safe["uaData"] = {
            "platform": (
                ua_platform
                if isinstance(ua_platform, str)
                and re.fullmatch(r"[A-Za-z0-9 _.-]{1,40}", ua_platform)
                else platform
            ),
            "brands": safe_brands,
        }
    for key in ("webglVendor", "webglRenderer"):
        value = raw.get(key)
        if isinstance(value, str) and 1 <= len(value) <= 500:
            safe[key] = value
    return safe


def _browser_credentials(
    context: object,
    page: object,
) -> _BrowserCredentials:
    try:
        raw_cookies = context.cookies(["https://www.douyin.com/"])  # type: ignore[attr-defined]
        storage = page.evaluate(  # type: ignore[attr-defined]
            "keys => Object.fromEntries(keys.map(key => "
            "[key, window.localStorage.getItem(key)]))",
            list(_STORAGE_KEYS),
        )
        raw_fingerprint = page.evaluate(  # type: ignore[attr-defined]
            """() => {
              let webglVendor = null;
              let webglRenderer = null;
              try {
                const gl = document.createElement('canvas').getContext('webgl');
                const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
                if (gl && debug) {
                  webglVendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
                  webglRenderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
                }
              } catch (_) {}
              return {
                userAgent: navigator.userAgent,
                platform: navigator.platform,
                language: navigator.language,
                screen: { width: screen.width, height: screen.height },
                viewport: {
                  innerWidth: window.innerWidth,
                  innerHeight: window.innerHeight,
                  outerWidth: window.outerWidth || screen.width,
                  outerHeight: window.outerHeight || screen.height,
                  availWidth: screen.availWidth,
                  availHeight: screen.availHeight,
                },
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory || 8,
                uaData: navigator.userAgentData?.toJSON?.() || null,
                webglVendor,
                webglRenderer,
              };
            }"""
        )
    except Exception:
        raise _closed_unavailable() from None
    if not isinstance(raw_cookies, list) or not isinstance(storage, Mapping):
        raise _closed_unavailable()
    cookie_pairs: list[tuple[str, str]] = []
    for item in raw_cookies:
        if not isinstance(item, Mapping):
            raise _closed_unavailable()
        name, value = item.get("name"), item.get("value")
        # Chromium may retain a nameless cookie alongside a valid login. It
        # cannot form a named Cookie header pair; leave the profile untouched.
        if name == "" and isinstance(value, str):
            continue
        if (not isinstance(name, str) or not name
                or not isinstance(value, str)
                or any(character in name for character in ";=\r\n")
                or any(character in value for character in ";\r\n")):
            raise _closed_unavailable()
        cookie_pairs.append((name, value))
    if not any(
        name in _LOGIN_COOKIE_NAMES and bool(value)
        for name, value in cookie_pairs
    ):
        raise _closed_unavailable()
    key_storage = storage.get(_KEY_STORAGE)
    web_protect_storage = storage.get(_WEB_PROTECT_STORAGE)
    server_cert_storage = storage.get(_SERVER_CERT_STORAGE)
    if (not isinstance(key_storage, str) or not key_storage
            or not isinstance(web_protect_storage, str)
            or not web_protect_storage
            or (server_cert_storage is not None
                and not isinstance(server_cert_storage, str))):
        raise _closed_unavailable()
    return _BrowserCredentials(
        cookie_header=(
            "; ".join(f"{name}={value}" for name, value in cookie_pairs)
        ),
        key_storage=key_storage,
        web_protect_storage=web_protect_storage,
        server_cert_storage=server_cert_storage,
        fingerprint=_browser_fingerprint(raw_fingerprint),
    )


def _target_sec_uid(target_url: str) -> str:
    target = urlsplit(target_url)
    match = re.fullmatch(r"/user/([A-Za-z0-9_-]{1,300})", target.path)
    if (target.scheme != "https" or target.hostname != "www.douyin.com"
            or target.port not in {None, 443}
            or target.username is not None or target.password is not None
            or target.query or target.fragment or match is None):
        raise DouyinActionFailure("action_rejected")
    return match.group(1)


def _client_message_id(action_id: str) -> str:
    return str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"https://shensi.local/douyin/direct-message/{action_id}",
    ))


class _DouyinSpiderBindings:
    """Late-bound imports keep the upstream adapter isolated from unit tests."""

    def __init__(self) -> None:
        try:
            from .vendor.douyin_spider.utils import fingerprint
        except Exception:
            raise _closed_unavailable() from None
        self._fingerprint = fingerprint

    def _configure_browser_fingerprint(
        self,
        browser_fingerprint: Mapping[str, object],
    ) -> Mapping[str, object]:
        user_agent = str(browser_fingerprint["userAgent"])
        version_match = re.search(r"Chrome/([0-9.]+)", user_agent)
        if version_match is None:
            raise _closed_unavailable()
        browser_version = version_match.group(1)
        screen = browser_fingerprint["screen"]
        viewport = browser_fingerprint["viewport"]
        if not isinstance(screen, Mapping) or not isinstance(viewport, Mapping):
            raise _closed_unavailable()
        platform = str(browser_fingerprint["platform"])
        ua_data = browser_fingerprint.get("uaData")
        ua_platform = platform
        brands: object = None
        if isinstance(ua_data, Mapping):
            ua_platform = str(ua_data.get("platform") or platform)
            brands = ua_data.get("brands")
        sec_ch_brands: list[str] = []
        if isinstance(brands, list):
            for brand in brands:
                if isinstance(brand, Mapping):
                    name, version = brand.get("brand"), brand.get("version")
                    if isinstance(name, str) and isinstance(version, str):
                        sec_ch_brands.append(f'"{name}";v="{version}"')
        major = browser_version.split(".", 1)[0]
        sec_ch_ua = ", ".join(sec_ch_brands) or (
            f'"Not=A?Brand";v="99", "Google Chrome";v="{major}", '
            f'"Chromium";v="{major}"'
        )
        if "Win" in platform or "Windows" in user_agent:
            os_name, os_version = "Windows", "10"
        elif "Mac" in platform or "Macintosh" in user_agent:
            os_name, os_version = "Mac OS", "10.15"
        else:
            os_name, os_version = "Linux", ""
        language = str(browser_fingerprint["language"])
        language_root = language.split("-", 1)[0]
        profile = dict(self._fingerprint.get_profile())
        profile.update({
            "ua": user_agent,
            "sec_ch_ua": sec_ch_ua,
            "sec_ch_ua_platform": json.dumps(
                ua_platform,
                ensure_ascii=True,
            ),
            "browser_name": "Chrome",
            "browser_version": browser_version,
            "engine_name": "Blink",
            "engine_version": browser_version,
            "os_name": os_name,
            "os_version": os_version,
            "platform": platform,
            "cpu_core_num": str(browser_fingerprint["hardwareConcurrency"]),
            "device_memory": str(browser_fingerprint["deviceMemory"]),
            "screen_width": str(screen["width"]),
            "screen_height": str(screen["height"]),
            "accept_language": f"{language},{language_root};q=0.9",
            "geo": (
                viewport["innerWidth"],
                viewport["innerHeight"],
                viewport["outerWidth"],
                viewport["outerHeight"],
                viewport["availWidth"],
                viewport["availHeight"],
                screen["width"],
                screen["height"],
            ),
        })
        if browser_fingerprint.get("webglVendor"):
            profile["webgl_vendor"] = browser_fingerprint["webglVendor"]
        if browser_fingerprint.get("webglRenderer"):
            profile["webgl_renderer"] = browser_fingerprint["webglRenderer"]
        self._fingerprint._profile = profile
        return profile

    def authenticate(
        self,
        *,
        cookie_header: str,
        key_storage: str,
        web_protect_storage: str,
        server_cert_storage: str | None,
        browser_fingerprint: Mapping[str, object],
    ) -> object:
        profile = self._configure_browser_fingerprint(browser_fingerprint)
        try:
            from .vendor.douyin_spider.builder.auth import DouyinAuth
            from .vendor.douyin_spider.builder.header import HeaderBuilder
            from .vendor.douyin_spider.dy_apis.douyin_api import DouyinAPI
            from .vendor.douyin_spider.utils import ab_pure
            from .vendor.douyin_spider.utils.bd_ticket import derive_ecdh_key
        except Exception:
            raise _closed_unavailable() from None
        HeaderBuilder.ua = str(profile["ua"])
        HeaderBuilder.sec_ch_ua = str(profile["sec_ch_ua"])
        HeaderBuilder.sec_ch_ua_platform = str(profile["sec_ch_ua_platform"])
        HeaderBuilder.accept_language = str(profile["accept_language"])
        ab_pure.GEO_PLATFORM = str(profile["platform"])
        auth = DouyinAuth()
        try:
            auth.perepare_auth(
                cookie_header,
                web_protect_storage,
                key_storage,
            )
            auth.ensure_http_session()
            if server_cert_storage:
                server_data = json.loads(server_cert_storage)
                server_cert = (
                    server_data.get("cert")
                    if isinstance(server_data, Mapping) else None
                )
                if isinstance(server_cert, str) and server_cert:
                    auth.server_cert = server_cert
                    auth._ecdh_cache[(
                        6383,
                        "https://www.douyin.com",
                    )] = derive_ecdh_key(
                        auth.private_key,
                        server_cert,
                    )
            if (not auth.ticket or not auth.ts_sign or not auth.private_key
                    or not auth.ticket_matches_session()):
                raise ValueError("session material incomplete")
            self._api = DouyinAPI
            return auth
        except Exception:
            try:
                auth.close()
            except Exception:
                pass
            raise _closed_unavailable() from None

    def resolve_recipient(
        self, auth: object, target_url: str,
    ) -> Mapping[str, object]:
        payload = self._api.get_user_info(auth, target_url)
        user = payload.get("user") if isinstance(payload, Mapping) else None
        if not isinstance(user, Mapping):
            raise ValueError("recipient unavailable")
        return user

    def create_conversation(
        self, auth: object, recipient_uid: str,
    ) -> tuple[str, int, str]:
        return self._api.create_conversation(auth, int(recipient_uid))

    def send_text(
        self,
        auth: object,
        *,
        conversation_id: str,
        conversation_short_id: int,
        ticket: str,
        content: str,
        client_message_id: str,
    ) -> bool:
        return bool(self._api.send_msg(
            auth,
            conversation_id,
            conversation_short_id,
            ticket,
            content,
            client_message_id=client_message_id,
        ))


class DouyinSpiderPrivateMessageExecutor:
    """Send one frozen, explicitly approved text DM through DouYin_Spider."""

    def __init__(
        self,
        *,
        bindings: _Bindings | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._bindings = bindings
        self._now = now or (lambda: datetime.now(UTC))

    def execute(
        self,
        context: object,
        page: object,
        request: ActionRequest,
        *,
        account_authority_revalidator: Callable[[], object] | None = None,
    ) -> ActionReceipt:
        if request.kind != "direct_message":
            raise DouyinActionFailure("action_rejected")
        if self._now() >= request.deadline_at:
            raise DouyinActionFailure("deadline_exceeded")
        target_url = str(request.target_public_url)
        expected_sec_uid = _target_sec_uid(target_url)
        credentials = _browser_credentials(context, page)
        bindings = self._bindings or _DouyinSpiderBindings()
        auth: object | None = None
        send_started = False
        try:
            try:
                auth = bindings.authenticate(
                    cookie_header=credentials.cookie_header,
                    key_storage=credentials.key_storage,
                    web_protect_storage=credentials.web_protect_storage,
                    server_cert_storage=credentials.server_cert_storage,
                    browser_fingerprint=credentials.fingerprint,
                )
                recipient = bindings.resolve_recipient(auth, target_url)
            except DouyinActionFailure:
                raise
            except Exception:
                raise _closed_unavailable() from None
            recipient_uid = recipient.get("uid")
            recipient_sec_uid = recipient.get("sec_uid")
            if (not isinstance(recipient_uid, (str, int))
                    or _RECIPIENT_UID.fullmatch(str(recipient_uid)) is None
                    or not isinstance(recipient_sec_uid, str)
                    or _TARGET_SEC_UID.fullmatch(recipient_sec_uid) is None
                    or recipient_sec_uid != expected_sec_uid):
                raise DouyinActionFailure("action_rejected")
            if self._now() >= request.deadline_at:
                raise DouyinActionFailure("deadline_exceeded")
            if account_authority_revalidator is not None:
                account_authority_revalidator()
            try:
                conversation_id, conversation_short_id, ticket = (
                    bindings.create_conversation(auth, str(recipient_uid))
                )
            except DouyinActionFailure:
                raise
            except Exception:
                raise _closed_unavailable() from None
            if (not isinstance(conversation_id, str) or not conversation_id
                    or type(conversation_short_id) is not int
                    or conversation_short_id <= 0
                    or not isinstance(ticket, str) or not ticket):
                raise _closed_unavailable()
            if self._now() >= request.deadline_at:
                raise DouyinActionFailure("deadline_exceeded")
            if account_authority_revalidator is not None:
                account_authority_revalidator()
            client_message_id = _client_message_id(request.action_id)
            send_started = True
            try:
                sent = bindings.send_text(
                    auth,
                    conversation_id=conversation_id,
                    conversation_short_id=conversation_short_id,
                    ticket=ticket,
                    content=request.content,
                    client_message_id=client_message_id,
                )
            except Exception:
                raise DouyinActionFailure(
                    "douyin_action_receipt_ambiguous"
                ) from None
            if not sent:
                raise _closed_unavailable()
            reference_digest = hashlib.sha256(
                f"{conversation_id}:{client_message_id}".encode("utf-8")
            ).hexdigest()
            return ActionReceipt(
                action_id=request.action_id,
                state="succeeded",
                platform_receipt_reference=(
                    f"douyin-im:{reference_digest}"
                ),
                occurred_at=self._now(),
                failure_code=None,
            )
        except DouyinActionFailure:
            raise
        except Exception:
            raise DouyinActionFailure(
                "douyin_action_receipt_ambiguous"
                if send_started else "douyin_direct_message_unavailable"
            ) from None
        finally:
            close = getattr(auth, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
