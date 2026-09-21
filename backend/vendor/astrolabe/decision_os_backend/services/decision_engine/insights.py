from __future__ import annotations

from collections.abc import Iterable

from decision_os_backend.schemas.assessment import (
    AssessmentExperiment,
    AssessmentInsight,
    AssessmentSuggestedPath,
)
from decision_os_backend.services.decision_engine.constants import LEVER_TONE, RISK_TONE
from decision_os_backend.services.decision_engine.scoring import (
    has_clear_acquisition_path,
    has_clear_monetization,
    has_clear_user,
    low_ticket_high_manual,
)
from decision_os_backend.services.decision_engine.types import DimensionEvaluation, NormalizedScenarioInput, PenaltySignal


def _dimension_map(dimensions: Iterable[DimensionEvaluation]) -> dict[str, DimensionEvaluation]:
    return {item.slug: item for item in dimensions}


def build_top_risks(
    data: NormalizedScenarioInput,
    dimensions: list[DimensionEvaluation],
    penalties: list[PenaltySignal],
) -> list[AssessmentInsight]:
    risk_items: list[AssessmentInsight] = []
    dimension_map = _dimension_map(dimensions)

    for penalty in penalties:
        risk_items.append(
            AssessmentInsight(
                title=penalty.title,
                body=penalty.reason,
                tone="rose" if penalty.cap <= 55 else RISK_TONE,
            )
        )

    if dimension_map["distribution_feasibility"].score < 55:
        risk_items.append(
            AssessmentInsight(
                title="Distribution assumptions are still fragile.",
                body="The idea may be good, but the current first-customer path is not strong enough to trust without direct channel testing.",
                tone=RISK_TONE,
            )
        )
    if dimension_map["adoption_friction"].score < 50:
        risk_items.append(
            AssessmentInsight(
                title="Adoption friction could erase early momentum.",
                body="The implied workflow looks heavier than an early-stage team can usually absorb without a tighter wedge or lighter offer.",
                tone=RISK_TONE,
            )
        )
    if dimension_map["differentiation"].score < 50:
        risk_items.append(
            AssessmentInsight(
                title="The product story still risks blending into generic alternatives.",
                body="Without a sharper wedge, the scenario can be pulled into feature competition before it earns pricing power.",
                tone=RISK_TONE,
            )
        )

    if len(risk_items) < 3:
        fallback_messages = {
            "demand": "Customer demand is not yet robust enough to ignore further validation.",
            "problem_severity": "The problem still needs stronger evidence that it is painful enough to drive action.",
            "differentiation": "Differentiation must stay sharp or the idea risks getting absorbed into generic alternatives.",
            "competitive_pressure": "Competitive pressure can still compress conversion and pricing if the wedge softens.",
            "adoption_friction": "Workflow friction could still slow early adoption if the offer grows heavier.",
            "monetization": "Monetization remains vulnerable until willingness-to-pay is proven with real buyers.",
            "distribution_feasibility": "Distribution confidence is not high enough yet to stop testing channels directly.",
            "founder_fit": "Execution quality still depends on keeping the model aligned with founder strengths.",
        }
        for dimension in sorted(dimensions, key=lambda item: item.score):
            title = f"{dimension.label} remains a monitored risk."
            risk_items.append(
                AssessmentInsight(
                    title=title,
                    body=fallback_messages[dimension.slug],
                    tone=RISK_TONE,
                )
            )

    unique: list[AssessmentInsight] = []
    seen_titles: set[str] = set()
    for item in risk_items:
        if item.title in seen_titles:
            continue
        seen_titles.add(item.title)
        unique.append(item)

    return unique[:3]


