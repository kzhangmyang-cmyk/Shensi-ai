"""Desktop loopback protocol exercised with durable real managers, fake browser I/O."""
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from shensi_adapter import schemas
from shensi_adapter.accounts import AccountManager
from shensi_adapter.action_jobs import ActionJobManager, ActionReplayConflict, _semantic_hash
from shensi_adapter.app import create_app
from shensi_adapter.douyin_account_identity import identity_fingerprint_for_raw_sec_uid


FIXTURE = json.loads((Path(__file__).resolve().parents[4] / 'contracts/fixtures/desktop-outreach-hashes.v1.json').read_text())
NOW = datetime(2026, 9, 3, 8, 9, 10, 123456, tzinfo=UTC)
KEY = 'a' * 64
HEADERS = {'Authorization': 'Bearer ' + 's' * 48}


class Browser:
    interaction_surface = 'external_window'

    def __init__(self):
        self.writes = []
        self.reads = []

    def open_douyin_login(self, profile):
        return {'handle': profile.name, 'qr_status': 'opening'}

    def poll_douyin_login(self, context):
        return {'active': True, 'display_name': '测试账号',
                'identity_fingerprint': identity_fingerprint_for_raw_sec_uid(context['handle'])}

    def close(self, context):
        pass

    def close_browser(self):
        pass

    def execute_douyin_action(self, profile, request, *, authority_validator):
        authority_validator()
        self.writes.append((profile, request))
        return receipt(request.action_id)

    def reconcile_douyin_action(self, profile, request, *, authority_validator):
        authority_validator()
        self.reads.append((profile, request))
        return receipt(request.action_id)


def receipt(action_id):
    return {'action_id': action_id, 'state': 'succeeded', 'platform_receipt_reference': 'safe-receipt',
            'occurred_at': NOW, 'failure_code': None}


def accounts(root, browser=None):
    return AccountManager(root / 'state', browser or Browser(), profiles_root=root / 'profiles',
                          interaction_surface='external_window', now=lambda: NOW)


def authenticate(manager, key=KEY):
    session = manager.create_login_session(key)
    manager._login_bootstraps[session.session_id].join(timeout=2)
    result = manager.get_login_session(session.session_id)
    assert result.state == 'active'
    return result


