from __future__ import annotations

from dataclasses import dataclass
from random import Random

from decision_os_backend.services.simulation_engine.domain import (
    ChannelStrategy,
    FinanceAgentInput,
    FinanceReport,
    FounderActionType,
    PricingStrategy,
    clamp,
)


@dataclass(slots=True)
class FinancePolicy:
    base_payroll_ratio: float = 0.44
    hire_cost: float = 4_500.0
    pivot_cost: float = 2_500.0
    automation_investment: float = 1_600.0
    min_runway_if_profitable: float = 18.0


class FinanceAgent:
    """Converts market and operational state into business economics.

    Outputs are tuned for persistence in MonthlySnapshot and for direct front-end replay.
    """

    def __init__(self, policy: FinancePolicy | None = None) -> None:
        self.policy = policy or FinancePolicy()

    def close_month(self, agent_input: FinanceAgentInput, rng: Random) -> FinanceReport:
        state = agent_input.state
        strategy = agent_input.strategy
        decision = agent_input.founder_decision
        market = agent_input.market_signal
        ops = agent_input.operations_report
        priors = agent_input.dimension_scores

        average_contract_value = self._average_contract_value(strategy.pricing_strategy, priors.get("monetization", 50.0))
        new_customers = int(market.leads * market.conversion_rate)
        churned_customers = int(state.active_customers * market.churn_rate)
        retained_customers = max(0, state.active_customers - churned_customers)
        repeat_customers = int(retained_customers * market.repeat_rate)

        recognized_revenue = max(
            0.0,
            retained_customers * average_contract_value
            + new_customers * average_contract_value * 0.78
            + repeat_customers * average_contract_value * 0.34
            + rng.uniform(-350.0, 420.0),
        )

        delivery_cost_per_unit = max(40.0, 150.0 * (1.0 - ops.automation_efficiency * 0.42) + max(0.0, ops.backlog_units - ops.delivery_capacity) * 2.0)
        variable_delivery_cost = ops.delivered_work_units * delivery_cost_per_unit

        channel_cost_per_lead = {
            ChannelStrategy.FOUNDER_LED: 42.0,
            ChannelStrategy.COMMUNITY: 55.0,
            ChannelStrategy.CONTENT: 68.0,
            ChannelStrategy.OUTBOUND: 92.0,
            ChannelStrategy.PARTNERSHIP: 75.0,
        }[strategy.channel_strategy]
        acquisition_spend = market.leads * channel_cost_per_lead

        payroll_cost = state.monthly_burn * self.policy.base_payroll_ratio + decision.hire_count * self.policy.hire_cost
        tooling_cost = 650.0 + strategy.automation_bias * 850.0
        strategic_investment = (
            (self.policy.automation_investment if any(action.action_type == FounderActionType.INCREASE_AUTOMATION for action in decision.actions) else 0.0)
            + (self.policy.pivot_cost if decision.pivot else 0.0)
        )

        operating_cost = variable_delivery_cost + acquisition_spend + payroll_cost + tooling_cost + strategic_investment
        gross_profit = recognized_revenue - variable_delivery_cost
        net_profit = recognized_revenue - operating_cost
        cash_flow = net_profit
        ending_cash_balance = state.cash_balance + cash_flow

        active_customer_base = max(1, retained_customers + new_customers)
        contribution_margin_per_customer = (recognized_revenue - variable_delivery_cost) / active_customer_base
        cac = acquisition_spend / max(new_customers, 1)

        if net_profit >= 0:
            runway_months = self.policy.min_runway_if_profitable
        else:
            runway_months = max(0.0, ending_cash_balance / max(abs(net_profit), 1.0))

        death_signals: list[str] = []
        if ending_cash_balance <= 0:
            death_signals.append("cash_balance<=0")
        if runway_months <= 1.0 and net_profit < 0 and state.no_growth_months >= 1:
            death_signals.append("runway_low_no_recovery")
        if cac > contribution_margin_per_customer and state.no_growth_months >= 2:
            death_signals.append("cac_above_margin")
        if state.no_growth_months >= 3 and new_customers == 0 and market.leads < 8:
            death_signals.append("no_growth_no_traction")
        if ops.backlog_units > ops.delivery_capacity * 1.35 and market.churn_rate > 0.18:
            death_signals.append("delivery_collapse")
        if state.founder_energy <= 10:
            death_signals.append("founder_energy_collapse")
        if gross_profit <= 0 and contribution_margin_per_customer <= 0:
            death_signals.append("business_model_non_viable")

        summary = (
            "Finance closes with a viable loop this month."
            if net_profit >= 0 and ending_cash_balance > 0
            else "Finance closes under pressure; cash, CAC, or margin remain fragile."
        )

        return FinanceReport(
            recognized_revenue=round(recognized_revenue, 2),
            operating_cost=round(operating_cost, 2),
            gross_profit=round(gross_profit, 2),
            net_profit=round(net_profit, 2),
            cash_flow=round(cash_flow, 2),
            ending_cash_balance=round(max(0.0, ending_cash_balance), 2),
            runway_months=round(runway_months, 2),
            new_customers=new_customers,
            churned_customers=churned_customers,
            cac=round(cac, 2),
            contribution_margin_per_customer=round(contribution_margin_per_customer, 2),
            death_signals=death_signals,
            summary=summary,
        )

    def _average_contract_value(self, pricing_strategy: PricingStrategy, monetization_score: float) -> float:
        if pricing_strategy == PricingStrategy.SUBSCRIPTION:
            return 1_250.0 + monetization_score * 6.0
        if pricing_strategy == PricingStrategy.USAGE_BASED:
            return 780.0 + monetization_score * 4.0
        return 620.0 + monetization_score * 3.5