def build_top_levers(data: NormalizedScenarioInput, dimensions: list[DimensionEvaluation]) -> list[AssessmentInsight]:
    dimension_map = _dimension_map(dimensions)
    lever_items: list[AssessmentInsight] = []

    if has_clear_user(data) and dimension_map["problem_severity"].score >= 65:
        lever_items.append(
            AssessmentInsight(
                title="A narrow user segment with painful stakes is the strongest early leverage.",
                body="Keeping the wedge sharp should improve conversion quality, message clarity, and pricing power at the same time.",
                tone=LEVER_TONE,
            )
        )
    if has_clear_monetization(data):
        lever_items.append(
            AssessmentInsight(
                title="The monetization path is defined enough to test quickly.",
                body="Because pricing and business model are already articulated, the team can move from opinions to payment signal faster than most early-stage ideas.",
                tone="emerald",
            )
        )
    if dimension_map["founder_fit"].score >= 65:
        lever_items.append(
            AssessmentInsight(
                title="Founder strengths are aligned with the first execution loop.",
                body="The current wedge fits the operator profile well enough to support focused experimentation before team expansion is necessary.",
                tone=LEVER_TONE,
            )
        )
    if has_clear_acquisition_path(data):
        lever_items.append(
            AssessmentInsight(
                title="There is a plausible path to the first customers without waiting for scale channels.",
                body="The idea can likely be pressure-tested through a constrained, founder-led channel before expensive growth systems are required.",
                tone="emerald",
            )
        )

    if not lever_items:
        lever_items.append(
            AssessmentInsight(
                title="The main leverage is still strategic narrowing.",
                body="The fastest way to improve viability is to focus the wedge until the customer, pain, and monetization story become hard to misunderstand.",
                tone=LEVER_TONE,
            )
        )

    if len(lever_items) < 3:
        fallback_messages = {
            "demand": "There is enough customer pull to keep learning fast if the segment stays focused.",
            "problem_severity": "The problem framing is strong enough to support decision urgency and paid testing.",
            "differentiation": "The product concept already contains a wedge that can be sharpened into a stronger moat.",
            "competitive_pressure": "A narrow wedge can still keep competition manageable even in a noisy market.",
            "adoption_friction": "The offer can remain lightweight if the team resists unnecessary implementation burden.",
            "monetization": "Pricing clarity can accelerate learning much faster than additional feature work.",
            "distribution_feasibility": "The first-customer path is concrete enough to run focused channel tests now.",
            "founder_fit": "Founder strengths can compound if the execution model stays aligned with them.",
        }
        for dimension in sorted(dimensions, key=lambda item: item.score, reverse=True):
            title = f"{dimension.label} is a usable leverage point."
            lever_items.append(
                AssessmentInsight(
                    title=title,
                    body=fallback_messages[dimension.slug],
                    tone=LEVER_TONE,
                )
            )

    unique: list[AssessmentInsight] = []
    seen_titles: set[str] = set()
    for item in lever_items:
        if item.title in seen_titles:
            continue
        seen_titles.add(item.title)
        unique.append(item)

    return unique[:3]


def build_suggested_paths(data: NormalizedScenarioInput, dimensions: list[DimensionEvaluation], viability_score: float) -> list[AssessmentSuggestedPath]:
    dimension_map = _dimension_map(dimensions)
    paths: list[AssessmentSuggestedPath] = []

    if viability_score >= 65 and dimension_map["monetization"].score >= 55:
        paths.append(
            AssessmentSuggestedPath(
                label="Recommended",
                title="Pursue a niche-first validation path with paid pilots.",
                description="Keep the user segment narrow, sell the outcome quickly, and validate pricing before investing in broader product buildout.",
                condition="Best path when the wedge is sharp and the team can reach the first customers directly.",
                tone="emerald",
            )
        )
    else:
        paths.append(
            AssessmentSuggestedPath(
                label="Recommended",
                title="Run a focused validation sprint before committing deeper build effort.",
                description="Use interviews, pricing tests, and message experiments to prove the wedge before treating the idea like a full product bet.",
                condition="Best path when demand looks promising but monetization or distribution is still weak.",
                tone="amber",
            )
        )

    paths.append(
        AssessmentSuggestedPath(
            label="Conditional",
            title="Expand the product surface only after one repeatable loop is working.",
            description="A broader platform can make sense later, but only after the initial wedge has clear pricing, delivery, and distribution proof.",
            condition="Only viable if the first segment converts and the operating loop stops feeling bespoke.",
            tone="cyan",
        )
    )

    avoid_description = (
        "Avoid a low-ticket, labor-heavy offer because the economics are too fragile for the delivery burden."
        if low_ticket_high_manual(data)
        else "Avoid launching as a broad, generic tool because competition and adoption friction will compound before differentiation is earned."
    )
    paths.append(
        AssessmentSuggestedPath(
            label="Avoid",
            title="Do not broaden into a generic launch path yet.",
            description=avoid_description,
            condition="No-go if the story still depends on too many audiences, too many features, or too much custom delivery.",
            tone="rose",
        )
    )

    return paths[:3]


