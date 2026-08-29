"""Private, optional visual locator boundary for deterministic controls."""

from __future__ import annotations

import math
from collections.abc import Callable
from datetime import UTC, datetime
from importlib import import_module
from numbers import Real
from pathlib import Path
from typing import Protocol


_PURPOSE_LABELS = {
    "direct_message_entry": frozenset({"发私信", "私信"}),
    "direct_message_submit": frozenset({"发送"}),
}
_MIN_CONFIDENCE = 0.90
_MAX_CANDIDATES = 100
_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
_MAX_VIEWPORT_DIMENSION = 4096
_MAX_MODEL_BYTES = 64 * 1024 * 1024
_PACKAGED_MODELS = {
    "Det.model_path": "PP-OCRv6_det_small.onnx",
    "Cls.model_path": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "Rec.model_path": "PP-OCRv6_rec_small.onnx",
}


class VisualLocator(Protocol):
    def locate_control(
        self,
        page: object,
        *,
        purpose: str,
        deadline_at: datetime,
    ) -> object: ...


class VisualLocatorFailure(RuntimeError):
    """A closed failure code that never includes OCR or screenshot data."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def configured_visual_locator(value: object) -> str:
    if value is None:
        return "disabled"
    if isinstance(value, str) and value in {"disabled", "rapidocr"}:
        return value
    raise ValueError("visual locator must be disabled or rapidocr")


def _normalized_label(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return "".join(value.split())


def _bounded_viewport(page: object) -> tuple[int, int]:
    try:
        viewport = page.viewport_size  # type: ignore[attr-defined]
    except Exception:
        viewport = None
    if not isinstance(viewport, dict):
        raise VisualLocatorFailure("douyin_action_control_missing")
    width, height = viewport.get("width"), viewport.get("height")
    if (type(width) is not int or type(height) is not int
            or not 1 <= width <= _MAX_VIEWPORT_DIMENSION
            or not 1 <= height <= _MAX_VIEWPORT_DIMENSION):
        raise VisualLocatorFailure("douyin_action_control_missing")
    return width, height


def _candidate_center(
    box: object,
    *,
    width: int,
    height: int,
) -> tuple[float, float] | None:
    if _collection_length(box) != 4:
        return None
    points: list[tuple[float, float]] = []
    for point in box:
        if _collection_length(point) != 2:
            return None
        raw_x, raw_y = point
        if (isinstance(raw_x, bool) or isinstance(raw_y, bool)
                or not isinstance(raw_x, Real)
                or not isinstance(raw_y, Real)):
            return None
        x, y = float(raw_x), float(raw_y)
        if (not math.isfinite(x) or not math.isfinite(y)
                or not 0 <= x < width or not 0 <= y < height):
            return None
        points.append((x, y))
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    if max(xs) <= min(xs) or max(ys) <= min(ys):
        return None
    return sum(xs) / 4, sum(ys) / 4


def _collection_length(value: object) -> int | None:
    if isinstance(value, (str, bytes, dict)):
        return None
    try:
        length = len(value)  # type: ignore[arg-type]
        iter(value)  # type: ignore[arg-type]
    except Exception:
        return None
    return length if type(length) is int and length >= 0 else None


_ELEMENT_FROM_POINT = """
({x, y}) => {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  return hit.closest('button, [role="button"]');
}
"""


class RapidOCRVisualLocator:
    """Use one in-memory screenshot only to locate an allowlisted control."""

    def __init__(
        self,
        *,
        engine: Callable[[bytes], object],
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._engine = engine
        self._now = now or (lambda: datetime.now(UTC))

    def _require_before_deadline(self, deadline_at: datetime) -> None:
        if self._now() >= deadline_at:
            raise VisualLocatorFailure("deadline_exceeded")

    @staticmethod
    def _output_columns(result: object) -> tuple[object, object, object]:
        return (
            getattr(result, "txts", None),
            getattr(result, "scores", None),
            getattr(result, "boxes", None),
        )

    @staticmethod
    def _rebind(
        page: object,
        *,
        x: float,
        y: float,
        expected_label: str,
    ) -> object:
        handle = None
        try:
            handle = page.evaluate_handle(  # type: ignore[attr-defined]
                _ELEMENT_FROM_POINT,
                {"x": x, "y": y},
            )
            element = handle.as_element()
            if element is None:
                raise VisualLocatorFailure("douyin_action_control_missing")
            # ``evaluate_handle(...).as_element()`` returns an ElementHandle,
            # not a Locator. ElementHandle read methods deliberately do not
            # accept Locator-only ``timeout`` keyword arguments.
            text = _normalized_label(element.text_content())
            role = element.get_attribute("role")
            tag = element.evaluate("element => element.tagName.toLowerCase()")
            normalized_role = role.strip().lower() if isinstance(role, str) else None
            if (text != expected_label
                    or not (normalized_role == "button"
                            or (normalized_role is None and tag == "button"))
                    or not element.is_visible()
                    or not element.is_enabled()):
                raise VisualLocatorFailure("douyin_action_control_missing")
            return element
        except VisualLocatorFailure:
            raise
        except Exception:
            raise VisualLocatorFailure(
                "douyin_action_control_missing"
            ) from None
        finally:
            if handle is not None:
                try:
                    if handle.as_element() is None:
                        handle.dispose()
                except Exception:
                    pass

    def locate_control(
        self,
        page: object,
        *,
        purpose: str,
        deadline_at: datetime,
    ) -> object:
        labels = _PURPOSE_LABELS.get(purpose)
        if labels is None:
            raise VisualLocatorFailure("douyin_action_control_missing")
        self._require_before_deadline(deadline_at)
        width, height = _bounded_viewport(page)
        try:
            image = page.screenshot(  # type: ignore[attr-defined]
                type="png",
                animations="disabled",
            )
        except Exception:
            raise VisualLocatorFailure(
                "douyin_action_control_missing"
            ) from None
        if (not isinstance(image, bytes) or not image
                or len(image) > _MAX_SCREENSHOT_BYTES):
            raise VisualLocatorFailure("douyin_action_control_missing")
        self._require_before_deadline(deadline_at)
        try:
            result = self._engine(image)
        except Exception:
            raise VisualLocatorFailure(
                "douyin_action_control_missing"
            ) from None
        self._require_before_deadline(deadline_at)
        texts, scores, boxes = self._output_columns(result)
        text_count = _collection_length(texts)
        score_count = _collection_length(scores)
        box_count = _collection_length(boxes)
        if (text_count is None or score_count is None or box_count is None
                or text_count != score_count or text_count != box_count):
            raise VisualLocatorFailure("douyin_action_control_missing")
        if text_count > _MAX_CANDIDATES:
            raise VisualLocatorFailure("douyin_action_control_ambiguous")

        matches: list[tuple[str, float, float]] = []
        for text, score, box in zip(texts, scores, boxes, strict=True):  # type: ignore[arg-type]
            label = _normalized_label(text)
            if label not in labels:
                continue
            if (isinstance(score, bool) or not isinstance(score, Real)
                    or not math.isfinite(float(score))
                    or not _MIN_CONFIDENCE <= float(score) <= 1):
                continue
            center = _candidate_center(box, width=width, height=height)
            if center is None:
                continue
            matches.append((label, *center))
            if len(matches) > 1:
                raise VisualLocatorFailure(
                    "douyin_action_control_ambiguous"
                )
        if not matches:
            raise VisualLocatorFailure("douyin_action_control_missing")
        label, x, y = matches[0]
        self._require_before_deadline(deadline_at)
        return self._rebind(
            page,
            x=x,
            y=y,
            expected_label=label,
        )


def create_visual_locator(mode: str) -> VisualLocator | None:
    normalized = configured_visual_locator(mode)
    if normalized == "disabled":
        return None
    try:
        rapidocr = import_module("rapidocr")
        engine_type = getattr(rapidocr, "RapidOCR")
        module_file = getattr(rapidocr, "__file__")
        if not isinstance(module_file, str) or not module_file:
            raise RuntimeError
        model_root = Path(module_file).resolve().parent / "models"
        if (not model_root.is_dir() or model_root.is_symlink()):
            raise RuntimeError
        params: dict[str, str] = {"Global.log_level": "error"}
        for key, name in _PACKAGED_MODELS.items():
            model_path = model_root / name
            if (model_path.is_symlink() or not model_path.is_file()
                    or not 0 < model_path.stat().st_size <= _MAX_MODEL_BYTES):
                raise RuntimeError
            params[key] = str(model_path)
        engine = engine_type(params=params)
    except Exception:
        raise RuntimeError("douyin_visual_locator_unavailable") from None
    return RapidOCRVisualLocator(engine=engine)
