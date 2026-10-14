from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from decision_os_backend.schemas.assessment import (
    AssessmentDimensionScore,
    AssessmentExperiment,
    AssessmentInsight,
    AssessmentSuggestedPath,
)


class NormalizedScenarioInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    one_line_pitch: str = ""
    target_customer: str = ""
    core_pain: str = ""
    solution: str = ""
    business_model: str = ""
    pricing: str = ""
    acquisition_channels: str = ""
    founder_profile: str = ""
    team_size: str = ""
    budget: str = ""
    traction: str = ""
    competitors: str = ""
    supplementary_evidence: list[dict[str, Any]] = Field(default_factory=list)


class DimensionEvaluation(BaseModel):
    slug: str
    label: str
    score: float
    confidence: float
    note: str
    weight: float

    def to_schema(self) -> AssessmentDimensionScore:
        return AssessmentDimensionScore(
            label=self.label,
            score=round(self.score, 1),
            confidence=round(self.confidence, 1),
            note=self.note,
        )


class PenaltySignal(BaseModel):
    code: str
    title: str
    reason: str
    deduction: float
    cap: float


class DecisionEngineResult(BaseModel):
    viability_score: float
    dimension_scores: list[AssessmentDimensionScore]
    data_sufficiency: float
    confidence: float
    top_risks: list[AssessmentInsight]
    top_levers: list[AssessmentInsight]
    suggested_paths: list[AssessmentSuggestedPath]
    next_best_experiments: list[AssessmentExperiment]
    penalties: list[PenaltySignal] = Field(default_factory=list)
