from __future__ import annotations

from dataclasses import dataclass
from random import Random

from decision_os_backend.services.simulation_engine.domain import (
    ChannelStrategy,
    CompanyStage,
    FounderAction,
    FounderActionType,
    FounderAgentInput,
    FounderDecision,
    FounderFocus,
    PricingStrategy,
    clamp,
)


@dataclass(slots=True)
class FounderPolicy:
    low_runway_threshold: float = 3.0
    low_energy_threshold: float = 28.0
    high_demand_threshold: float = 0.68
    weak_demand_threshold: float = 0.42
    low_distribution_threshold: float = 0.48
    low_margin_threshold: float = 0.32
    high_capacity_threshold: float = 72.0
    hire_runway_threshold: float = 6.0
    hire_energy_threshold: float = 55.0
    automation_trigger_customers: int = 8
    pivot_month_threshold: int = 4


class FounderAgent:
    """State-driven founder operator that selects 1-2 monthly actions.

    The agent does not generate free-form plans. It evaluates the current company state,
    chooses a monthly operating focus, and emits a bounded action bundle that downstream
    modules can interpret deterministically.
    """

    def __init__(self, policy: FounderPolicy | None = None) -> None:
        self.policy = policy or FounderPolicy()

    def plan(self, agent_input: FounderAgentInput, rng: Random) -> FounderDecision:
        state = agent_input.state
        strategy = agent_input.strategy
        founder = agent_input.founder_profile
        metrics = agent_input.dimension_scores

        focus = self._choose_focus(agent_input)
        actions: list[FounderAction] = []

        pricing_strategy = strategy.pricing_strategy
        channel_strategy = strategy.channel_strategy
        niche_focus = strategy.niche_focus
        automation_bias = strategy.automation_bias
        hire_count = 0
        pivot = False

        demand_score = metrics.get("demand", 50.0)
        monetization_score = metrics.get("monetization", 50.0)
        distribution_score = metrics.get("distribution_feasibility", 50.0)
        differentiation_score = metrics.get("differentiation", 50.0)

        if state.runway_months < self.policy.low_runway_threshold or state.founder_energy < self.policy.low_energy_threshold:
            actions.append(
                FounderAction(
                    action_type=FounderActionType.FREEZE_HIRING,
                    summary="Freeze hiring and preserve cash.",
                    reason="Runway or founder energy is too low to safely add fixed costs.",
                )
            )

        if state.demand_signal < self.policy.weak_demand_threshold and state.month_index >= self.policy.pivot_month_threshold:
            if differentiation_score < 50 or monetization_score < 50:
                pivot = True
                actions.append(
                    FounderAction(
                        action_type=FounderActionType.PIVOT,
                        summary="Pivot the thesis to a tighter, higher-signal wedge.",
                        reason="Demand has remained weak long enough that the current line is unlikely to recover by incremental tuning.",
                        target_value="narrower wedge",
                    )
                )
                niche_focus = clamp(strategy.niche_focus + 0.18, 0.2, 0.98)

        if len(actions) < 2 and monetization_score < 60:
            pricing_strategy = self._choose_pricing_strategy(agent_input)
            actions.append(
                FounderAction(
                    action_type=FounderActionType.ADJUST_PRICING,
                    summary="Adjust pricing posture to improve willingness-to-pay signal.",
                    reason="Monetization remains too weak to trust without a clearer price experiment.",
                    target_value=pricing_strategy.value,
                )
            )

        if len(actions) < 2 and distribution_score < 60:
            channel_strategy = self._choose_channel_strategy(agent_input)
            actions.append(
                FounderAction(
                    action_type=FounderActionType.SHIFT_CHANNEL,
                    summary="Shift to a channel with better founder-channel fit.",
                    reason="Distribution feasibility is one of the weakest constraints in the current state.",
                    target_value=channel_strategy.value,
                )
            )

        if len(actions) < 2 and strategy.niche_focus < 0.7 and (demand_score < 70 or differentiation_score < 65):
            niche_focus = clamp(strategy.niche_focus + 0.14, 0.15, 0.98)
            actions.append(
                FounderAction(
                    action_type=FounderActionType.NARROW_ICP,
                    summary="Tighten ICP and stop trying to serve adjacent users.",
                    reason="The current state benefits more from sharper focus than from broader reach.",
                    magnitude=round(niche_focus - strategy.niche_focus, 3),
                )
            )

        if len(actions) < 2 and state.active_customers >= self.policy.automation_trigger_customers and automation_bias < 0.72:
            automation_bias = clamp(strategy.automation_bias + 0.16, 0.1, 0.95)
            actions.append(
                FounderAction(
                    action_type=FounderActionType.INCREASE_AUTOMATION,
                    summary="Increase automation on the repeatable workflow.",
                    reason="Customer count and delivery load are high enough that manual execution is starting to constrain the line.",
                    magnitude=round(automation_bias - strategy.automation_bias, 3),
                )
            )

        if len(actions) < 2 and self._should_hire(agent_input):
            hire_count = 1
            actions.append(
                FounderAction(
                    action_type=FounderActionType.HIRE,
                    summary="Add one constrained operator to expand execution capacity.",
                    reason="The line has enough runway, energy, and demand signal to support a small capacity increase.",
                    target_value="1 operator",
                )
            )

        if len(actions) < 2 and strategy.niche_focus > 0.86 and state.demand_signal > self.policy.high_demand_threshold and distribution_score >= 70:
            broaden_delta = -0.08
            niche_focus = clamp(strategy.niche_focus + broaden_delta, 0.15, 0.98)
            actions.append(
                FounderAction(
                    action_type=FounderActionType.BROADEN_ICP,
                    summary="Expand ICP slightly to test adjacent pull without breaking the wedge.",
                    reason="The current line is focused enough that a controlled expansion may reveal scalable demand.",
                    magnitude=round(abs(broaden_delta), 3),
                )
            )

        if not actions:
            actions.append(
                FounderAction(
                    action_type=FounderActionType.HOLD,
                    summary="Hold the current operating line and keep compounding the existing loop.",
                    reason="The state does not justify a major strategic change this month.",
                )
            )

        if len(actions) > 2:
            actions = actions[:2]

        objective = self._build_objective(focus)
        note = (
            f"Founder selects {len(actions)} action(s) at month={state.month_index}, "
            f"stage={state.stage.value}, runway={state.runway_months:.1f}, energy={state.founder_energy:.1f}."
        )

        effort_split = self._build_effort_split(founder, focus, rng)

        return FounderDecision(
            focus=focus,
            objective=objective,
            note=note,
            actions=actions,
            selected_pricing_strategy=pricing_strategy,
            selected_channel_strategy=channel_strategy,
            target_niche_focus=round(niche_focus, 3),
            target_automation_bias=round(automation_bias, 3),
            hire_count=hire_count,
            pivot=pivot,
            effort_split=effort_split,
        )

    def _choose_focus(self, agent_input: FounderAgentInput) -> FounderFocus:
        state = agent_input.state
        metrics = agent_input.dimension_scores

        if state.runway_months < self.policy.low_runway_threshold or state.founder_energy < self.policy.low_energy_threshold:
            return FounderFocus.RETRENCH
        if state.stage == CompanyStage.EXPLORE:
            return FounderFocus.PRICING if metrics.get("monetization", 50.0) < 65 else FounderFocus.DISCOVERY
        if state.stage == CompanyStage.SURVIVE:
            return FounderFocus.DISTRIBUTION if metrics.get("distribution_feasibility", 50.0) < 68 else FounderFocus.DELIVERY
        if state.active_customers >= self.policy.automation_trigger_customers and agent_input.strategy.automation_bias < 0.72:
            return FounderFocus.AUTOMATION
        return FounderFocus.DISTRIBUTION

    def _choose_pricing_strategy(self, agent_input: FounderAgentInput) -> PricingStrategy:
        state = agent_input.state
        current = agent_input.strategy.pricing_strategy

        if state.monthly_revenue < state.monthly_burn and current != PricingStrategy.SUBSCRIPTION:
            return PricingStrategy.SUBSCRIPTION
        if state.demand_signal > 0.65 and current == PricingStrategy.PILOT_FIRST:
            return PricingStrategy.SUBSCRIPTION
        if state.active_customers >= 12:
            return PricingStrategy.USAGE_BASED
        return PricingStrategy.PILOT_FIRST

    def _choose_channel_strategy(self, agent_input: FounderAgentInput) -> ChannelStrategy:
        founder = agent_input.founder_profile
        if founder.sales_strength >= 0.72:
            return ChannelStrategy.OUTBOUND
        if founder.operations_strength >= 0.72:
            return ChannelStrategy.PARTNERSHIP
        if founder.product_strength >= 0.75:
            return ChannelStrategy.CONTENT
        return ChannelStrategy.FOUNDER_LED

    def _should_hire(self, agent_input: FounderAgentInput) -> bool:
        state = agent_input.state
        metrics = agent_input.dimension_scores
        return (
            state.runway_months >= self.policy.hire_runway_threshold
            and state.founder_energy >= self.policy.hire_energy_threshold
            and state.capacity_points <= self.policy.high_capacity_threshold
            and state.active_customers >= 8
            and state.monthly_revenue >= state.monthly_burn * 0.8
            and metrics.get("founder_fit", 50.0) >= 60
        )

    def _build_objective(self, focus: FounderFocus) -> str:
        if focus == FounderFocus.RETRENCH:
            return "Protect runway and stabilize the line before compounding more commitments."
        if focus == FounderFocus.PRICING:
            return "Turn demand signal into clearer willingness-to-pay proof."
        if focus == FounderFocus.DISCOVERY:
            return "Sharpen the wedge and remove remaining uncertainty around the user and pain."
        if focus == FounderFocus.DELIVERY:
            return "Make the current operating loop more repeatable and less bespoke."
        if focus == FounderFocus.AUTOMATION:
            return "Productize only the repeatable parts of the workflow."
        return "Improve acquisition efficiency without sacrificing wedge clarity."

    def _build_effort_split(self, founder_profile, focus: FounderFocus, rng: Random) -> dict[str, float]:
        product = founder_profile.product_strength * 0.38
        gtm = founder_profile.sales_strength * 0.38
        ops = founder_profile.operations_strength * 0.32

        if focus == FounderFocus.PRICING:
            gtm += 0.18
        elif focus == FounderFocus.DISCOVERY:
            gtm += 0.10
            product += 0.08
        elif focus == FounderFocus.DELIVERY:
            ops += 0.16
        elif focus == FounderFocus.AUTOMATION:
            product += 0.18
        elif focus == FounderFocus.RETRENCH:
            ops += 0.12

        raw = {
            "product": product + rng.uniform(-0.04, 0.04),
            "gtm": gtm + rng.uniform(-0.04, 0.04),
            "ops": ops + rng.uniform(-0.03, 0.03),
        }
        total = sum(max(0.1, value) for value in raw.values())
        return {key: round(max(0.1, value) / total, 2) for key, value in raw.items()}
