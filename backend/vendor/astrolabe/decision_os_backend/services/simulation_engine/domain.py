from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any
from uuid import UUID

from decision_os_backend.models.enums import CompanyFinalOutcome


class CompanyStage(StrEnum):
    EXPLORE = "explore"
    SURVIVE = "survive"
    SUSTAINABLE = "sustainable"
    SCALABLE = "scalable"
    DEAD = "dead"


class FounderArchetype(StrEnum):
    HYBRID = "hybrid"
    BUILDER = "builder"
    SELLER = "seller"
    OPERATOR = "operator"
    ANALYST = "analyst"


class PricingStrategy(StrEnum):
    PILOT_FIRST = "pilot_first"
    SUBSCRIPTION = "subscription"
    USAGE_BASED = "usage_based"


class ChannelStrategy(StrEnum):
    FOUNDER_LED = "founder_led"
    COMMUNITY = "community"
    CONTENT = "content"
    OUTBOUND = "outbound"
    PARTNERSHIP = "partnership"


class FounderFocus(StrEnum):
    DISCOVERY = "discovery"
    PRICING = "pricing"
    DELIVERY = "delivery"
    DISTRIBUTION = "distribution"
    AUTOMATION = "automation"
    RETRENCH = "retrench"


class FounderActionType(StrEnum):
    HOLD = "hold"
    ADJUST_PRICING = "adjust_pricing"
    SHIFT_CHANNEL = "shift_channel"
    NARROW_ICP = "narrow_icp"
    BROADEN_ICP = "broaden_icp"
    INCREASE_AUTOMATION = "increase_automation"
    HIRE = "hire"
    FREEZE_HIRING = "freeze_hiring"
    PIVOT = "pivot"


@dataclass(slots=True)
class FounderProfile:
    archetype: FounderArchetype
    product_strength: float
    sales_strength: float
    operations_strength: float
    discipline: float
    stamina: float
    risk_tolerance: float


@dataclass(slots=True)
class CompanyStrategy:
    pricing_strategy: PricingStrategy
    channel_strategy: ChannelStrategy
    niche_focus: float
    automation_bias: float


@dataclass(slots=True)
class CompanyState:
    month_index: int
    stage: CompanyStage
    cash_balance: float
    monthly_revenue: float
    monthly_burn: float
    runway_months: float
    founder_energy: float
    capacity_points: float
    active_customers: int
    demand_signal: float
    product_maturity: float
    distribution_efficiency: float
    brand_awareness: float
    market_match: float
    customer_satisfaction: float
    backlog_units: float
    quality_score: float
    founder_workload: float
    cac_estimate: float
    unit_contribution_margin: float
    no_growth_months: int
    gross_margin: float
    learning_velocity: float
    final_outcome: CompanyFinalOutcome | None = None
    death_reason: str | None = None


@dataclass(slots=True)
class GeneratedCompany:
    company_index: int
    company_name: str
    founder_profile: FounderProfile
    strategy: CompanyStrategy
    market_noise: float
    starting_budget: float
    initial_state: CompanyState


@dataclass(slots=True)
class FounderAgentInput:
    month_index: int
    state: CompanyState
    founder_profile: FounderProfile
    strategy: CompanyStrategy
    viability_score: float
    confidence: float
    dimension_scores: dict[str, float]


@dataclass(slots=True)
class FounderAction:
    action_type: FounderActionType
    summary: str
    reason: str
    target_value: str | None = None
    magnitude: float | None = None


@dataclass(slots=True)
class FounderDecision:
    focus: FounderFocus
    objective: str
    note: str
    actions: list[FounderAction]
    selected_pricing_strategy: PricingStrategy
    selected_channel_strategy: ChannelStrategy
    target_niche_focus: float
    target_automation_bias: float
    hire_count: int
    pivot: bool
    effort_split: dict[str, float]


@dataclass(slots=True)
class MarketAgentInput:
    month_index: int
    state: CompanyState
    founder_profile: FounderProfile
    strategy: CompanyStrategy
    founder_decision: FounderDecision
    viability_score: float
    confidence: float
    dimension_scores: dict[str, float]
    market_noise: float


@dataclass(slots=True)
class MarketSignal:
    leads: int
    conversion_rate: float
    churn_rate: float
    repeat_rate: float
    satisfaction_delta: float
    competitive_pressure: float
    summary: str


@dataclass(slots=True)
class OperationsReport:
    delivery_capacity: float
    delivery_capacity_used: float
    delivered_work_units: float
    backlog_units: float
    backlog_delta: float
    quality_score: float
    quality_delta: float
    founder_workload: float
    automation_efficiency: float
    product_progress: float
    execution_quality: float
    summary: str


@dataclass(slots=True)
class FinanceReport:
    recognized_revenue: float
    operating_cost: float
    gross_profit: float
    net_profit: float
    cash_flow: float
    ending_cash_balance: float
    runway_months: float
    new_customers: int
    churned_customers: int
    cac: float
    contribution_margin_per_customer: float
    summary: str
    death_signals: list[str] = field(default_factory=list)


@dataclass(slots=True)
class JudgeReport:
    stage: CompanyStage
    outcome: CompanyFinalOutcome | None
    state_label: str
    score: float
    summary: str
    replay_log: str
    causes: list[str] = field(default_factory=list)
    death_reason: str | None = None
    success_reason: str | None = None


@dataclass(slots=True)
class OperationsAgentInput:
    month_index: int
    state: CompanyState
    founder_profile: FounderProfile
    strategy: CompanyStrategy
    founder_decision: FounderDecision
    market_signal: MarketSignal
    dimension_scores: dict[str, float]


@dataclass(slots=True)
class FinanceAgentInput:
    month_index: int
    state: CompanyState
    founder_profile: FounderProfile
    strategy: CompanyStrategy
    founder_decision: FounderDecision
    market_signal: MarketSignal
    operations_report: OperationsReport
    dimension_scores: dict[str, float]


@dataclass(slots=True)
class JudgeAgentInput:
    month_index: int
    previous_state: CompanyState
    current_state: CompanyState
    founder_decision: FounderDecision
    market_signal: MarketSignal
    operations_report: OperationsReport
    finance_report: FinanceReport
    viability_score: float
    confidence: float
    dimension_scores: dict[str, float]


@dataclass(slots=True)
class HeartbeatRecord:
    month_index: int
    state: CompanyState
    founder_decision: FounderDecision
    market_signal: MarketSignal
    operations_report: OperationsReport
    finance_report: FinanceReport
    judge_report: JudgeReport
    key_events: list[str] = field(default_factory=list)


@dataclass(slots=True)
class CompanySimulationResult:
    company: GeneratedCompany
    final_state: CompanyState
    heartbeat_records: list[HeartbeatRecord]


@dataclass(slots=True)
class SimulationContext:
    scenario_id: UUID
    one_line_pitch: str
    structured_inputs: dict[str, Any]
    viability_score: float
    dimension_scores: dict[str, float]
    confidence: float
    company_count: int
    duration_months: int
    seed: int = 7


@dataclass(slots=True)
class SimulationExecutionResult:
    companies: list[CompanySimulationResult]


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))
