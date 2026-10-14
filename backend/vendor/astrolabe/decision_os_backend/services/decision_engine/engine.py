from __future__ import annotations

from typing import Any, Mapping

from decision_os_backend.services.decision_engine.input import normalize_scenario_inputs
from decision_os_backend.services.decision_engine.insights import (
    build_next_best_experiments,
    build_suggested_paths,
    build_top_levers,
    build_top_risks,
)
from decision_os_backend.services.decision_engine.scoring import (
    apply_penalties,
    apply_viability_penalties,
    compute_confidence,
    compute_data_sufficiency,
    compute_weighted_score,
    evaluate_dimensions,
)
from decision_os_backend.services.decision_engine.types import DecisionEngineResult


class RuleBasedDecisionEngine:
    """Rule-driven, explainable decision engine for V1 assessments."""

    def evaluate(self, one_line_pitch: str, structured_inputs: Mapping[str, Any] | None = None) -> DecisionEngineResult:
        normalized = normalize_scenario_inputs(one_line_pitch, structured_inputs)
        dimensions = evaluate_dimensions(normalized)
        dimension_map = {dimension.slug: dimension for dimension in dimensions}

        raw_score = compute_weighted_score(dimensions)
        penalties = apply_penalties(normalized, dimension_map)
        viability_score = apply_viability_penalties(raw_score, penalties)
        data_sufficiency = compute_data_sufficiency(normalized)
        confidence = compute_confidence(data_sufficiency, dimensions, penalties)

        return DecisionEngineResult(
            viability_score=viability_score,
            dimension_scores=[dimension.to_schema() for dimension in dimensions],
            data_sufficiency=data_sufficiency,
            confidence=confidence,
            top_risks=build_top_risks(normalized, dimensions, penalties),
            top_levers=build_top_levers(normalized, dimensions),
            suggested_paths=build_suggested_paths(normalized, dimensions, viability_score),
            next_best_experiments=build_next_best_experiments(normalized, dimensions, penalties),
            penalties=penalties,
        )
