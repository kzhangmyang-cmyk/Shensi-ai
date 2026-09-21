from __future__ import annotations

from dataclasses import asdict, is_dataclass, replace
from enum import Enum
from random import Random
from typing import Any, cast

from decision_os_backend.models.enums import CompanyFinalOutcome
from decision_os_backend.services.simulation_engine.agents import FinanceAgent, JudgeAgent, MarketAgent, OperationsAgent
from decision_os_backend.services.simulation_engine.company_generator import CompanyGenerator
from decision_os_backend.services.simulation_engine.domain import (
    ChannelStrategy,
    CompanySimulationResult,
    CompanyStage,
    CompanyState,
    CompanyStrategy,
    FinanceAgentInput,
    FounderActionType,
    FounderAgentInput,
    HeartbeatRecord,
    JudgeAgentInput,
    MarketAgentInput,
    OperationsAgentInput,
    PricingStrategy,
    SimulationContext,
    SimulationExecutionResult,
    clamp,
)
from decision_os_backend.services.simulation_engine.founder_agent import FounderAgent


class SimulationRunner:
    """Runs the state-driven monthly heartbeat simulation across generated companies.

    Monthly heartbeat order:
    1. Founder Agent chooses focus for the month.
    2. Market Agent applies market response and external noise.
    3. Operations Agent converts focus into delivery and product progress.
    4. Finance Agent closes the month and updates cash/runway.
    5. Judge Agent evaluates the new state and stage transition.
    """

    def __init__(
        self,
        company_generator: CompanyGenerator | None = None,
        founder_agent: FounderAgent | None = None,
        market_agent: MarketAgent | None = None,
        operations_agent: OperationsAgent | None = None,
        finance_agent: FinanceAgent | None = None,
        judge_agent: JudgeAgent | None = None,
    ) -> None:
        self.company_generator = company_generator or CompanyGenerator()
        self.founder_agent = founder_agent or FounderAgent()
        self.market_agent = market_agent or MarketAgent()
        self.operations_agent = operations_agent or OperationsAgent()
        self.finance_agent = finance_agent or FinanceAgent()
        self.judge_agent = judge_agent or JudgeAgent()

    def run(self, context: SimulationContext) -> SimulationExecutionResult:
        generated_companies = self.company_generator.generate_companies(context)
        results = [self.run_company(company=company, context=context) for company in generated_companies]
        return SimulationExecutionResult(companies=results)

    def run_company(self, company, context: SimulationContext) -> CompanySimulationResult:
        rng = Random(context.seed + company.company_index * 13)
        current_state = company.initial_state
        current_strategy = company.strategy
        records: list[HeartbeatRecord] = []

        for month_index in range(1, context.duration_months + 1):
            if current_state.stage == CompanyStage.DEAD:
                break

            current_state = self._advance_month_index(current_state, month_index)
            founder_input = FounderAgentInput(
                month_index=month_index,
                state=current_state,
                founder_profile=company.founder_profile,
                strategy=current_strategy,
                viability_score=context.viability_score,
                confidence=context.confidence,
                dimension_scores=context.dimension_scores,
            )
            founder_decision = self.founder_agent.plan(founder_input, rng)
            current_strategy = self._apply_founder_decision(current_strategy, founder_decision)
            market_input = MarketAgentInput(
                month_index=month_index,
                state=current_state,
                founder_profile=company.founder_profile,
                strategy=current_strategy,
                founder_decision=founder_decision,
                viability_score=context.viability_score,
                confidence=context.confidence,
                dimension_scores=context.dimension_scores,
                market_noise=company.market_noise,
            )
            market_signal = self.market_agent.react(market_input, rng)
            operations_input = OperationsAgentInput(
                month_index=month_index,
                state=current_state,
                founder_profile=company.founder_profile,
                strategy=current_strategy,
                founder_decision=founder_decision,
                market_signal=market_signal,
                dimension_scores=context.dimension_scores,
            )
            operations_report = self.operations_agent.execute(operations_input, rng)
            finance_input = FinanceAgentInput(
                month_index=month_index,
                state=current_state,
                founder_profile=company.founder_profile,
                strategy=current_strategy,
                founder_decision=founder_decision,
                market_signal=market_signal,
                operations_report=operations_report,
                dimension_scores=context.dimension_scores,
            )
            finance_report = self.finance_agent.close_month(finance_input, rng)
            next_state = self._update_state(current_state, current_strategy, founder_decision, market_signal, operations_report, finance_report)
            judge_input = JudgeAgentInput(
                month_index=month_index,
                previous_state=current_state,
                current_state=next_state,
                founder_decision=founder_decision,
                market_signal=market_signal,
                operations_report=operations_report,
                finance_report=finance_report,
                viability_score=context.viability_score,
                confidence=context.confidence,
                dimension_scores=context.dimension_scores,
            )
            judge_report = self.judge_agent.evaluate(judge_input)
            next_state.stage = judge_report.stage
            next_state.final_outcome = judge_report.outcome
            next_state.death_reason = judge_report.death_reason

            key_events = self._collect_key_events(next_state, founder_decision, judge_report)
            record = HeartbeatRecord(
                month_index=month_index,
                state=next_state,
                founder_decision=founder_decision,
                market_signal=market_signal,
                operations_report=operations_report,
                finance_report=finance_report,
                judge_report=judge_report,
                key_events=key_events,
            )
            records.append(record)
            current_state = next_state

        if records and current_state.stage != CompanyStage.DEAD and current_state.final_outcome is None:
            current_state.final_outcome = CompanyFinalOutcome.SURVIVE

        return CompanySimulationResult(company=company, final_state=current_state, heartbeat_records=records)

    def _advance_month_index(self, state: CompanyState, month_index: int) -> CompanyState:
        next_state = replace(state)
        next_state.month_index = month_index
        return next_state

    def _apply_founder_decision(self, strategy: CompanyStrategy, founder_decision) -> CompanyStrategy:
        return CompanyStrategy(
            pricing_strategy=PricingStrategy(founder_decision.selected_pricing_strategy),
            channel_strategy=ChannelStrategy(founder_decision.selected_channel_strategy),
            niche_focus=founder_decision.target_niche_focus,
            automation_bias=founder_decision.target_automation_bias,
        )

    def _update_state(self, state: CompanyState, strategy: CompanyStrategy, founder_decision, market_signal, operations_report, finance_report) -> CompanyState:
        next_state = replace(state)
        lead_signal = min(1.0, market_signal.leads / 120.0)
        next_state.demand_signal = round(clamp(state.demand_signal * 0.55 + lead_signal * 0.25 + market_signal.conversion_rate * 0.2, 0.0, 1.0), 3)
        next_state.product_maturity = round(clamp(state.product_maturity + operations_report.product_progress + (0.03 if founder_decision.pivot else 0.0), 0.0, 1.0), 3)
        next_state.distribution_efficiency = round(clamp(state.distribution_efficiency + market_signal.conversion_rate * 0.18 - market_signal.competitive_pressure * 0.06, 0.0, 1.0), 3)
        next_state.brand_awareness = round(
            clamp(
                state.brand_awareness
                + min(0.12, market_signal.leads / 500.0)
                + (0.03 if strategy.channel_strategy.value in {"content", "community"} else 0.0),
                0.0,
                1.0,
            ),
            3,
        )
        next_state.market_match = round(clamp(state.market_match + (0.04 if any(action.action_type == FounderActionType.NARROW_ICP for action in founder_decision.actions) else 0.0) - (0.03 if any(action.action_type == FounderActionType.BROADEN_ICP for action in founder_decision.actions) else 0.0) + market_signal.satisfaction_delta * 0.35, 0.0, 1.0), 3)
        next_state.customer_satisfaction = round(clamp(state.customer_satisfaction + market_signal.satisfaction_delta, 0.0, 1.0), 3)
        next_state.monthly_revenue = round(finance_report.recognized_revenue, 2)
        next_state.monthly_burn = round(max(2_000.0, finance_report.operating_cost), 2)
        next_state.cash_balance = round(finance_report.ending_cash_balance, 2)
        next_state.runway_months = finance_report.runway_months
        next_state.capacity_points = round(clamp(state.capacity_points - operations_report.delivery_capacity_used * 0.06 + 10.0 + founder_decision.hire_count * 14.0, 0.0, 100.0), 2)
        next_state.founder_energy = round(
            clamp(
                state.founder_energy
                - operations_report.founder_workload * 18.0
                + 6.0
                + (4.0 if founder_decision.actions and founder_decision.actions[0].action_type == FounderActionType.HOLD else 0.0)
                - (3.0 if founder_decision.pivot else 0.0),
                0.0,
                100.0,
            ),
            2,
        )
        next_state.backlog_units = round(operations_report.backlog_units, 2)
        next_state.quality_score = round(operations_report.quality_score, 3)
        next_state.founder_workload = round(operations_report.founder_workload, 3)
        next_state.cac_estimate = round(finance_report.cac, 2)
        next_state.unit_contribution_margin = round(finance_report.contribution_margin_per_customer, 2)
        next_state.gross_margin = round(clamp(finance_report.gross_profit / max(finance_report.recognized_revenue, 1.0), -0.5, 0.92), 3)
        next_state.learning_velocity = round(clamp(state.learning_velocity + 0.02 if market_signal.leads > 20 else state.learning_velocity - 0.01, 0.0, 1.0), 3)
        next_state.active_customers = max(0, state.active_customers + finance_report.new_customers - finance_report.churned_customers)
        growth_trigger = finance_report.recognized_revenue > state.monthly_revenue * 1.03 or finance_report.new_customers > 0
        next_state.no_growth_months = 0 if growth_trigger else state.no_growth_months + 1
        if strategy.niche_focus >= 0.82 and next_state.stage == CompanyStage.EXPLORE:
            next_state.stage = CompanyStage.SURVIVE
        return next_state

    def _collect_key_events(self, state: CompanyState, founder_decision, judge_report) -> list[str]:
        events: list[str] = [f"Founder focus: {founder_decision.focus.value}"]
        if state.runway_months < 3:
            events.append("Runway pressure becomes critical.")
        if state.monthly_revenue >= state.monthly_burn:
            events.append("Revenue covers burn for the current month.")
        if judge_report.stage == CompanyStage.SCALABLE:
            events.append("The line enters a scalable state.")
        if judge_report.stage == CompanyStage.DEAD:
            events.append(f"The line dies due to {judge_report.death_reason or 'terminal constraint failure'}.")
        return events


def to_snapshot_state_payload(record: HeartbeatRecord) -> dict[str, Any]:
    return _to_jsonable(
        {
            "month_index": record.month_index,
            "state": record.state,
            "founder_decision": record.founder_decision,
            "market_signal": record.market_signal,
            "operations_report": record.operations_report,
            "finance_report": record.finance_report,
            "judge_report": record.judge_report,
            "key_events": record.key_events,
        }
    )


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value) and not isinstance(value, type):
        return {key: _to_jsonable(item) for key, item in asdict(cast(Any, value)).items()}
    if isinstance(value, dict):
        return {key: _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_jsonable(item) for item in value]
    return value
