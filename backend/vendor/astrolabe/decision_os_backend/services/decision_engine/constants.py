from __future__ import annotations

from dataclasses import dataclass


DIMENSION_WEIGHTS: dict[str, float] = {
    "demand": 0.17,
    "problem_severity": 0.15,
    "differentiation": 0.12,
    "competitive_pressure": 0.10,
    "adoption_friction": 0.10,
    "monetization": 0.14,
    "distribution_feasibility": 0.12,
    "founder_fit": 0.10,
}

GENERIC_AUDIENCE_PATTERNS = [
    "everyone",
    "anyone",
    "all businesses",
    "all founders",
    "all startups",
    "small businesses",
    "consumers",
    "general market",
]

SEVERE_PROBLEM_KEYWORDS = {
    "expensive",
    "costly",
    "painful",
    "urgent",
    "manual",
    "slow",
    "compliance",
    "regulatory",
    "risk",
    "error",
    "burn",
    "waste",
    "miss",
    "failure",
    "lost",
    "churn",
}

DIFFERENTIATION_KEYWORDS = {
    "simulation",
    "worldline",
    "structured",
    "decision",
    "judge",
    "audit",
    "explainable",
    "niche",
    "wedge",
    "replay",
    "state-driven",
    "constrained",
}

LOW_FRICTION_KEYWORDS = {
    "template",
    "async",
    "lightweight",
    "self-serve",
    "report",
    "no integration",
    "pilot",
}

HIGH_FRICTION_KEYWORDS = {
    "custom",
    "consulting",
    "bespoke",
    "implementation",
    "integration",
    "enterprise",
    "migration",
    "procurement",
    "manual setup",
}

MANUAL_DELIVERY_KEYWORDS = {
    "manual",
    "service",
    "consulting",
    "done-for-you",
    "bespoke",
    "custom",
    "report-first",
}

MONETIZATION_KEYWORDS = {
    "subscription",
    "pilot",
    "paid",
    "retainer",
    "license",
    "annual",
    "monthly",
    "pricing",
    "fee",
}

DISTRIBUTION_KEYWORDS = {
    "founder-led",
    "outreach",
    "community",
    "referral",
    "content",
    "email",
    "linkedin",
    "partnership",
    "seo",
    "waitlist",
}

FOUNDER_STRENGTH_KEYWORDS = {
    "product",
    "sales",
    "operator",
    "domain",
    "distribution",
    "research",
    "community",
    "technical",
    "hybrid",
}


@dataclass(frozen=True)
class PenaltyDefinition:
    code: str
    title: str
    reason_template: str
    deduction: float
    cap: float


PENALTY_DEFINITIONS: dict[str, PenaltyDefinition] = {
    "no_clear_user": PenaltyDefinition(
        code="no_clear_user",
        title="No clearly defined user",
        reason_template="The scenario does not identify a sharp enough user segment to support strong demand assumptions.",
        deduction=18.0,
        cap=45.0,
    ),
    "no_clear_monetization": PenaltyDefinition(
        code="no_clear_monetization",
        title="No clear monetization path",
        reason_template="The scenario lacks a credible pricing or business model, so viability cannot score beyond a cautious threshold.",
        deduction=18.0,
        cap=50.0,
    ),
    "low_ticket_high_manual": PenaltyDefinition(
        code="low_ticket_high_manual",
        title="Low ticket with high manual delivery",
        reason_template="The pricing appears too low for the implied delivery burden, creating a weak unit economics profile.",
        deduction=14.0,
        cap=60.0,
    ),
    "no_acquisition_path": PenaltyDefinition(
        code="no_acquisition_path",
        title="No clear acquisition path",
        reason_template="The scenario does not describe a concrete path to the first customers, which makes distribution feasibility fragile.",
        deduction=16.0,
        cap=55.0,
    ),
    "founder_mismatch": PenaltyDefinition(
        code="founder_mismatch",
        title="Founder-to-model mismatch",
        reason_template="The founder profile and resource envelope do not match the current product and go-to-market demands strongly enough.",
        deduction=12.0,
        cap=60.0,
    ),
    "crowded_no_diff": PenaltyDefinition(
        code="crowded_no_diff",
        title="Crowded market without clear differentiation",
        reason_template="Competition appears strong while the scenario still lacks a wedge sharp enough to justify strong conviction.",
        deduction=12.0,
        cap=58.0,
    ),
}

RISK_TONE = "amber"
LEVER_TONE = "cyan"
