"""Single runtime-mode decision point for Shensi browser acquisition."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Resolved local/remote browser capabilities and private data roots."""

    mode: str
    interaction_surface: str
    browser_headless: bool
    browser_channel: str | None
    profile_root: Path
    state_root: Path
    crawl_output_root: Path
    uses_virtual_display: bool
    supports_live_sessions: bool
    outreach_actions_enabled: bool = False


def repository_root_for_module(
    module_file: str | Path,
    *,
    fallback_root: Path | None = None,
) -> Path:
    """Resolve a source checkout root without assuming a deep package layout.

    The source tree places ``shensi_adapter`` below
    ``services/media-crawler``.  The web container copies that package directly
    to ``/app/shensi_adapter``, so indexing a fourth parent is invalid there.
    """

    module_path = Path(module_file).resolve()
    if len(module_path.parents) > 3:
        source_root = module_path.parents[3]
        if (source_root / "services" / "media-crawler").is_dir():
            return source_root
    return (fallback_root or Path.cwd()).resolve()


def _absolute_path(value: str, *, name: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{name} must be absolute")
    return path


def _browser_channel(value: str, *, default: str | None) -> str | None:
    selected = value.strip() or default
    return None if selected == "chromium" else selected


def load_runtime_config(
    env: Mapping[str, str],
    *,
    repository_root: Path,
) -> RuntimeConfig:
    """Resolve runtime mode once instead of branching throughout the app.

    ``SHENSI_RUNTIME_MODE`` is the canonical desktop-facing switch.  The
    existing ``MEDIACRAWLER_BROWSER_DISPLAY`` remains supported as a backwards
    compatible deployment alias while the web runtime is migrated.
    """

    explicit_mode = env.get("SHENSI_RUNTIME_MODE", "").strip().lower()
    if explicit_mode and explicit_mode not in {"desktop", "web"}:
        raise ValueError("SHENSI_RUNTIME_MODE must be desktop or web")

    display = env.get("MEDIACRAWLER_BROWSER_DISPLAY", "").strip().lower()
    if not display:
        display = "operator" if explicit_mode != "web" else "virtual"
    if display not in {"operator", "virtual"}:
        raise ValueError(
            "MEDIACRAWLER_BROWSER_DISPLAY must be operator or virtual"
        )

    inferred_mode = "desktop" if display == "operator" else "web"
    mode = explicit_mode or inferred_mode
    expected_display = "operator" if mode == "desktop" else "virtual"
    if display != expected_display:
        raise ValueError(
            "SHENSI_RUNTIME_MODE conflicts with MEDIACRAWLER_BROWSER_DISPLAY"
        )

    if mode == "desktop":
        action_flag = env.get("SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED", "false")
        if action_flag not in {"true", "false"}:
            raise ValueError("SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED must be true or false")
        raw_data_root = env.get("SHENSI_USER_DATA_DIR", "").strip()
        data_root = (
            _absolute_path(raw_data_root, name="SHENSI_USER_DATA_DIR")
            if raw_data_root
            else repository_root.resolve() / ".local-data"
        )
        return RuntimeConfig(
            mode="desktop",
            interaction_surface="external_window",
            browser_headless=False,
            browser_channel=_browser_channel(
                env.get("MEDIACRAWLER_BROWSER_CHANNEL", ""),
                default="chrome",
            ),
            profile_root=data_root / "profiles" / "douyin",
            state_root=data_root / "state" / "douyin",
            crawl_output_root=data_root / "crawl-output" / "douyin",
            uses_virtual_display=False,
            supports_live_sessions=False,
            outreach_actions_enabled=action_flag == "true",
        )

    raw_profile_root = env.get("MEDIACRAWLER_PROFILE_ROOT", "").strip()
    state_root = (
        _absolute_path(raw_profile_root, name="MEDIACRAWLER_PROFILE_ROOT")
        if raw_profile_root
        else repository_root.resolve() / ".runtime" / "mediacrawler"
    )
    raw_output_root = env.get("MEDIACRAWLER_CRAWL_OUTPUT_ROOT", "").strip()
    output_root = (
        _absolute_path(
            raw_output_root,
            name="MEDIACRAWLER_CRAWL_OUTPUT_ROOT",
        )
        if raw_output_root
        else state_root / "crawl-output"
    )
    return RuntimeConfig(
        mode="web",
        interaction_surface="remote_canvas",
        browser_headless=(
            env.get("MEDIACRAWLER_BROWSER_HEADLESS", "true")
            .strip()
            .lower()
            != "false"
        ),
        browser_channel=_browser_channel(
            env.get("MEDIACRAWLER_BROWSER_CHANNEL", ""),
            default=None,
        ),
        profile_root=state_root,
        state_root=state_root,
        crawl_output_root=output_root,
        uses_virtual_display=True,
        supports_live_sessions=True,
        outreach_actions_enabled=env.get("DOUYIN_OUTREACH_ACTIONS_ENABLED", "").lower() == "true",
    )
