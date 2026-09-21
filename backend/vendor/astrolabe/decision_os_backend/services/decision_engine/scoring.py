from __future__ import annotations

from typing import Iterable

from decision_os_backend.services.decision_engine.constants import (
    DIFFERENTIATION_KEYWORDS,
    DIMENSION_WEIGHTS,
    DISTRIBUTION_KEYWORDS,
    FOUNDER_STRENGTH_KEYWORDS,
    HIGH_FRICTION_KEYWORDS,
    LOW_FRICTION_KEYWORDS,
    MANUAL_DELIVERY_KEYWORDS,
    MONETIZATION_KEYWORDS,
    PENALTY_DEFINITIONS,
    SEVERE_PROBLEM_KEYWORDS,
)
from decision_os_backend.services.decision_engine.input import (
    contains_any,
    count_matches,
    evidence_count,
    is_generic_customer,
    parse_budget_value,
    parse_price_points,
    parse_team_size,
)
from decision_os_backend.services.decision_engine.types import DimensionEvaluation, NormalizedScenarioInput, PenaltySignal


def clamp(value: float, lower: float = 0.0, upper: float = 100.0) -> float:
    return max(lower, min(upper, value))


def _confidence_from_signals(*signals: bool, base: float = 35.0, evidence_bonus: float = 0.0) -> float:
    return clamp(base + sum(12.0 for signal in signals if signal) + evidence_bonus)


def _text_signal(text: str, min_length: int = 12) -> bool:
    return len(text.strip()) >= min_length


def score_demand(data: NormalizedScenarioInput) -> DimensionEvaluation:
    has_customer = _text_signal(data.target_customer)
    has_traction = _text_signal(data.traction)
    narrow_customer = has_customer and not is_generic_customer(data.target_customer)
    score = 18.0
    if has_customer:
        score += 24.0
    if narrow_customer:
        score += 20.0
    if has_traction:
        score += 18.0
    if _text_signal(data.acquisition_channels):
        score += 10.0
    if evidence_count(data) > 0:
        score += min(10.0, evidence_count(data) * 2.5)

    note = (
        "The scenario names a clear customer segment and already has some real-world signal."
        if score >= 70
        else "Demand signal exists, but the customer definition and evidence stack still need tightening."
        if score >= 50
        else "Demand remains weak because the target user and real pull are not specific enough yet."
    )
    confidence = _confidence_from_signals(has_customer, has_traction, narrow_customer, evidence_bonus=evidence_count(data) * 3.0)
    return DimensionEvaluation(
        slug="demand",
        label="Demand",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["demand"],
    )


def score_problem_severity(data: NormalizedScenarioInput) -> DimensionEvaluation:
    has_problem = _text_signal(data.core_pain)
    severity_hits = count_matches(data.core_pain, SEVERE_PROBLEM_KEYWORDS)
    score = 20.0
    if has_problem:
        score += 28.0
    score += min(24.0, severity_hits * 6.0)
    if _text_signal(data.traction):
        score += 10.0
    if len(data.core_pain) > 120:
        score += 8.0

    note = (
        "The problem appears costly enough that customers could rationally pay to avoid it."
        if score >= 70
        else "The problem is real, but the severity or urgency is not fully proven yet."
        if score >= 50
        else "The pain is too vague or too soft to support strong conviction today."
    )
    confidence = _confidence_from_signals(has_problem, severity_hits > 0, _text_signal(data.traction), evidence_bonus=evidence_count(data) * 2.0)
    return DimensionEvaluation(
        slug="problem_severity",
        label="Problem Severity",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["problem_severity"],
    )


