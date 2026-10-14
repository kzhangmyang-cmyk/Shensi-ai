from __future__ import annotations

from random import Random

from decision_os_backend.services.simulation_engine.domain import FounderArchetype, FounderProfile


ARCHETYPE_BASELINES: dict[FounderArchetype, dict[str, float]] = {
    FounderArchetype.HYBRID: {
        "product_strength": 0.78,
        "sales_strength": 0.74,
        "operations_strength": 0.68,
        "discipline": 0.72,
        "stamina": 0.70,
        "risk_tolerance": 0.62,
    },
    FounderArchetype.BUILDER: {
        "product_strength": 0.88,
        "sales_strength": 0.38,
        "operations_strength": 0.48,
        "discipline": 0.60,
        "stamina": 0.66,
        "risk_tolerance": 0.68,
    },
    FounderArchetype.SELLER: {
        "product_strength": 0.46,
        "sales_strength": 0.90,
        "operations_strength": 0.50,
        "discipline": 0.64,
        "stamina": 0.71,
        "risk_tolerance": 0.66,
    },
    FounderArchetype.OPERATOR: {
        "product_strength": 0.56,
        "sales_strength": 0.58,
        "operations_strength": 0.86,
        "discipline": 0.82,
        "stamina": 0.72,
        "risk_tolerance": 0.48,
    },
    FounderArchetype.ANALYST: {
        "product_strength": 0.62,
        "sales_strength": 0.42,
        "operations_strength": 0.66,
        "discipline": 0.78,
        "stamina": 0.58,
        "risk_tolerance": 0.40,
    },
}


class FounderProfileGenerator:
    """Generates constrained founder archetypes for simulation companies."""

    def choose_archetype(self, founder_hint: str, rng: Random) -> FounderArchetype:
        hint = founder_hint.lower()
        if "hybrid" in hint:
            return FounderArchetype.HYBRID
        if "builder" in hint or "technical" in hint:
            return FounderArchetype.BUILDER
        if "sales" in hint or "commercial" in hint:
            return FounderArchetype.SELLER
        if "operator" in hint or "operations" in hint:
            return FounderArchetype.OPERATOR
        if "analyst" in hint or "research" in hint:
            return FounderArchetype.ANALYST

        weighted_pool = [
            FounderArchetype.HYBRID,
            FounderArchetype.HYBRID,
            FounderArchetype.BUILDER,
            FounderArchetype.SELLER,
            FounderArchetype.OPERATOR,
            FounderArchetype.ANALYST,
        ]
        return rng.choice(weighted_pool)

    def generate(self, founder_hint: str, rng: Random) -> FounderProfile:
        archetype = self.choose_archetype(founder_hint, rng)
        baseline = ARCHETYPE_BASELINES[archetype]

        def vary(value: float, spread: float = 0.08) -> float:
            return max(0.1, min(0.98, value + rng.uniform(-spread, spread)))

        return FounderProfile(
            archetype=archetype,
            product_strength=vary(baseline["product_strength"]),
            sales_strength=vary(baseline["sales_strength"]),
            operations_strength=vary(baseline["operations_strength"]),
            discipline=vary(baseline["discipline"]),
            stamina=vary(baseline["stamina"]),
            risk_tolerance=vary(baseline["risk_tolerance"]),
        )
