"""Offline receipt boundary; no authentication or platform network calls."""
import unittest
import importlib.util


class ReceiptTests(unittest.TestCase):
    def tracker(self):
        self.assertIsNotNone(importlib.util.find_spec("receipts"), "receipt correlator is implemented")
        from receipts import ReceiptTracker
        return ReceiptTracker("account-a", "generation-a", "client-a")

    def ack(self, **fields):
        return {"decoded": {"im": {"chatACK": {"mid": "client-a", "messageid": "server-a", "code": 0, **fields}}}}

    def test_only_exact_message_ack_confirms(self):
        t = self.tracker()
        for frame in [{"b": {"a": {"c": 0}}}, self.ack(mid="other"), self.ack(messageid=""), self.ack(code="0")]:
            self.assertEqual(t.observe("account-a", "generation-a", frame).status, "pending")
        receipt = t.observe("account-a", "generation-a", self.ack())
        self.assertEqual((receipt.status, receipt.server_message_id), ("confirmed", "server-a"))

    def test_wrong_account_and_old_generation_cannot_resolve(self):
        t = self.tracker()
        for account, generation in [("account-b", "generation-a"), ("account-a", "generation-b")]:
            self.assertEqual(t.observe(account, generation, self.ack()).status, "pending")

    def test_disconnect_is_unknown_and_exact_late_ack_can_reconcile(self):
        t = self.tracker()
        self.assertEqual(t.disconnected().status, "unknown")
        self.assertEqual(t.observe("account-a", "generation-a", self.ack(mid="other")).status, "unknown")
        self.assertEqual(t.observe("account-a", "generation-a", self.ack()).status, "confirmed")

    def test_definitive_result_does_not_change_on_duplicate_or_conflict(self):
        t = self.tracker()
        first = t.observe("account-a", "generation-a", self.ack(code=3100001, messageid=""))
        self.assertEqual(first.status, "rejected")
        self.assertEqual(first.platform_code, 3100001)
        self.assertEqual(t.observe("account-a", "generation-a", self.ack()), first)
        self.assertEqual(t.disconnected(), first)

    def test_malformed_untrusted_frames_do_not_resolve(self):
        t = self.tracker()
        for frame in [None, [], {"decoded": None}, {"decoded": {"im": []}}, self.ack(code=True), self.ack(code=-1)]:
            self.assertEqual(t.observe("account-a", "generation-a", frame).status, "pending")

    def test_identifiers_are_required(self):
        self.tracker()
        from receipts import ReceiptTracker
        for args in [("", "g", "m"), ("a", "", "m"), ("a", "g", ""), ("a", "g", "\n")]:
            with self.assertRaises(ValueError):
                ReceiptTracker(*args)

    def test_push_batch_finds_exact_ack_among_unrelated_events(self):
        t = self.tracker()
        frame = {"decoded": {"im": [{"decode_error": "invalid"}, self.ack(mid="other")["decoded"]["im"], self.ack()["decoded"]["im"]]}}
        self.assertEqual(t.observe("account-a", "generation-a", frame).status, "confirmed")


if __name__ == "__main__":
    unittest.main()