def score_differentiation(data: NormalizedScenarioInput) -> DimensionEvaluation:
    has_solution = _text_signal(data.solution)
    differentiation_hits = count_matches(f"{data.one_line_pitch} {data.solution}", DIFFERENTIATION_KEYWORDS)
    has_competitor_view = _text_signal(data.competitors)
    score = 18.0
    if has_solution:
        score += 20.0
    score += min(28.0, differentiation_hits * 5.0)
    if has_competitor_view:
        score += 8.0
    if _text_signal(data.target_customer) and not is_generic_customer(data.target_customer):
        score += 10.0
    if contains_any(data.solution, {"copilot", "assistant", "dashboard", "platform"}) and differentiation_hits < 2:
        score -= 12.0

    note = (
        "There is a visible wedge that can separate this product from generic alternatives."
        if score >= 70
        else "Differentiation exists, but it is still partly narrative rather than clearly earned in the market."
        if score >= 50
        else "The scenario still looks too close to crowded, generic tools."
    )
    confidence = _confidence_from_signals(has_solution, has_competitor_view, differentiation_hits > 1)
    return DimensionEvaluation(
        slug="differentiation",
        label="Differentiation",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["differentiation"],
    )


def score_competitive_pressure(data: NormalizedScenarioInput, differentiation_score: float) -> DimensionEvaluation:
    has_competitors = _text_signal(data.competitors)
    score = 58.0
    crowded = contains_any(data.competitors, {"crowded", "saturated", "many", "numerous", "copilot", "dashboard"})
    if not has_competitors:
        score -= 8.0
    if crowded:
        score -= 18.0
    if differentiation_score >= 65:
        score += 14.0
    if _text_signal(data.target_customer) and not is_generic_customer(data.target_customer):
        score += 8.0

    note = (
        "Competitive pressure looks manageable because the wedge is narrow enough to reduce direct substitution risk."
        if score >= 65
        else "Competition is present, but the scenario can still work if positioning stays disciplined."
        if score >= 45
        else "Competitive pressure is high relative to the current level of differentiation."
    )
    confidence = _confidence_from_signals(has_competitors, differentiation_score >= 50, _text_signal(data.target_customer), base=30.0)
    return DimensionEvaluation(
        slug="competitive_pressure",
        label="Competitive Pressure",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["competitive_pressure"],
    )


def score_adoption_friction(data: NormalizedScenarioInput) -> DimensionEvaluation:
    score = 58.0
    low_friction_hits = count_matches(f"{data.solution} {data.business_model}", LOW_FRICTION_KEYWORDS)
    high_friction_hits = count_matches(f"{data.solution} {data.business_model}", HIGH_FRICTION_KEYWORDS)
    score += min(16.0, low_friction_hits * 4.0)
    score -= min(24.0, high_friction_hits * 6.0)
    if contains_any(data.target_customer, {"enterprise", "bank", "government"}):
        score -= 10.0
    if contains_any(data.business_model, MANUAL_DELIVERY_KEYWORDS):
        score -= 8.0

    note = (
        "The wedge looks adoptable without excessive operational or procurement friction."
        if score >= 65
        else "Adoption is plausible, but workflow friction could slow conversion or delivery."
        if score >= 45
        else "Adoption friction is high enough to threaten early momentum."
    )
    confidence = _confidence_from_signals(_text_signal(data.solution), _text_signal(data.business_model), base=32.0)
    return DimensionEvaluation(
        slug="adoption_friction",
        label="Adoption Friction",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["adoption_friction"],
    )


def score_monetization(data: NormalizedScenarioInput) -> DimensionEvaluation:
    has_business_model = _text_signal(data.business_model)
    has_pricing = _text_signal(data.pricing)
    pricing_points = parse_price_points(data.pricing)
    highest_price = max(pricing_points) if pricing_points else None
    score = 10.0
    if has_business_model:
        score += 24.0
    if has_pricing:
        score += 26.0
    if contains_any(f"{data.business_model} {data.pricing}", MONETIZATION_KEYWORDS):
        score += 14.0
    if _text_signal(data.traction) and contains_any(data.traction, {"paid", "pilot", "revenue", "subscription"}):
        score += 10.0
    if highest_price is not None and highest_price >= 500:
        score += 10.0
    if highest_price is not None and highest_price < 100:
        score -= 12.0

    note = (
        "The scenario is monetizable enough to test revenue logic quickly."
        if score >= 70
        else "There is a monetization path, but pricing proof and delivery economics still need validation."
        if score >= 45
        else "Monetization is under-defined and currently a major weakness."
    )
    confidence = _confidence_from_signals(has_business_model, has_pricing, highest_price is not None, _text_signal(data.traction))
    return DimensionEvaluation(
        slug="monetization",
        label="Monetization",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["monetization"],
    )


