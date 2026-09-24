import importlib.util
import json
import unittest


class ProtocolTests(unittest.TestCase):
    def parser(self):
        self.assertIsNotNone(importlib.util.find_spec('protocol'), 'private process protocol exists')
        from protocol import parse_request
        return parse_request

    def test_exact_operations_and_uuid_correlations(self):
        parse = self.parser()
        request = {'id':'00000000-0000-4000-8000-000000000001','operation':'open','accountId':'00000000-0000-4000-8000-000000000002'}
        self.assertEqual(parse(json.dumps(request)),request)
        for mutation in [{'operation':'navigate','url':'https://example.org'}, {'ownerId':'other'}, {'profile':'/tmp/other'}, {'id':'not-uuid'}]:
            with self.assertRaises(ValueError): parse(json.dumps({**request,**mutation}))

    def test_duplicate_keys_and_nonfinite_json_are_rejected(self):
        parse=self.parser()
        for raw in ['{"id":"a","id":"b"}', '{"expiresAt":NaN}', '[]', 'x'*65537]:
            with self.assertRaises(ValueError): parse(raw)

    def test_execute_has_exact_scope_and_converts_milliseconds_once(self):
        self.parser()
        from protocol import approved_command
        from sessions import Owner
        owner=Owner('workspace','actor','device')
        command={'commandId':'00000000-0000-4000-8000-000000000001','accountId':'00000000-0000-4000-8000-000000000002',
                 'workspaceId':'workspace','actorId':'actor','deviceId':'device','recipientId':'recipient','body':'synthetic',
                 'revision':2,'clientMessageId':'00000000-0000-4000-8000-000000000003','generation':'00000000-0000-4000-8000-000000000004','expiresAt':200000}
        value,generation=approved_command(owner,command)
        self.assertEqual(value.expires_at,200)
        self.assertEqual(value.body,'synthetic')
        self.assertEqual(generation,command['generation'])
        for mutation in [{'workspaceId':'other'},{'actorId':'other'},{'deviceId':'other'},{'expiresAt':True},{'extra':'field'}]:
            with self.assertRaises(ValueError): approved_command(owner,{**command,**mutation})

    def test_receipts_never_return_internal_fields(self):
        self.parser()
        from protocol import public_receipt
        from receipts import Receipt
        self.assertEqual(public_receipt(Receipt('confirmed','server',0)),{'status':'confirmed','serverMessageId':'server'})
        self.assertEqual(public_receipt(Receipt('rejected',platform_code=7)),{'status':'rejected','platformCode':7})
        self.assertEqual(public_receipt(Receipt('unknown')),{'status':'unknown'})

    def test_wire_size_is_bytes_and_nested_duplicate_keys_are_rejected(self):
        parse = self.parser()
        for raw in ['"' + '中'*22000 + '"', '{"command":{"body":"a","body":"b"}}', '['*2000]:
            with self.assertRaises(ValueError): parse(raw)

    def test_execute_envelope_has_no_alternate_authority_fields(self):
        parse = self.parser()
        request = {'id':'00000000-0000-4000-8000-000000000001','operation':'execute','command':{}}
        self.assertEqual(parse(json.dumps(request)), request)
        for mutation in [{'command':[]}, {'enabled':True}, {'url':'https://example.org'}]:
            with self.assertRaises(ValueError): parse(json.dumps({**request, **mutation}))
