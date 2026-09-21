from __future__ import annotations

from dataclasses import dataclass

from decision_os_backend.models.enums import CompanyFinalOutcome
from decision_os_backend.services.simulation_engine.domain import (
    CompanyStage,
    CompanyState,
    FinanceReport,
    MarketSignal,
    OperationsReport,
    clamp,
)


@dataclass(slots=True)
class DeathDecision:
    is_dead: bool
    death_reason: str | None
    causes: list[str]


def evaluate_death_conditions(
    state: CompanyState,
    finance_report: FinanceReport,
    operations_report: OperationsReport,
    market_signal: MarketSignal,
) -> DeathDecision:
    causes: list[str] = []
    death_reason: str | None = None

    if finance_report.ending_cash_balance <= 0:
        death_reason = "cash_exhausted"
        causes.append("Cash balance falls to zero or below.")

    if death_reason is None and finance_report.runway_months <= 1.0 and finance_report.net_profit < 0 and state.no_growth_months >= 1:
        death_reason = "runway_no_recovery"
        causes.append("Runway is critically low and the line shows no realistic short-term recovery path.")

    if death_reason is None and finance_report.cac > finance_report.contribution_margin_per_customer and state.no_growth_months >= 2:
        death_reason = "cac_above_contribution_margin"
        causes.append("Customer acquisition cost remains above contribution margin for too long.")

    if death_reason is None and state.no_growth_months >= 3 and market_signal.leads < 8 and finance_report.new_customers == 0:
        death_reason = "no_growth_no_traction"
        causes.append("The company experiences multiple months of stagnation without meaningful traction recovery.")

    if death_reason is None and operations_report.backlog_units > operations_report.delivery_capacity * 1.35 and market_signal.churn_rate >= 0.18:
        death_reason = "delivery_collapse"
        causes.append("Backlog overload triggers delivery collapse and churn accelerates sharply.")

    if death_reason is None and state.founder_energy <= 10:
        death_reason = "founder_energy_collapse"
        causes.append("Founder energy falls below a sustainable operating threshold.")

    if death_reason is None and finance_report.gross_profit <= 0 and finance_report.contribution_margin_per_customer <= 0:
        death_reason = "business_model_non_viable"
        causes.append("The business model cannot close the loop because each customer is structurally unprofitable.")

    return DeathDecision(is_dead=death_reason is not None, death_reason=death_reason, causes=causes)


def determine_stage(state: CompanyState, finance_report: FinanceReport, market_signal: MarketSignal) -> tuple[CompanyStage, CompanyFinalOutcome, str | None]:
    if state.cash_balance <= 0:
        return CompanyStage.DEAD, CompanyFinalOutcome.DEAD, None

    if (
        finance_report.net_profit > 0
        and state.runway_months >= 10
        and state.brand_awareness >= 0.42
        and state.distribution_efficiency >= 0.68
        and state.customer_satisfaction >= 0.68
    ):
        return CompanyStage.SCALABLE, CompanyFinalOutcome.SCALABLE, "The line compounds efficiently enough to support scale."

    if (
        finance_report.net_profit >= 0
        and state.runway_months >= 6
        and state.customer_satisfaction >= 0.58
        and state.quality_score >= 0.56
        and state.unit_contribution_margin > max(state.cac_estimate, 1.0)
    ):
        return CompanyStage.SUSTAINABLE, CompanyFinalOutcome.SUSTAINABLE, "The company has reached a durable operating loop."

    if state.runway_months >= 3 and (market_signal.leads >= 12 or finance_report.recognized_revenue > 0):
        return CompanyStage.SURVIVE, CompanyFinalOutcome.SURVIVE, "The company is alive, but still solving for consistency and recovery margin."

    return CompanyStage.EXPLORE, CompanyFinalOutcome.EXPLORE, "The line is still exploring whether it can become a repeatable business."


def build_state_score(state: CompanyState, finance_report: FinanceReport, market_signal: MarketSignal, viability_score: float) -> float:
    raw_score = (
        viability_score * 0.28
        + state.demand_signal * 17.0
        + state.market_match * 13.0
        + state.customer_satisfaction * 12.0
        + state.quality_score * 10.0
        + state.distribution_efficiency * 11.0
        + clamp(finance_report.net_profit / max(finance_report.operating_cost, 1.0), -1.0, 1.0) * 10.0
        + min(state.runway_months, 12.0) * 1.2
        - state.founder_workload * 8.0
        - market_signal.competitive_pressure * 10.0
    )
    return round(clamp(raw_score, 0.0, 100.0), 2)


def build_state_label(stage: CompanyStage) -> str:
    return stage.value.capitalize()