def score_distribution_feasibility(data: NormalizedScenarioInput) -> DimensionEvaluation:
    has_channels = _text_signal(data.acquisition_channels)
    distribution_hits = count_matches(data.acquisition_channels, DISTRIBUTION_KEYWORDS)
    has_founder = _text_signal(data.founder_profile)
    score = 12.0
    if has_channels:
        score += 24.0
    score += min(22.0, distribution_hits * 5.0)
    if has_founder and contains_any(data.founder_profile, {"sales", "community", "operator", "distribution", "hybrid"}):
        score += 14.0
    if _text_signal(data.traction):
        score += 10.0
    if contains_any(data.acquisition_channels, {"ads", "paid ads", "seo"}) and parse_budget_value(data.budget) is not None and parse_budget_value(data.budget) < 20_000:
        score -= 10.0

    note = (
        "The first-customer path is credible enough to support a focused launch."
        if score >= 70
        else "There is some path to distribution, but it still relies on assumptions that need testing."
        if score >= 45
        else "Distribution feasibility is weak because the first-customer path is not concrete enough."
    )
    confidence = _confidence_from_signals(has_channels, distribution_hits > 0, has_founder, _text_signal(data.traction), base=30.0)
    return DimensionEvaluation(
        slug="distribution_feasibility",
        label="Distribution Feasibility",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["distribution_feasibility"],
    )


def score_founder_fit(data: NormalizedScenarioInput) -> DimensionEvaluation:
    team_size = parse_team_size(data.team_size)
    budget_value = parse_budget_value(data.budget)
    founder_hits = count_matches(data.founder_profile, FOUNDER_STRENGTH_KEYWORDS)
    score = 18.0
    if _text_signal(data.founder_profile):
        score += 24.0
    score += min(20.0, founder_hits * 4.0)
    if team_size is not None and team_size >= 2:
        score += 8.0
    if budget_value is not None and budget_value >= 25_000:
        score += 10.0
    if contains_any(f"{data.business_model} {data.solution}", MANUAL_DELIVERY_KEYWORDS) and not contains_any(data.founder_profile, {"sales", "operator", "hybrid", "service"}):
        score -= 12.0
    if contains_any(data.acquisition_channels, {"founder-led", "outreach", "community"}) and not contains_any(data.founder_profile, {"sales", "community", "hybrid", "operator"}):
        score -= 10.0

    note = (
        "Founder strengths and resource envelope look reasonably aligned with the current wedge."
        if score >= 70
        else "The founder can likely execute this line, but some capability or bandwidth mismatches remain."
        if score >= 45
        else "Founder fit is weak relative to the current product and go-to-market demands."
    )
    confidence = _confidence_from_signals(_text_signal(data.founder_profile), team_size is not None, budget_value is not None)
    return DimensionEvaluation(
        slug="founder_fit",
        label="Founder Fit",
        score=clamp(score),
        confidence=confidence,
        note=note,
        weight=DIMENSION_WEIGHTS["founder_fit"],
    )


def evaluate_dimensions(data: NormalizedScenarioInput) -> list[DimensionEvaluation]:
    demand = score_demand(data)
    problem = score_problem_severity(data)
    differentiation = score_differentiation(data)
    competitive = score_competitive_pressure(data, differentiation.score)
    adoption = score_adoption_friction(data)
    monetization = score_monetization(data)
    distribution = score_distribution_feasibility(data)
    founder_fit = score_founder_fit(data)
    return [
        demand,
        problem,
        differentiation,
        competitive,
        adoption,
        monetization,
        distribution,
        founder_fit,
    ]


