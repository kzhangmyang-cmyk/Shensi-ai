from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

from decision_os_backend.services.decision_engine.constants import GENERIC_AUDIENCE_PATTERNS
from decision_os_backend.services.decision_engine.types import NormalizedScenarioInput


def _first_value(payload: Mapping[str, Any], candidates: Iterable[str]) -> Any:
    for candidate in candidates:
        if candidate in payload and payload[candidate] not in (None, ""):
            return payload[candidate]
    return None


def _to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def normalize_scenario_inputs(one_line_pitch: str, structured_inputs: Mapping[str, Any] | None) -> NormalizedScenarioInput:
    payload = structured_inputs or {}

    return NormalizedScenarioInput(
        one_line_pitch=_to_text(one_line_pitch or _first_value(payload, ["one_line_pitch", "oneLinePitch"])),
        target_customer=_to_text(_first_value(payload, ["target_customer", "targetCustomer", "customer", "icp"])),
        core_pain=_to_text(_first_value(payload, ["core_pain", "corePain", "problem"])),
        solution=_to_text(_first_value(payload, ["solution", "wedge", "product"])),
        business_model=_to_text(_first_value(payload, ["business_model", "businessModel", "charging_model"])),
        pricing=_to_text(_first_value(payload, ["pricing", "price", "pricingStrategy"])),
        acquisition_channels=_to_text(_first_value(payload, ["acquisition_channels", "acquisitionChannels", "channels"])),
        founder_profile=_to_text(_first_value(payload, ["founder_profile", "founderProfile", "founder_type"])),
        team_size=_to_text(_first_value(payload, ["team_size", "teamSize"])),
        budget=_to_text(_first_value(payload, ["budget", "initialBudget"])),
        traction=_to_text(_first_value(payload, ["traction", "validation", "tractionNotes"])),
        competitors=_to_text(_first_value(payload, ["competitors", "competition", "competitiveLandscape"])),
        supplementary_evidence=list(
            _first_value(payload, ["supplementary_evidence", "supplementaryEvidence", "evidence"]) or []
        ),
    )


def tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9\-]+", text.lower()))


def contains_any(text: str, patterns: Iterable[str]) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in patterns)


def count_matches(text: str, patterns: Iterable[str]) -> int:
    lowered = text.lower()
    return sum(1 for pattern in patterns if pattern in lowered)


def parse_team_size(value: str) -> int | None:
    match = re.search(r"\d+", value)
    return int(match.group(0)) if match else None


def parse_budget_value(value: str) -> float | None:
    cleaned = value.lower().replace(",", "").replace("$", "").strip()
    match = re.search(r"\d+(?:\.\d+)?", cleaned)
    if not match:
        return None

    amount = float(match.group(0))
    if "k" in cleaned:
        amount *= 1_000
    if "m" in cleaned:
        amount *= 1_000_000
    return amount


def parse_price_points(value: str) -> list[float]:
    cleaned = value.lower().replace(",", "")
    numbers = [float(match) for match in re.findall(r"\d+(?:\.\d+)?", cleaned)]
    if "k" in cleaned:
        return [number * 1_000 for number in numbers]
    if "m" in cleaned:
        return [number * 1_000_000 for number in numbers]
    return numbers


def is_generic_customer(text: str) -> bool:
    if not text:
        return True
    return contains_any(text, GENERIC_AUDIENCE_PATTERNS)


def evidence_count(value: NormalizedScenarioInput) -> int:
    return len(value.supplementary_evidence)
