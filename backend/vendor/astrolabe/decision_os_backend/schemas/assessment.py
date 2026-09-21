from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import Field

from decision_os_backend.schemas.common import APISchema


class AssessmentDimensionScore(APISchema):
    label: str
    score: float
    confidence: float | None = None
    note: str | None = None


class AssessmentInsight(APISchema):
    title: str
    body: str
    tone: str | None = None


class AssessmentSuggestedPath(APISchema):
    label: str
    title: str
    description: str
    condition: str | None = None
    tone: str | None = None


class AssessmentExperiment(APISchema):
    title: str
    metric: str
    threshold: str
    why: str | None = None
    expected_learning: str | None = None
    priority: str | None = None


class AssessmentRead(APISchema):
    id: UUID
    scenario_id: UUID
    viability_score: float
    dimension_scores: list[AssessmentDimensionScore] = Field(default_factory=list)
    data_sufficiency: float
    confidence: float
    top_risks: list[AssessmentInsight] = Field(default_factory=list)
    top_levers: list[AssessmentInsight] = Field(default_factory=list)
    suggested_paths: list[AssessmentSuggestedPath] = Field(default_factory=list)
    next_best_experiments: list[AssessmentExperiment] = Field(default_factory=list)
    created_at: datetime