def compute_weighted_score(dimension_scores: Iterable[DimensionEvaluation]) -> float:
    return clamp(sum(item.score * item.weight for item in dimension_scores))


def has_clear_user(data: NormalizedScenarioInput) -> bool:
    return _text_signal(data.target_customer) and not is_generic_customer(data.target_customer)


def has_clear_monetization(data: NormalizedScenarioInput) -> bool:
    return _text_signal(data.business_model) and _text_signal(data.pricing)


def has_clear_acquisition_path(data: NormalizedScenarioInput) -> bool:
    return _text_signal(data.acquisition_channels) and count_matches(data.acquisition_channels, DISTRIBUTION_KEYWORDS) > 0


def low_ticket_high_manual(data: NormalizedScenarioInput) -> bool:
    prices = parse_price_points(data.pricing)
    highest_price = max(prices) if prices else None
    if highest_price is None:
        return False
    return highest_price < 100 and contains_any(f"{data.business_model} {data.solution}", MANUAL_DELIVERY_KEYWORDS)


def apply_penalties(data: NormalizedScenarioInput, dimension_map: dict[str, DimensionEvaluation]) -> list[PenaltySignal]:
    penalties: list[PenaltySignal] = []

    def add(code: str) -> None:
        definition = PENALTY_DEFINITIONS[code]
        penalties.append(
            PenaltySignal(
                code=definition.code,
                title=definition.title,
                reason=definition.reason_template,
                deduction=definition.deduction,
                cap=definition.cap,
            )
        )

    if not has_clear_user(data):
        add("no_clear_user")
    if not has_clear_monetization(data):
        add("no_clear_monetization")
    if low_ticket_high_manual(data):
        add("low_ticket_high_manual")
    if not has_clear_acquisition_path(data):
        add("no_acquisition_path")
    if dimension_map["founder_fit"].score < 45:
        add("founder_mismatch")
    if dimension_map["differentiation"].score < 45 and dimension_map["competitive_pressure"].score < 45:
        add("crowded_no_diff")

    return penalties


def apply_viability_penalties(raw_score: float, penalties: list[PenaltySignal]) -> float:
    penalized = raw_score - sum(penalty.deduction for penalty in penalties)
    if penalties:
        penalized = min(penalized, min(penalty.cap for penalty in penalties))
    return clamp(round(penalized, 1))


def compute_data_sufficiency(data: NormalizedScenarioInput) -> float:
    score = 0.0
    score += 8 if _text_signal(data.one_line_pitch) else 0
    score += 12 if has_clear_user(data) else 4 if _text_signal(data.target_customer) else 0
    score += 12 if _text_signal(data.core_pain) else 0
    score += 10 if _text_signal(data.solution) else 0
    score += 10 if _text_signal(data.business_model) else 0
    score += 10 if _text_signal(data.pricing) else 0
    score += 10 if _text_signal(data.acquisition_channels) else 0
    score += 10 if _text_signal(data.founder_profile) else 0
    score += 6 if parse_team_size(data.team_size) is not None else 0
    score += 6 if parse_budget_value(data.budget) is not None else 0
    score += 10 if _text_signal(data.traction) else 0
    score += 6 if _text_signal(data.competitors) else 0
    score += min(10.0, evidence_count(data) * 3.0)
    return clamp(round(score, 1))


def compute_confidence(
    data_sufficiency: float,
    dimensions: list[DimensionEvaluation],
    penalties: list[PenaltySignal],
) -> float:
    average_dimension_confidence = sum(item.confidence for item in dimensions) / len(dimensions)
    low_score_penalty = sum(1 for item in dimensions if item.score < 45) * 3.0
    severe_penalty = sum(1 for item in penalties if item.cap <= 55) * 5.0
    confidence = (average_dimension_confidence * 0.6) + (data_sufficiency * 0.4) - low_score_penalty - severe_penalty
    return clamp(round(confidence, 1))