def build_next_best_experiments(
    data: NormalizedScenarioInput,
    dimensions: list[DimensionEvaluation],
    penalties: list[PenaltySignal],
) -> list[AssessmentExperiment]:
    dimension_map = _dimension_map(dimensions)
    experiments: list[AssessmentExperiment] = []
    penalty_codes = {penalty.code for penalty in penalties}

    def add_experiment(experiment: AssessmentExperiment) -> None:
        if any(existing.title == experiment.title for existing in experiments):
            return
        experiments.append(experiment)

    if "no_clear_user" in penalty_codes or dimension_map["demand"].score < 60:
        add_experiment(
            AssessmentExperiment(
                title="Interview 10 sharply defined target users from one wedge.",
                metric="Problem resonance rate",
                threshold="At least 7 of 10 immediately recognize the pain and current workaround.",
                why="Demand is too weak to trust while the user definition stays broad.",
                expected_learning="Whether the current wedge is specific enough to produce real urgency instead of polite interest.",
                priority="01",
            )
        )
    if "no_clear_monetization" in penalty_codes or dimension_map["monetization"].score < 60:
        add_experiment(
            AssessmentExperiment(
                title="Run a pricing sprint with the best-fit prospects.",
                metric="Paid pilot acceptance",
                threshold="At least 4 of 10 prospects accept a paid range or commit to a follow-up buying conversation.",
                why="Monetization remains the highest-risk unknown in the current scenario.",
                expected_learning="Whether the wedge is strong enough to convert from strategic interest into budget.",
                priority="02",
            )
        )
    if "no_acquisition_path" in penalty_codes or dimension_map["distribution_feasibility"].score < 60:
        add_experiment(
            AssessmentExperiment(
                title="Test one narrow acquisition channel with wedge-specific messaging.",
                metric="Qualified response rate",
                threshold="At least 10% of the first targeted outreach batch converts into qualified conversations.",
                why="Distribution looks too assumption-heavy to trust without direct channel evidence.",
                expected_learning="Which first-customer path is actually viable before more capital is committed.",
                priority="03",
            )
        )
    if low_ticket_high_manual(data):
        add_experiment(
            AssessmentExperiment(
                title="Time-box manual delivery and test premium packaging.",
                metric="Hours per delivery and gross margin",
                threshold="Keep founder effort below 2.5 hours while raising effective pricing above the fragile zone.",
                why="The current pricing-to-delivery ratio risks collapsing unit economics.",
                expected_learning="Whether the model can become repeatable enough to scale without consulting-shaped drag.",
                priority="04",
            )
        )
    if dimension_map["differentiation"].score < 55:
        add_experiment(
            AssessmentExperiment(
                title="Run a wedge-specific message test against the closest alternatives.",
                metric="Message clarity preference",
                threshold="Prospects consistently choose the wedge narrative over generic alternatives in feedback sessions.",
                why="Differentiation is not yet sharp enough to win a crowded category on its own.",
                expected_learning="Which positioning angle creates the strongest separation and willingness to engage.",
                priority="05",
            )
        )
    if dimension_map["founder_fit"].score < 50:
        add_experiment(
            AssessmentExperiment(
                title="Test founder-assisted selling with a domain or GTM partner.",
                metric="Meeting-to-pilot conversion",
                threshold="Conversion improves materially versus solo founder-led attempts.",
                why="Founder fit may be limiting the current go-to-market shape more than the idea itself.",
                expected_learning="Whether capability mismatch is suppressing what could otherwise be a viable wedge.",
                priority="06",
            )
        )

    if not experiments:
        add_experiment(
            AssessmentExperiment(
                title="Run one constrained pilot loop and instrument every step.",
                metric="Decision usefulness and paid follow-up intent",
                threshold="Customers say the output changes a real decision and at least one follow-up paid step emerges.",
                why="The scenario is strong enough that the main job is now to convert theory into operating evidence.",
                expected_learning="Which parts of the workflow are repeatable enough to productize first.",
                priority="01",
            )
        )

    return experiments[:3]
