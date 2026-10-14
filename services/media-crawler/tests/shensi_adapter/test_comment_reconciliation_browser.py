"""Real comment-card structure, local intercepted HTTP only; never sends."""

from datetime import UTC, datetime, timedelta
import hashlib
import json
from types import SimpleNamespace

import pytest
from playwright.sync_api import sync_playwright

from shensi_adapter.douyin_account_identity import account_handle_for_raw_sec_uid
from shensi_adapter.douyin_actions import (
    DouyinActionFailure, DouyinActionReconciler, _comment_list_receipts,
)
from shensi_adapter.schemas import ActionReconciliationRequest


TARGET = "https://www.douyin.com/video/7350000000000000001"
SENDER = "MS4wLjABFixtureAccount"
CONTENT = "本地只读回执测试"
COMMENT_ID = "7350000000000000002"


@pytest.mark.parametrize("variant", ["matching", "wrong_sender", "old", "wrong_video", "duplicate"])
def test_delayed_platform_comment_list_reconciles_without_synthetic_dom_attributes(variant):
    now = datetime.now(UTC)
    comment = {
        "cid": COMMENT_ID, "aweme_id": TARGET.rsplit("/", 1)[1],
        "text": CONTENT, "user": {"sec_uid": SENDER}, "reply_id": "0",
        "create_time": int((now - timedelta(seconds=2)).timestamp()),
    }
    if variant == "wrong_sender":
        comment["user"] = {"sec_uid": "MS4wLjABOtherAccount"}
    elif variant == "old":
        comment["create_time"] -= 120
    elif variant == "wrong_video":
        comment["aweme_id"] = "7350000000000000999"
    comments = [comment]
    if variant == "duplicate":
        comments.append({**comment, "cid": "7350000000000000003"})
    request = ActionReconciliationRequest(
        action_id="local-readonly-comment", kind="comment",
        account_handle=account_handle_for_raw_sec_uid(SENDER),
        login_state_version=8, target_public_url=TARGET, content=CONTENT,
        deadline_at=now + timedelta(seconds=30),
        not_before=now - timedelta(seconds=10),
        approved_content_hash="sha256:" + hashlib.sha256(json.dumps(
            {"content": CONTENT}, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest(),
    )
    # Structure observed on the real public video: no data-owner/direction or
    # machine-readable timestamp. The visible relative time is NOT evidence.
    body = f"""<!doctype html><html><body>
      <header><a href="/user/{SENDER}">测试账号</a></header>
      <div data-e2e="comment-item">
        <div class="comment-item-info-wrap"><a href="/user/{SENDER}">测试账号</a>
          <div data-e2e="video-comment-more"><div id="tooltip_{COMMENT_ID}">...</div></div>
        </div><div><span>{CONTENT}</span></div><div><span>1分钟前·测试</span></div>
      </div><script>
        window.interactions = 0;
        document.addEventListener('click', () => window.interactions++);
        document.addEventListener('input', () => window.interactions++);
        setTimeout(() => fetch('/aweme/v1/web/comment/list/?aweme_id=7350000000000000001&cursor=0&count=20'), 300);
      </script></body></html>"""
    outbound = []
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        page = browser.new_page()

        def fixture(route):
            outbound.append((route.request.method, route.request.url))
            if route.request.url == TARGET:
                route.fulfill(status=200, content_type="text/html", body=body)
            elif "/aweme/v1/web/comment/list/" in route.request.url:
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"status_code": 0, "comments": comments}))
            else:
                route.abort()

        page.route("**/*", fixture)
        reconciler = DouyinActionReconciler(
            receipt_wait_ms=750,
            account_identity_revalidator=lambda: SENDER,
            require_account_identity_binding=True,
        )
        try:
            if variant == "matching":
                receipt = reconciler.reconcile(page, request)
                assert receipt.platform_receipt_reference == f"douyin-comment:{COMMENT_ID}"
            else:
                with pytest.raises(DouyinActionFailure, match="douyin_action_receipt_ambiguous"):
                    reconciler.reconcile(page, request)
            assert page.evaluate("window.interactions") == 0
            assert all(method == "GET" for method, _ in outbound)
        finally:
            browser.close()


@pytest.mark.parametrize("variant", [
    "foreign_host", "http", "port", "credentials", "publish", "post", "duplicate_query",
    "bad_status", "bad_platform_status", "missing_author", "missing_time", "future_time",
    "boolean_time", "missing_id", "reply", "invalid_reply", "changed_text", "bad_json",
])
def test_comment_list_receipt_rejects_missing_or_conflicting_authority(variant):
    now = datetime.now(UTC)
    request = ActionReconciliationRequest(
        action_id="local-readonly-comment", kind="comment",
        account_handle=account_handle_for_raw_sec_uid(SENDER), login_state_version=8,
        target_public_url=TARGET, content=CONTENT, deadline_at=now + timedelta(seconds=30),
        not_before=now - timedelta(seconds=10), approved_content_hash="sha256:" + "a" * 64,
    )
    comment = {
        "cid": COMMENT_ID, "aweme_id": TARGET.rsplit("/", 1)[1], "text": CONTENT,
        "user": {"sec_uid": SENDER}, "reply_id": "0", "create_time": int(now.timestamp()) - 2,
    }
    payload = {"status_code": 0, "comments": [comment]}
    url = "https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=7350000000000000001"
    response = SimpleNamespace(url=url, request=SimpleNamespace(method="GET"), status=200,
                               json=lambda: payload)
    changes = {
        "foreign_host": url.replace("www.douyin.com", "other.example"),
        "http": url.replace("https:", "http:"),
        "port": url.replace(".com/", ".com:8443/"),
        "credentials": url.replace("https://", "https://someone@"),
        "publish": url.replace("/list/", "/publish/"),
        "duplicate_query": url + "&aweme_id=7350000000000000001",
    }
    if variant in changes:
        response.url = changes[variant]
    elif variant == "post":
        response.request.method = "POST"
    elif variant == "bad_status":
        response.status = 500
    elif variant == "bad_platform_status":
        payload["status_code"] = False
    elif variant == "missing_author":
        comment.pop("user")
    elif variant == "missing_time":
        comment.pop("create_time")
    elif variant == "future_time":
        comment["create_time"] = int(now.timestamp()) + 300
    elif variant == "boolean_time":
        comment["create_time"] = True
    elif variant == "missing_id":
        comment.pop("cid")
    elif variant == "reply":
        comment["reply_id"] = "7350000000000000099"
    elif variant == "invalid_reply":
        comment["reply_id"] = []
    elif variant == "changed_text":
        comment["text"] += "额外文字"
    elif variant == "bad_json":
        response.json = lambda: (_ for _ in ()).throw(ValueError("unreadable"))
    assert _comment_list_receipts(response, request, now) == set()