def request(identity, **changes):
    content = '你好，海外增长 🚀'
    value = {'action_id': 'action-one', 'account_handle': identity.account_handle,
             'login_state_version': identity.login_state_version, 'kind': 'comment',
             'canonical_target_public_url': 'https://www.douyin.com/video/abc?x=%E4%BD%A0&x=2&&=',
             'content': content, 'approved_content_hash': 'sha256:' + hashlib.sha256(
                 json.dumps({'content': content}, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()}
    value.update(changes)
    value['request_hash'] = hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    value['deadline_at'] = '2026-09-03T08:12:10.123Z'
    return value


def jobs(root, manager):
    return ActionJobManager(root / 'state', manager.resolve_action_profile, manager.execute_action,
                            manager.reconcile_action, now=lambda: NOW)


def test_account_identity_recovers_exact_key_and_newest_login_after_restart(tmp_path):
    first = accounts(tmp_path)
    try:
        authenticate(first)
        expected = first.resolve_account_identity(KEY)
        other = authenticate(first, 'b' * 64)
        assert first.resolve_account_identity('b' * 64).account_handle == other.account_handle
        assert expected.account_handle != other.account_handle
    finally:
        first.close()
    restored = accounts(tmp_path)
    try:
        assert restored.resolve_account_identity(KEY) == expected
        assert restored.resolve_action_profile(expected.account_handle, expected.login_state_version).is_dir()
        with pytest.raises(KeyError):
            restored.resolve_account_identity('c' * 64)
        with pytest.raises(KeyError):
            restored.resolve_action_profile(expected.account_handle, expected.login_state_version + 1)
        restored.disconnect(restored._accounts[expected.account_handle]['id'])
        newer = authenticate(restored)
        assert newer.login_state_version > expected.login_state_version
        assert restored.resolve_account_identity(KEY).login_state_version == newer.login_state_version
    finally:
        restored.close()


@pytest.mark.parametrize('damage', ['missing', 'symlink', 'corrupt', 'profile-symlink', 'bad-version', 'non-object'])
def test_identity_rejects_invalid_durable_metadata(tmp_path, damage):
    manager = accounts(tmp_path)
    identity = authenticate(manager)
    profile = manager.resolve_action_profile(identity.account_handle, identity.login_state_version)
    manager.close()
    metadata = profile / '.shensi-connected-account.json'
    if damage == 'missing':
        metadata.unlink()
    elif damage == 'symlink':
        target = tmp_path / 'outside.json'
        metadata.rename(target)
        metadata.symlink_to(target)
    elif damage == 'profile-symlink':
        target = tmp_path / 'outside-profile'
        profile.rename(target)
        profile.symlink_to(target, target_is_directory=True)
    elif damage == 'bad-version':
        value = json.loads(metadata.read_text())
        value['login_state_version'] = True
        metadata.write_text(json.dumps(value))
    elif damage == 'non-object':
        metadata.write_text('[]')
    else:
        metadata.write_text('not json')
    restored = accounts(tmp_path)
    try:
        with pytest.raises(KeyError):
            restored.resolve_account_identity(KEY)
    finally:
        restored.close()


def test_oversized_account_version_cannot_poison_other_accounts_after_restart(tmp_path):
    first = accounts(tmp_path)
    damaged = authenticate(first)
    profile = first.resolve_action_profile(damaged.account_handle, damaged.login_state_version)
    healthy = authenticate(first, 'b' * 64)
    first.close()
    metadata = profile / '.shensi-connected-account.json'
    value = json.loads(metadata.read_text())
    value['login_state_version'] = 9007199254740992
    metadata.write_text(json.dumps(value))

    restored = accounts(tmp_path)
    try:
        with pytest.raises(KeyError):
            restored.resolve_account_identity(KEY)
        assert restored.resolve_account_identity('b' * 64).login_state_version == healthy.login_state_version
        another = authenticate(restored, 'c' * 64)
        assert another.login_state_version == healthy.login_state_version + 1
        assert restored.resolve_account_identity('c' * 64).account_handle == another.account_handle
    finally:
        restored.close()


def test_shared_desktop_hash_and_timestamp_vectors():
    from shensi_adapter.action_jobs import _receipt_hash
    for vector in FIXTURE['vectors']:
        model = schemas.DesktopActionRequest(**vector['request'], request_hash=vector['requestHash'], deadline_at=NOW)
        assert _semantic_hash(model) == vector['requestHash']
        assert _receipt_hash(schemas.DesktopActionReceipt(**vector['receipt'])) == vector['receiptHash']
    for timestamp in FIXTURE['rejectedTimestamps']:
        with pytest.raises(ValidationError):
            schemas.DesktopActionReceipt(**{**FIXTURE['vectors'][0]['receipt'], 'occurred_at': timestamp})


@pytest.mark.parametrize('account_id,key,profile_key', [
    ('account-ascii-01', 'f7755efa1f580ce3b3e8fa5ec3c506a1b087af59bf773c9bc2a930028e397d3a',
     '83c139e9c07eafbb9df68483a5b15d941e779b88232470a70c150bf0ae62b143'),
    ('账号-海外🚀', 'e389da1d759786cb22720b68e1e3096f0a6b50bc35815a2c211e535ad2e1654f',
     '54439baf2f9e4ed35238389f271ed066c1bf2cededcf94ae7a0a7655b4ae27b7'),
])
def test_main_account_key_vectors_find_exact_durable_profile(tmp_path, account_id, key, profile_key):
    assert hashlib.sha256(('douyin-profile:' + account_id).encode()).hexdigest() == key
    manager = accounts(tmp_path)
    try:
        identity = authenticate(manager, key)
        assert manager.resolve_account_identity(key).account_handle == identity.account_handle
        assert manager.resolve_action_profile(identity.account_handle, identity.login_state_version).name == profile_key
    finally:
        manager.close()


def test_desktop_rejects_noncanonical_targets_and_legacy_fields():
    base = {**FIXTURE['vectors'][0]['request'], 'request_hash': FIXTURE['vectors'][0]['requestHash'], 'deadline_at': NOW}
    for vector in FIXTURE['acceptedTargets']:
        schemas.DesktopActionRequest(**{**base, 'kind': vector['kind'], 'canonical_target_public_url': vector['canonical']})
        if vector['raw'] != vector['canonical']:
            with pytest.raises(ValidationError):
                schemas.DesktopActionRequest(**{**base, 'kind': vector['kind'], 'canonical_target_public_url': vector['raw']})
    for vector in FIXTURE['rejectedTargets']:
        with pytest.raises(ValidationError):
            schemas.DesktopActionRequest(**{**base, 'kind': vector['kind'], 'canonical_target_public_url': vector['raw']})
    with pytest.raises(ValidationError):
        schemas.DesktopActionRequest(**base, target_public_url=base['canonical_target_public_url'])


def test_fastapi_desktop_recovery_replay_and_exact_acknowledgement(tmp_path):
    browser = Browser()
    manager = accounts(tmp_path, browser)
    identity = authenticate(manager)
    body = request(identity)
    action_jobs = jobs(tmp_path, manager)
    path = '/internal/v1/douyin/actions/action-one'
    with TestClient(create_app('s' * 48, manager, action_job_manager=action_jobs, runtime_mode='desktop')) as client:
        assert client.post(path, json=body).status_code == 401
        resolved = client.post('/internal/v1/douyin/account-identities/resolve', json={'account_key': KEY}, headers=HEADERS)
        assert resolved.status_code == 200
        assert set(resolved.json()) == {'account_key', 'account_handle', 'account_display_name', 'login_state_version', 'profile_available'}
        assert client.post(path, json={**body, 'request_hash': '0' * 64}, headers=HEADERS).status_code == 409
        assert not list((tmp_path / 'state/action-receipts').glob('*.json'))
        done = client.post(path, json=body, headers=HEADERS)
        assert done.status_code == 200
        assert done.json()['occurred_at'] == '2026-09-03T08:09:10.123Z'
        assert client.post(path, json=body, headers=HEADERS).json() == done.json()
        assert len(browser.writes) == 1
        assert str(browser.writes[0][1].target_public_url) == body['canonical_target_public_url']
    restored = accounts(tmp_path, browser)
    restored_jobs = jobs(tmp_path, restored)
    with TestClient(create_app('s' * 48, restored, action_job_manager=restored_jobs, runtime_mode='desktop')) as client:
        assert client.post(path, json=body, headers=HEADERS).json() == done.json()
        assert len(browser.writes) == 1
        journal = next((tmp_path / 'state/action-receipts').glob('*.json'))
        stored = json.loads(journal.read_text())
        ack = {'request_hash': body['request_hash'], 'receipt_hash': stored['receipt_hash']}
        assert client.post(path + '/acknowledgement', json={**ack, 'receipt_hash': '0' * 64}, headers=HEADERS).status_code == 409
        assert journal.exists()
        acknowledged = client.post(path + '/acknowledgement', json=ack, headers=HEADERS)
        assert acknowledged.status_code == 200
        assert not journal.exists()
        assert client.post(path + '/acknowledgement', json=ack, headers=HEADERS).json() == acknowledged.json()
    third = accounts(tmp_path, browser)
    with TestClient(create_app('s' * 48, third, action_job_manager=jobs(tmp_path, third), runtime_mode='desktop')) as client:
        assert client.post(path + '/acknowledgement', json=ack, headers=HEADERS).json() == acknowledged.json()
        assert client.post(path + '/acknowledgement', json={**ack, 'request_hash': '0' * 64}, headers=HEADERS).status_code == 409
        assert client.post(path, json=body, headers=HEADERS).json() == done.json()
        assert len(browser.writes) == 1
        assert not journal.exists()
        assert client.post(path + '/reconcile', json=body, headers=HEADERS).json() == done.json()


@pytest.mark.parametrize('kind,target', [('comment', 'https://www.douyin.com/video/abc?'),
                                        ('direct_message', 'https://www.douyin.com/user/abc?')])
def test_http_protocol_separation_and_canonical_target_survives_executor_boundary(tmp_path, kind, target):
    browser = Browser()
    manager = accounts(tmp_path, browser)
    identity = authenticate(manager)
    body = request(identity, kind=kind, canonical_target_public_url=target)
    action_jobs = jobs(tmp_path, manager)
    path = '/internal/v1/douyin/actions/action-one'
    with TestClient(create_app('s' * 48, manager, action_job_manager=action_jobs, runtime_mode='desktop')) as client:
        legacy = {key: value for key, value in body.items() if key not in {'request_hash', 'canonical_target_public_url'}}
        legacy['target_public_url'] = target
        assert client.post(path, json=legacy, headers=HEADERS).status_code == 422
        assert client.post(path, json={**body, 'target_public_url': target}, headers=HEADERS).status_code == 422
        assert client.post(path, json=body, headers={'X-Shensi-Desktop-Device-Token': 's' * 48}).status_code == 401
        assert client.post(path, json=body, headers=HEADERS).status_code == 200
        assert str(browser.writes[0][1].target_public_url) == target
    web_manager = accounts(tmp_path / 'web-compat', browser)
    with TestClient(create_app('s' * 48, web_manager, action_job_manager=action_jobs)) as client:
        assert client.post(path, json=body, headers=HEADERS).status_code == 422
        # A different action avoids mixing desktop and Web journals.
        legacy['action_id'] = 'web-action'
        assert client.post('/internal/v1/douyin/actions/web-action', json=legacy, headers=HEADERS).status_code == 200


def test_disabled_desktop_routes_never_execute(tmp_path):
    browser = Browser()
    manager = accounts(tmp_path, browser)
    identity = authenticate(manager)
    body = request(identity)
    with TestClient(create_app('s' * 48, manager, action_job_manager=jobs(tmp_path, manager),
                               runtime_mode='desktop', outreach_actions_enabled=False)) as client:
        path = '/internal/v1/douyin/actions/action-one'
        assert client.post(path, json=body, headers=HEADERS).status_code == 503
        assert client.post(path + '/reconcile', json=body, headers=HEADERS).status_code == 503
        assert client.post(path + '/acknowledgement', json={'request_hash': body['request_hash'],
                           'receipt_hash': 'a' * 64}, headers=HEADERS).status_code == 503
        assert browser.writes == browser.reads == []


@pytest.mark.parametrize('query', ['x=%7F', 'x=%FF', 'x=%ED%A0%80'])
def test_matching_hash_does_not_admit_del_or_invalid_utf8_query(tmp_path, query):
    browser = Browser()
    manager = accounts(tmp_path, browser)
    identity = authenticate(manager)
    body = request(identity, canonical_target_public_url='https://www.douyin.com/video/abc?' + query)
    with TestClient(create_app('s' * 48, manager, action_job_manager=jobs(tmp_path, manager),
                               runtime_mode='desktop')) as client:
        response = client.post('/internal/v1/douyin/actions/action-one', json=body, headers=HEADERS)
        assert response.status_code == 422
        assert browser.writes == []
        assert not list((tmp_path / 'state/action-receipts').glob('*.json'))


def test_started_journal_is_not_acknowledged_or_reexecuted_and_reconcile_is_read_only(tmp_path):
    browser = Browser()
    manager = accounts(tmp_path, browser)
    try:
        identity = authenticate(manager)
        body = request(identity)
        model = schemas.DesktopActionRequest(**body)
        action_jobs = jobs(tmp_path, manager)
        journal = action_jobs._path(body['action_id'])
        action_jobs._persist_started(journal, body['request_hash'])
        with pytest.raises(ActionReplayConflict):
            action_jobs.acknowledge(body['action_id'], body['request_hash'], '0' * 64)
        assert action_jobs.execute(model).failure_code == 'douyin_action_receipt_ambiguous'
        assert browser.writes == []
        assert json.loads(journal.read_text())['state'] == 'started'
        assert action_jobs.reconcile(model).state == 'succeeded'
        assert browser.writes == []
        assert len(browser.reads) == 1
    finally:
        manager.close()


@pytest.mark.parametrize('rotated', [False, True])
def test_acknowledged_uncertain_receipt_can_be_observed_without_rewriting_tombstone(tmp_path, rotated):
    browser = Browser()
    manager = accounts(tmp_path, browser)
    try:
        identity = authenticate(manager)
        body = request(identity)
        model = schemas.DesktopActionRequest(**body)
        action_jobs = jobs(tmp_path, manager)
        journal = action_jobs._path(body['action_id'])
        action_jobs._persist_started(journal, body['request_hash'])
        failed = schemas.DesktopActionReceipt(**{**receipt(body['action_id']),
            'state': 'failed', 'platform_receipt_reference': None,
            'failure_code': 'douyin_action_receipt_ambiguous'})
        action_jobs._persist(journal, body['request_hash'], failed)
        value = json.loads(journal.read_text())
        action_jobs.acknowledge(body['action_id'], body['request_hash'], value['receipt_hash'])
        tombstone = action_jobs._ack_root / journal.name
        original = tombstone.read_bytes()
        if rotated:
            manager.disconnect(manager._accounts[identity.account_handle]['id'])
            current = authenticate(manager)
            assert current.account_handle == identity.account_handle
            assert current.login_state_version > identity.login_state_version
            observation = {**body, 'observation_login_state_version': current.login_state_version}
            with TestClient(create_app('s' * 48, manager,
                    action_job_manager=action_jobs, runtime_mode='desktop')) as client:
                path = '/internal/v1/douyin/actions/action-one'
                assert client.post(path, json=observation, headers=HEADERS).status_code == 422
                response = client.post(path + '/reconcile', json=observation, headers=HEADERS)
                assert response.status_code == 200
                assert response.json()['state'] == 'succeeded'
            assert browser.reads[0][1].login_state_version == current.login_state_version
        else:
            assert action_jobs.reconcile(model).state == 'succeeded'
        assert len(browser.reads) == 1
        assert browser.writes == []
        assert tombstone.read_bytes() == original
        assert not journal.exists()
        assert action_jobs.execute(model).failure_code == 'douyin_action_receipt_ambiguous'
        assert browser.writes == []
    finally:
        manager.close()
