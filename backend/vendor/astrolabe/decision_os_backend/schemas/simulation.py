from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import Field

from decision_os_backend.models.enums import CompanyFinalOutcome, SimulationRunStatus
from decision_os_backend.schemas.common import APISchema


class SimulationRunCreate(APISchema):
    company_count: int = Field(default=100, ge=1, le=500)
    duration_months: int = Field(default=12, ge=1, le=60)


class VirtualCompanyRead(APISchema):
    id: UUID
    simulation_run_id: UUID
    company_index: int
    company_name: str
    founder_type: str
    pricing_strategy: str
    channel_strategy: str
    final_stage: str | None = None
    final_outcome: CompanyFinalOutcome | None = None
    death_reason: str | None = None
    summary: str | None = None
    latest_month_index: int = 0
    latest_cash_balance: float = 0.0
    latest_runway_months: float = 0.0
    latest_monthly_revenue: float = 0.0
    latest_profitability: float = 0.0
    latest_founder_energy: float = 0.0
    latest_state_label: str = "Unknown"
    latest_score: float = 0.0


class MonthlySnapshotRead(APISchema):
    id: UUID
    company_id: UUID
    month_index: int
    state_json: dict[str, Any]
    judge_summary: str | None = None


class SimulationTrendPoint(APISchema):
    label: str
    value: float


class SimulationDistributionPoint(APISchema):
    label: str
    value: int


class SimulationComparisonPoint(APISchema):
    label: str
    outcome_score: float
    survival_rate: float
    profitability_rate: float
    count: int


class SimulationRunRead(APISchema):
    id: UUID
    scenario_id: UUID
    status: SimulationRunStatus
    company_count: int
    duration_months: int
    created_at: datetime


class SimulationOverviewRead(SimulationRunRead):
    survival_curve: list[SimulationTrendPoint] = Field(default_factory=list)
    profitability_curve: list[SimulationTrendPoint] = Field(default_factory=list)
    death_reason_distribution: list[SimulationDistributionPoint] = Field(default_factory=list)
    founder_type_performance: list[SimulationComparisonPoint] = Field(default_factory=list)
    strategy_type_performance: list[SimulationComparisonPoint] = Field(default_factory=list)
    companies: list[VirtualCompanyRead] = Field(default_factory=list)


class SimulationCompanyListRead(APISchema):
    simulation_id: UUID
    companies: list[VirtualCompanyRead] = Field(default_factory=list)


class CompanyDetailRead(VirtualCompanyRead):
    judge_summary: str | None = None
    replay_log: str | None = None
    causes: list[str] = Field(default_factory=list)
    success_reason: str | None = None


class CompanyTimelineEntryRead(APISchema):
    month_index: int
    stage: str
    state_label: str
    cash_balance: float
    monthly_revenue: float
    founder_energy: float
    backlog_units: float
    quality_score: float
    leads: int
    conversion_rate: float
    churn_rate: float
    repeat_rate: float
    satisfaction_delta: float
    net_profit: float
    runway_months: float
    judge_summary: str | None = None
    replay_log: str | None = None
    key_events: list[str] = Field(default_factory=list)
    death_signals: list[str] = Field(default_factory=list)


class CompanyTimelineRead(APISchema):
    company_id: UUID
    simulation_run_id: UUID
    timeline: list[CompanyTimelineEntryRead] = Field(default_factory=list)
