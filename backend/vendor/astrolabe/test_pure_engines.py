"""Isolated compatibility checks; no application, database, or model calls."""
from dataclasses import asdict
import sys
import unittest
from uuid import UUID


class PureEngineTests(unittest.TestCase):
    def test_public_engine_import_does_not_require_examples_or_server(self):
        try:
            from decision_os_backend.services.decision_engine import RuleBasedDecisionEngine
        except ImportError as error:
            self.fail(f"Pure decision package must import without optional examples: {error}")
        result = RuleBasedDecisionEngine().evaluate("Synthetic source compatibility check", {})
        self.assertEqual(len(result.dimension_scores), 8)
        self.assertFalse(any(name == "sqlalchemy" or name.startswith("sqlalchemy.") for name in sys.modules))

    def test_seeded_monthly_results_are_reproducible_without_mutating_inputs(self):
        from decision_os_backend.services.decision_engine import RuleBasedDecisionEngine
        from decision_os_backend.services.simulation_engine import SimulationRunner
        from decision_os_backend.services.simulation_engine.domain import SimulationContext
        inputs = {"target_customer": "small local businesses", "team_size": 2, "budget": 100000}
        assessment = RuleBasedDecisionEngine().evaluate("Synthetic business planning service", inputs)
        context = SimulationContext(
            scenario_id=UUID("00000000-0000-0000-0000-000000000001"),
            one_line_pitch="Synthetic business planning service", structured_inputs=inputs,
            viability_score=assessment.viability_score, confidence=assessment.confidence,
            dimension_scores={item.label.lower().replace(" ", "_"): item.score for item in assessment.dimension_scores},
            company_count=100, duration_months=12, seed=7,
        )
        before = asdict(context)
        first = SimulationRunner().run(context)
        second = SimulationRunner().run(context)
        self.assertEqual(asdict(first), asdict(second))
        self.assertEqual(asdict(context), before)
        self.assertEqual(len(first.companies), 100)
        for company in first.companies:
            records = company.heartbeat_records
            self.assertGreater(len(records), 0)
            self.assertLessEqual(len(records), 12)
            self.assertEqual([record.month_index for record in records], list(range(1, len(records) + 1)))


if __name__ == "__main__":
    unittest.main()
