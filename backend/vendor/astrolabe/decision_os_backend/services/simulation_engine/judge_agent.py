from __future__ import annotations

from dataclasses import dataclass

from decision_os_backend.models.enums import CompanyFinalOutcome
from decision_os_backend.services.simulation_engine.domain import CompanyStage, JudgeAgentInput, JudgeReport
from decision_os_backend.services.simulation_engine.state_machine import (
    build_state_label,
    build_state_score,
    determine_stage,
    evaluate_death_conditions,
)


@dataclass(slots=True)
class JudgePolicy:
    fragile_energy_threshold: float = 18.0
    fragile_backlog_ratio: float = 1.1


class JudgeAgent:
    """Summarizes monthly causality, stage progression, and replay-ready judge logs."""

    def __init__(self, policy: JudgePolicy | None = None) -> None:
        self.policy = policy or JudgePolicy()

    def evaluate(self, agent_input: JudgeAgentInput) -> JudgeReport:
        death = evaluate_death_conditions(
            state=agent_input.current_state,
            finance_report=agent_input.finance_report,
            operations_report=agent_input.operations_report,
            market_signal=agent_input.market_signal,
        )

        if death.is_dead:
            score = 0.0
            stage = CompanyStage.DEAD
            outcome = CompanyFinalOutcome.DEAD
            state_label = build_state_label(stage)
            summary = self._build_death_summary(agent_input, death.causes)
            replay_log = self._build_replay_log(agent_input, summary)
            return JudgeReport(
                stage=stage,
                outcome=outcome,
                state_label=state_label,
                score=score,
                summary=summary,
                replay_log=replay_log,
                causes=death.causes,
                death_reason=death.death_reason,
                success_reason=None,
            )

        stage, outcome, success_reason = determine_stage(
            state=agent_input.current_state,
            finance_report=agent_input.finance_report,
            market_signal=agent_input.market_signal,
        )
        score = build_state_score(
            state=agent_input.current_state,
            finance_report=agent_input.finance_report,
            market_signal=agent_input.market_signal,
            viability_score=agent_input.viability_score,
        )
        causes = self._build_causes(agent_input)
        summary = self._build_summary(stage, agent_input, success_reason)
        replay_log = self._build_replay_log(agent_input, summary)

        return JudgeReport(
            stage=stage,
            outcome=outcome,
            state_label=build_state_label(stage),
            score=score,
            summary=summary,
            replay_log=replay_log,
            causes=causes,
            death_reason=None,
            success_reason=success_reason,
        )

    def _build_causes(self, agent_input: JudgeAgentInput) -> list[str]:
        causes: list[str] = []
        if agent_input.market_signal.leads >= 20:
            causes.append("lead volume stays high enough to keep learning active")
        if agent_input.market_signal.conversion_rate >= 0.1:
            causes.append("conversion quality supports new customer intake")
        if agent_input.operations_report.backlog_units > agent_input.operations_report.delivery_capacity:
            causes.append("backlog pressure is constraining delivery quality")
        if agent_input.finance_report.net_profit >= 0:
            causes.append("economics are positive at the monthly level")
        if agent_input.current_state.founder_energy < self.policy.fragile_energy_threshold:
            causes.append("founder energy is approaching a fragile threshold")
        if not causes:
            causes.append("the line remains mixed and still needs more evidence")
        return causes

    def _build_summary(self, stage, agent_input: JudgeAgentInput, success_reason: str | None) -> str:
        if success_reason:
            return success_reason
        return (
            f"The line remains in {stage.value} because market response, delivery quality, and economics are not yet strong enough to justify a higher stage."
        )

    def _build_death_summary(self, agent_input: JudgeAgentInput, causes: list[str]) -> str:
        cause_text = causes[0] if causes else "terminal constraint pressure compounds beyond recovery"
        return f"The line dies this month because {cause_text.lower()}."

    def _build_replay_log(self, agent_input: JudgeAgentInput, summary: str) -> str:
        return (
            f"Month {agent_input.month_index}: focus={agent_input.founder_decision.focus.value}; "
            f"leads={agent_input.market_signal.leads}; conversion={agent_input.market_signal.conversion_rate:.2f}; "
            f"backlog={agent_input.operations_report.backlog_units:.1f}; net_profit={agent_input.finance_report.net_profit:.2f}; "
            f"judge={summary}"
        )
