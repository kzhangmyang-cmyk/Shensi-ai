from __future__ import annotations

from random import Random

from decision_os_backend.models.enums import CompanyFinalOutcome
from decision_os_backend.services.simulation_engine.domain import (
    ChannelStrategy,
    CompanyStage,
    CompanyState,
    CompanyStrategy,
    GeneratedCompany,
    PricingStrategy,
    SimulationContext,
    clamp,
)
from decision_os_backend.services.simulation_engine.founder_profiles import FounderProfileGenerator

COMPANY_NAME_PREFIXES = [
    "Atlas",
    "Axiom",
    "Signal",
    "Relay",
    "Orbit",
    "Vector",
    "Forge",
    "Lattice",
    "Helix",
    "Prism",
]


class CompanyGenerator:
    """Builds the initial world state for virtual companies before simulation starts."""

    def __init__(self, founder_profiles: FounderProfileGenerator | None = None) -> None:
        self.founder_profiles = founder_profiles or FounderProfileGenerator()

    def generate_companies(self, context: SimulationContext) -> list[GeneratedCompany]:
        rng = Random(context.seed)
        return [self.generate_company(company_index=index, context=context, rng=rng) for index in range(context.company_count)]

    def generate_company(self, company_index: int, context: SimulationContext, rng: Random) -> GeneratedCompany:
        founder_profile = self.founder_profiles.generate(
            founder_hint=str(context.structured_inputs.get("founderProfile") or context.structured_inputs.get("founder_profile") or ""),
            rng=rng,
        )

        pricing_strategy = rng.choice(list(PricingStrategy))
        channel_strategy = rng.choice(list(ChannelStrategy))
        strategy = CompanyStrategy(
            pricing_strategy=pricing_strategy,
            channel_strategy=channel_strategy,
            niche_focus=clamp(0.45 + (context.dimension_scores.get("demand", 50.0) / 100.0) * 0.35 + rng.uniform(-0.1, 0.08), 0.15, 0.98),
            automation_bias=clamp(0.25 + founder_profile.product_strength * 0.35 + rng.uniform(-0.08, 0.08), 0.05, 0.95),
        )

        base_budget = self._base_budget(context)
        starting_budget = max(5_000.0, base_budget * rng.uniform(0.55, 1.25))
        initial_revenue = round(max(0.0, (context.dimension_scores.get("demand", 0.0) - 45.0) * 6.0 + rng.uniform(-40, 60)), 2)
        monthly_burn = round(max(4_000.0, 9_000.0 + (1.0 - founder_profile.discipline) * 6_000.0 + rng.uniform(-1_500, 2_500)), 2)
        runway_months = round(starting_budget / monthly_burn, 2)

        initial_state = CompanyState(
            month_index=0,
            stage=CompanyStage.EXPLORE,
            cash_balance=round(starting_budget, 2),
            monthly_revenue=initial_revenue,
            monthly_burn=monthly_burn,
            runway_months=runway_months,
            founder_energy=round(64.0 + founder_profile.stamina * 28.0 + rng.uniform(-8, 6), 2),
            capacity_points=round(45.0 + founder_profile.operations_strength * 30.0 + rng.uniform(-4, 5), 2),
            active_customers=max(0, int(initial_revenue // 500)),
            demand_signal=round(clamp((context.dimension_scores.get("demand", 50.0) / 100.0) + rng.uniform(-0.15, 0.12), 0.0, 1.0), 3),
            product_maturity=round(clamp(0.1 + founder_profile.product_strength * 0.15 + rng.uniform(0.0, 0.08), 0.05, 0.45), 3),
            distribution_efficiency=round(clamp((context.dimension_scores.get("distribution_feasibility", 50.0) / 100.0) + rng.uniform(-0.12, 0.12), 0.05, 0.95), 3),
            brand_awareness=round(clamp(0.08 + founder_profile.sales_strength * 0.08 + rng.uniform(0.0, 0.08), 0.03, 0.35), 3),
            market_match=round(clamp((context.dimension_scores.get("problem_severity", 50.0) / 100.0) * 0.5 + strategy.niche_focus * 0.3 + rng.uniform(-0.08, 0.08), 0.05, 0.95), 3),
            customer_satisfaction=round(clamp(0.45 + founder_profile.operations_strength * 0.18 + rng.uniform(-0.06, 0.06), 0.1, 0.9), 3),
            backlog_units=round(max(0.0, 8.0 + rng.uniform(-2.5, 3.5)), 2),
            quality_score=round(clamp(0.52 + founder_profile.operations_strength * 0.18 + rng.uniform(-0.05, 0.05), 0.18, 0.92), 3),
            founder_workload=round(clamp(0.46 + founder_profile.stamina * 0.12 + rng.uniform(-0.06, 0.08), 0.2, 0.88), 3),
            cac_estimate=round(max(150.0, 420.0 - founder_profile.sales_strength * 110.0 + rng.uniform(-40.0, 80.0)), 2),
            unit_contribution_margin=round(max(80.0, initial_revenue * 0.18 + rng.uniform(60.0, 180.0)), 2),
            no_growth_months=0,
            gross_margin=round(clamp(0.32 + (0.08 if pricing_strategy == PricingStrategy.SUBSCRIPTION else 0.0) - (0.12 if pricing_strategy == PricingStrategy.PILOT_FIRST else 0.0) + rng.uniform(-0.08, 0.05), 0.05, 0.88), 3),
            learning_velocity=round(clamp(0.35 + founder_profile.discipline * 0.25 + founder_profile.sales_strength * 0.15 + rng.uniform(-0.08, 0.1), 0.1, 0.95), 3),
            final_outcome=None,
            death_reason=None,
        )

        return GeneratedCompany(
            company_index=company_index,
            company_name=f"{COMPANY_NAME_PREFIXES[company_index % len(COMPANY_NAME_PREFIXES)]}-{company_index + 1:03d}",
            founder_profile=founder_profile,
            strategy=strategy,
            market_noise=round(rng.uniform(-0.22, 0.22), 3),
            starting_budget=round(starting_budget, 2),
            initial_state=initial_state,
        )

    def _base_budget(self, context: SimulationContext) -> float:
        raw_budget = context.structured_inputs.get("budget") or context.structured_inputs.get("budgetValue") or 50_000
        if isinstance(raw_budget, (int, float)):
            return float(raw_budget)
        text_budget = str(raw_budget).lower().replace(",", "").replace("$", "")
        multiplier = 1_000 if "k" in text_budget else 1_000_000 if "m" in text_budget else 1
        digits = "".join(character for character in text_budget if character.isdigit() or character == ".")
        try:
            return float(digits) * multiplier
        except ValueError:
            return 50_000.0
