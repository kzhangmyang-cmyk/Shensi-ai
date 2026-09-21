from __future__ import annotations

from dataclasses import dataclass
from random import Random

from decision_os_backend.services.simulation_engine.domain import (
    FounderActionType,
    FounderFocus,
    OperationsAgentInput,
    OperationsReport,
    clamp,
)


@dataclass(slots=True)
class OperationsPolicy:
    base_capacity_multiplier: float = 1.1
    automation_capacity_multiplier: float = 0.55
    backlog_penalty_multiplier: float = 0.08
    quality_recovery_bonus: float = 0.05
    quality_collapse_penalty: float = 0.09


class OperationsAgent:
    """Aggregates delivery capability, backlog pressure, quality, and workload.

    The module is deterministic enough for replay and tuning, but noisy enough to avoid
    unrealistically smooth execution.
    """

    def __init__(self, policy: OperationsPolicy | None = None) -> None:
        self.policy = policy or OperationsPolicy()

    def execute(self, agent_input: OperationsAgentInput, rng: Random) -> OperationsReport:
        state = agent_input.state
        founder = agent_input.founder_profile
        strategy = agent_input.strategy
        decision = agent_input.founder_decision
        market_signal = agent_input.market_signal

        automation_efficiency = clamp(0.22 + strategy.automation_bias * 0.68, 0.08, 0.96)
        delivery_capacity = clamp(
            state.capacity_points
            * (self.policy.base_capacity_multiplier + founder.operations_strength * 0.35 + automation_efficiency * self.policy.automation_capacity_multiplier)
            * (0.55 + state.founder_energy / 120.0),
            8.0,
            180.0,
        )

        incoming_work_units = max(
            0.0,
            state.active_customers * (1.1 + market_signal.repeat_rate * 0.25)
            + market_signal.leads * market_signal.conversion_rate * 0.95
            + (3.0 if decision.pivot else 0.0),
        )
        delivered_work_units = min(delivery_capacity, state.backlog_units + incoming_work_units)
        backlog_units = max(0.0, state.backlog_units + incoming_work_units - delivered_work_units)
        backlog_delta = backlog_units - state.backlog_units

        founder_workload = clamp(
            0.18
            + (incoming_work_units + backlog_units * 0.55) * (1.0 - automation_efficiency) * 0.018
            + decision.effort_split["ops"] * 0.34
            + (0.07 if decision.hire_count > 0 else 0.0)
            + rng.uniform(-0.03, 0.04),
            0.05,
            1.35,
        )

        backlog_pressure = backlog_units / max(delivery_capacity, 1.0)
        quality_delta = (
            founder.operations_strength * 0.06
            + automation_efficiency * 0.05
            + (self.policy.quality_recovery_bonus if decision.focus == FounderFocus.DELIVERY else 0.0)
            - backlog_pressure * self.policy.backlog_penalty_multiplier
            - max(0.0, founder_workload - 0.78) * self.policy.quality_collapse_penalty
            + rng.uniform(-0.025, 0.025)
        )
        quality_score = clamp(state.quality_score + quality_delta, 0.08, 0.98)

        product_progress = clamp(
            founder.product_strength * 0.16
            + strategy.automation_bias * 0.10
            + (0.09 if decision.focus == FounderFocus.AUTOMATION else 0.0)
            + (0.04 if any(action.action_type == FounderActionType.INCREASE_AUTOMATION for action in decision.actions) else 0.0)
            + rng.uniform(0.0, 0.06),
            0.0,
            0.42,
        )

        execution_quality = clamp(
            quality_score * 0.45 + founder.operations_strength * 0.22 + automation_efficiency * 0.16 + (1.0 - min(founder_workload, 1.2)) * 0.12,
            0.05,
            0.98,
        )

        summary = (
            "Operations stays under control and backlog remains manageable."
            if backlog_pressure < 0.35 and quality_score >= 0.55
            else "Operations is under pressure; backlog or workload is starting to degrade execution quality."
        )

        return OperationsReport(
            delivery_capacity=round(delivery_capacity, 2),
            delivery_capacity_used=round(delivered_work_units, 2),
            delivered_work_units=round(delivered_work_units, 2),
            backlog_units=round(backlog_units, 2),
            backlog_delta=round(backlog_delta, 2),
            quality_score=round(quality_score, 3),
            quality_delta=round(quality_delta, 3),
            founder_workload=round(founder_workload, 3),
            automation_efficiency=round(automation_efficiency, 3),
            product_progress=round(product_progress, 3),
            execution_quality=round(execution_quality, 3),
            summary=summary,
        )
