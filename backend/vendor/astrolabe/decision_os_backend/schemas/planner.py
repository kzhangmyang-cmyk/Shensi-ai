from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import Field

from decision_os_backend.models.enums import ExperimentPlanDecision
from decision_os_backend.schemas.common import APISchema


class ExperimentPlanRead(APISchema):
    id: UUID
    scenario_id: UUID
    stage_order: int
    stage_label: str
    action: str
    metric: str
    threshold: str
    fallback_suggestion: str | None = None
    decision: ExperimentPlanDecision
    created_at: datetime


class PlannerCheckpointRead(APISchema):
    metric: str
    current_signal: str
    success_threshold: str
    note: str
    tone: str | None = None


class PlannerStageRead(APISchema):
    id: str
    stage_label: str
    stage_order: int
    title: str
    objective: str
    recommended_actions: list[str] = Field(default_factory=list)
    checkpoints: list[PlannerCheckpointRead] = Field(default_factory=list)
    adjustment_advice: str
    decision: ExperimentPlanDecision
    decision_reason: str
    tone: str | None = None
    items: list[ExperimentPlanRead] = Field(default_factory=list)


class PlannerRead(APISchema):
    scenario_id: UUID
    headline: str
    summary: str
    primary_bet: str
    planning_north_star: str
    failure_pattern: str
    stages: list[PlannerStageRead] = Field(default_factory=list)
