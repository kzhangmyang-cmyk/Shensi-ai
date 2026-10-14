from __future__ import annotations

from dataclasses import dataclass
from random import Random

from decision_os_backend.services.simulation_engine.domain import (
    ChannelStrategy,
    FounderActionType,
    FounderFocus,
    MarketAgentInput,
    MarketSignal,
    PricingStrategy,
    clamp,
)


@dataclass(slots=True)
class MarketPolicy:
    base_leads: float = 14.0
    awareness_lead_multiplier: float = 48.0
    demand_lead_multiplier: float = 34.0
    channel_lead_multiplier: float = 28.0
    competition_lead_penalty: float = 22.0
    noise_lead_multiplier: float = 18.0
    max_conversion_rate: float = 0.42
    max_churn_rate: float = 0.32
    max_repeat_rate: float = 0.58
    max_satisfaction_delta: float = 0.18


class MarketAgent:
    """Aggregated market feedback model for a single monthly heartbeat.

    The module does not simulate individual customers. It converts current state,
    strategy, founder action, and assessment priors into market outcomes like leads,
    conversion, churn, repeat behavior, and customer satisfaction movement.
    """

    def __init__(self, policy: MarketPolicy | None = None) -> None:
        self.policy = policy or MarketPolicy()

    def react(self, agent_input: MarketAgentInput, rng: Random) -> MarketSignal:
        state = agent_input.state
        strategy = agent_input.strategy
        founder = agent_input.founder_profile
        decision = agent_input.founder_decision
        priors = agent_input.dimension_scores

        pricing_fit = self._pricing_fit(agent_input)
        channel_fit = self._channel_fit(agent_input)
        market_match = self._market_match(agent_input)
        competition_pressure = self._competition_pressure(agent_input, rng)

        leads = int(
            max(
                0.0,
                self.policy.base_leads
                + state.brand_awareness * self.policy.awareness_lead_multiplier
                + state.demand_signal * self.policy.demand_lead_multiplier
                + channel_fit * self.policy.channel_lead_multiplier
                + market_match * 16.0
                - competition_pressure * self.policy.competition_lead_penalty
                + agent_input.market_noise * self.policy.noise_lead_multiplier
                + rng.uniform(-4.0, 5.0),
            )
        )

        adoption_friction_penalty = max(0.0, (55.0 - priors.get("adoption_friction", 55.0)) / 100.0)
        conversion_rate = clamp(
            0.03
            + market_match * 0.14
            + pricing_fit * 0.08
            + channel_fit * 0.05
            + state.customer_satisfaction * 0.04
            - competition_pressure * 0.09
            - adoption_friction_penalty * 0.12
            + rng.uniform(-0.015, 0.015),
            0.01,
            self.policy.max_conversion_rate,
        )

        churn_rate = clamp(
            0.02
            + competition_pressure * 0.08
            + max(0.0, 0.55 - state.customer_satisfaction) * 0.16
            + max(0.0, 0.5 - pricing_fit) * 0.10
            - market_match * 0.05
            + rng.uniform(-0.01, 0.015),
            0.01,
            self.policy.max_churn_rate,
        )

        repeat_rate = clamp(
            0.06
            + state.customer_satisfaction * 0.24
            + market_match * 0.16
            + (0.05 if strategy.pricing_strategy == PricingStrategy.SUBSCRIPTION else 0.0)
            - churn_rate * 0.35
            + rng.uniform(-0.015, 0.02),
            0.02,
            self.policy.max_repeat_rate,
        )

        satisfaction_delta = clamp(
            (market_match - 0.5) * 0.12
            + (0.05 if decision.focus == FounderFocus.DELIVERY else 0.0)
            + (0.04 if any(action.action_type == FounderActionType.INCREASE_AUTOMATION for action in decision.actions) else 0.0)
            - (0.05 if any(action.action_type == FounderActionType.BROADEN_ICP for action in decision.actions) else 0.0)
            - (0.04 if pricing_fit < 0.45 else 0.0)
            + rng.uniform(-0.03, 0.03),
            -self.policy.max_satisfaction_delta,
            self.policy.max_satisfaction_delta,
        )

        return MarketSignal(
            leads=leads,
            conversion_rate=round(conversion_rate, 3),
            churn_rate=round(churn_rate, 3),
            repeat_rate=round(repeat_rate, 3),
            satisfaction_delta=round(satisfaction_delta, 3),
            competitive_pressure=round(competition_pressure, 3),
            summary="Market feedback reflects pricing fit, channel effectiveness, wedge match, brand awareness, and competitive pressure under noise.",
        )

    def _pricing_fit(self, agent_input: MarketAgentInput) -> float:
        strategy = agent_input.strategy
        state = agent_input.state
        monetization_prior = agent_input.dimension_scores.get("monetization", 50.0) / 100.0
        maturity = state.product_maturity

        if strategy.pricing_strategy == PricingStrategy.PILOT_FIRST:
            fit = 0.72 if maturity < 0.55 else 0.58
        elif strategy.pricing_strategy == PricingStrategy.SUBSCRIPTION:
            fit = 0.48 + maturity * 0.35
        else:
            fit = 0.36 + maturity * 0.40

        if any(action.action_type == FounderActionType.ADJUST_PRICING for action in agent_input.founder_decision.actions):
            fit += 0.07

        return clamp(fit + monetization_prior * 0.18, 0.05, 0.98)

    def _channel_fit(self, agent_input: MarketAgentInput) -> float:
        strategy = agent_input.strategy
        founder = agent_input.founder_profile
        base = 0.32

        if strategy.channel_strategy == ChannelStrategy.FOUNDER_LED:
            base += founder.sales_strength * 0.35
        elif strategy.channel_strategy == ChannelStrategy.OUTBOUND:
            base += founder.sales_strength * 0.42
        elif strategy.channel_strategy == ChannelStrategy.COMMUNITY:
            base += max(founder.sales_strength, founder.operations_strength) * 0.28
        elif strategy.channel_strategy == ChannelStrategy.CONTENT:
            base += founder.product_strength * 0.24
        elif strategy.channel_strategy == ChannelStrategy.PARTNERSHIP:
            base += founder.operations_strength * 0.34

        if any(action.action_type == FounderActionType.SHIFT_CHANNEL for action in agent_input.founder_decision.actions):
            base += 0.06

        distribution_prior = agent_input.dimension_scores.get("distribution_feasibility", 50.0) / 100.0
        return clamp(base + distribution_prior * 0.22, 0.05, 0.98)

    def _market_match(self, agent_input: MarketAgentInput) -> float:
        state = agent_input.state
        strategy = agent_input.strategy
        problem_prior = agent_input.dimension_scores.get("problem_severity", 50.0) / 100.0
        demand_prior = agent_input.dimension_scores.get("demand", 50.0) / 100.0

        fit = state.market_match * 0.55 + strategy.niche_focus * 0.22 + problem_prior * 0.15 + demand_prior * 0.08

        for action in agent_input.founder_decision.actions:
            if action.action_type == FounderActionType.NARROW_ICP:
                fit += 0.08
            if action.action_type == FounderActionType.BROADEN_ICP:
                fit -= 0.05
            if action.action_type == FounderActionType.PIVOT:
                fit += 0.03

        return clamp(fit, 0.05, 0.99)

    def _competition_pressure(self, agent_input: MarketAgentInput, rng: Random) -> float:
        differentiation_prior = agent_input.dimension_scores.get("differentiation", 50.0) / 100.0
        competition_score = agent_input.dimension_scores.get("competitive_pressure", 50.0) / 100.0
        state = agent_input.state
        strategy = agent_input.strategy

        pressure = (
            0.28
            + (1.0 - competition_score) * 0.30
            + (1.0 - differentiation_prior) * 0.24
            + (1.0 - strategy.niche_focus) * 0.18
            + (0.06 if state.brand_awareness < 0.15 else 0.0)
            + agent_input.market_noise * 0.18
            + rng.uniform(-0.03, 0.05)
        )
        return clamp(pressure, 0.05, 0.98)
