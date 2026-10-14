"""Real Chromium, intercepted fixture traffic only; never contacts Douyin."""

from datetime import UTC, datetime, timedelta
import hashlib
import json
import os
from types import SimpleNamespace

from playwright.sync_api import sync_playwright

from shensi_adapter.browser_state import _execute_action
from shensi_adapter.douyin_account_identity import account_handle_for_raw_sec_uid
from shensi_adapter.schemas import ActionRequest


def test_comment_sms_keeps_real_context_until_manual_completion_and_receipt(tmp_path):
    target = "https://www.douyin.com/video/7350000000000000001"
    publish = "https://www.douyin.com/aweme/v1/web/comment/publish/"
    content = "本地验证等待测试，不发送到平台"
    raw_sender = "MS4wLjABFixtureAccount"
    body = """
      <!doctype html><html><head><meta charset="utf-8">
      <title>Shensi 本地测试页面（无真实发送）</title></head><body>
      <h1>本地测试页面，不连接抖音</h1>
      <header><a href="/user/MS4wLjABFixtureAccount">本地测试账号</a></header>
      <div class="public-DraftEditor-content" contenteditable="true"></div>
      <div data-e2e="comment-post">发布</div>
      <section id="sms" hidden>
        <h2>接收短信验证码</h2><input placeholder="请输入验证码">
        <p>测试夹具将在 12 秒后模拟人工完成，测试代码不会操作验证码控件。</p>
      </section>
      <section id="receipts"></section>
      <script>
        window.sendCount = 0;
        window.editCount = 0;
        const editor = document.querySelector('[contenteditable]');
        editor.addEventListener('input', () => window.editCount++);
        document.querySelector('[data-e2e="comment-post"]').onclick = () => {
          window.sendCount++;
          window.editsAtSubmit = window.editCount;
          document.querySelector('#sms').hidden = false;
          fetch('/aweme/v1/web/comment/publish/', {
            method: 'POST', body: new URLSearchParams({
              text: editor.textContent, aweme_id: '7350000000000000001'
            })
          });
          setTimeout(async () => {
            await window.fixtureManualCompletion({
              sends: window.sendCount, edits: window.editCount,
              editsAtSubmit: window.editsAtSubmit
            });
            document.querySelector('#sms').hidden = true;
            const receipt = document.createElement('div');
            receipt.dataset.commentId = 'local-sms-receipt';
            receipt.dataset.owner = 'self';
            receipt.textContent = editor.textContent;
            document.querySelector('#receipts').appendChild(receipt);
          }, 12000);
        };
      </script></body></html>
    """
    request = ActionRequest(
        action_id="local-comment-sms-fixture", kind="comment",
        account_handle=account_handle_for_raw_sec_uid(raw_sender),
        login_state_version=1, target_public_url=target, content=content,
        deadline_at=datetime.now(UTC) + timedelta(seconds=60),
        approved_content_hash="sha256:" + hashlib.sha256(json.dumps(
            {"content": content}, ensure_ascii=False, sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest(),
    )
    events = []
    outbound = []

    with sync_playwright() as runtime:
        class FixtureChromium:
            def launch_persistent_context(self, profile_path, **_options):
                context = runtime.chromium.launch_persistent_context(
                    profile_path,
                    headless=os.environ.get("SHENSI_TEST_VISIBLE_BROWSER") != "1",
                )
                context.on("close", lambda: events.append("closed"))

                def manual_completion(source, data):
                    assert "closed" not in events
                    assert not source["page"].is_closed()
                    assert data["sends"] == 1
                    assert data["edits"] == data["editsAtSubmit"]
                    events.append("manual_completed")

                context.expose_binding("fixtureManualCompletion", manual_completion)

                def route_fixture(route):
                    if route.request.url in {"https://www.douyin.com/", target}:
                        route.fulfill(status=200, content_type="text/html", body=body)
                    elif route.request.url == publish:
                        outbound.append(route.request.method)
                        route.fulfill(status=200, content_type="application/json",
                                      body='{"status_code": 1}')
                    else:
                        route.abort()

                context.route("**/*", route_fixture)
                return context

        result = _execute_action(
            SimpleNamespace(chromium=FixtureChromium()), str(tmp_path / "profile"),
            request.model_dump(mode="json"), headless=False, browser_channel=None,
            manual_verification_seconds=30,
        )

    assert result["state"] == "succeeded"
    assert result["platform_receipt_reference"] == "douyin-comment:local-sms-receipt"
    assert outbound == ["POST"]
    assert events == ["manual_completed", "closed"]
