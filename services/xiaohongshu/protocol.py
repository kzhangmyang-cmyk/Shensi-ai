"""Strict private worker wire format; authority comes from the parent process."""
import json
import math
from uuid import UUID

from single_send import ApprovedCommand


def _uuid(value):
    if not isinstance(value, str):
        raise ValueError('invalid_identity')
    try:
        if str(UUID(value)) != value:
            raise ValueError('invalid_identity')
    except (ValueError, AttributeError):
        raise ValueError('invalid_identity') from None
    return value


def _exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('invalid_fields')


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_field')
        result[key] = value
    return result


def _constant(value):
    raise ValueError('nonfinite_json')


def parse_request(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > 65536:
        raise ValueError('invalid_request_size')
    try:
        request = json.loads(raw, object_pairs_hook=_object, parse_constant=_constant)
    except (RecursionError, UnicodeError):
        raise ValueError('invalid_json') from None
    if not isinstance(request, dict):
        raise ValueError('invalid_request')
    operation = request.get('operation')
    if operation in ('open', 'connect', 'close'):
        _exact(request, ('id', 'operation', 'accountId'))
        _uuid(request['accountId'])
    elif operation == 'execute':
        _exact(request, ('id', 'operation', 'command'))
        if not isinstance(request['command'], dict):
            raise ValueError('invalid_command')
    else:
        raise ValueError('invalid_operation')
    _uuid(request['id'])
    return request


def approved_command(owner, value):
    _exact(value, ('commandId', 'accountId', 'workspaceId', 'actorId', 'deviceId',
                   'recipientId', 'body', 'revision', 'clientMessageId', 'generation', 'expiresAt'))
    if (value['workspaceId'], value['actorId'], value['deviceId']) != (
            owner.workspace_id, owner.actor_id, owner.device_id):
        raise ValueError('command_scope_mismatch')
    for key in ('commandId', 'accountId', 'clientMessageId', 'generation'):
        _uuid(value[key])
    expiry = value['expiresAt']
    if type(expiry) not in (int, float) or not math.isfinite(expiry) or expiry <= 0:
        raise ValueError('invalid_command_expiry')
    return ApprovedCommand(
        command_id=value['commandId'], account_id=value['accountId'],
        workspace_id=owner.workspace_id, actor_id=owner.actor_id, device_id=owner.device_id,
        recipient_id=value['recipientId'], body=value['body'], revision=value['revision'],
        client_message_id=value['clientMessageId'], expires_at=expiry / 1000,
    ), value['generation']


def public_receipt(receipt):
    if receipt.status == 'confirmed' and receipt.server_message_id:
        return {'status': 'confirmed', 'serverMessageId': receipt.server_message_id}
    if receipt.status == 'rejected' and type(receipt.platform_code) is int:
        return {'status': 'rejected', 'platformCode': receipt.platform_code}
    return {'status': 'unknown'}
