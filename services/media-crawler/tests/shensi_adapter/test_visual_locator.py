from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import numpy as np

from shensi_adapter.visual_locator import (
    RapidOCRVisualLocator,
    VisualLocatorFailure,
    configured_visual_locator,
    create_visual_locator,
)


NOW = datetime(2026, 8, 28, tzinfo=UTC)


@dataclass
class EngineOutput:
    txts: object
    scores: object
    boxes: object


class FakeEngine:
    def __init__(self, output: EngineOutput):
        self.output = output
        self.images: list[bytes] = []

    def __call__(self, image: bytes):
        self.images.append(image)
        return self.output


class FakeControl:
    def __init__(self, *, text="发私信", role="button", tag="button",
                 visible=True, enabled=True):
        self.text = text
        self.role = role
        self.tag = tag
        self.visible = visible
        self.enabled = enabled

    def text_content(self, **_kwargs):
        return self.text

    def get_attribute(self, name, **_kwargs):
        return self.role if name == "role" else None

    def evaluate(self, _expression):
        return self.tag

    def is_visible(self, **_kwargs):
        return self.visible

    def is_enabled(self, **_kwargs):
        return self.enabled


class FakeHandle:
    def __init__(self, control):
        self.control = control

    def as_element(self):
        return self.control

    def dispose(self):
        return None


class FakePage:
    def __init__(self, control=None, *, screenshot=b"png",
                 viewport=None):
        self.control = control
        self.screenshot_bytes = screenshot
        self.viewport_size = viewport or {"width": 1280, "height": 720}
        self.screenshot_calls = 0
        self.rebind_points: list[dict[str, float]] = []

    def screenshot(self, **kwargs):
        assert kwargs == {"type": "png", "animations": "disabled"}
        self.screenshot_calls += 1
        return self.screenshot_bytes

    def evaluate_handle(self, _script, point):
        self.rebind_points.append(point)
        return FakeHandle(self.control)


def output(text="发私信", score=0.99, box=None):
    return EngineOutput(
        txts=[text],
        scores=[score],
        boxes=[box or [[10, 10], [110, 10], [110, 50], [10, 50]]],
    )


@pytest.mark.parametrize(("raw", "expected"), [
    (None, "disabled"),
    ("disabled", "disabled"),
    ("rapidocr", "rapidocr"),
])
def test_visual_locator_configuration_is_a_closed_enum(raw, expected):
    assert configured_visual_locator(raw) == expected


@pytest.mark.parametrize("raw", ["", "RAPIDOCR", " rapidocr ", "ocr", 1])
def test_visual_locator_configuration_rejects_every_other_value(raw):
    with pytest.raises(ValueError, match="visual locator"):
        configured_visual_locator(raw)


@pytest.mark.parametrize(("purpose", "text"), [
    ("direct_message_entry", "  发 \n 私信 "),
    ("direct_message_entry", "\t私 信"),
    ("direct_message_submit", " 发 \n送 "),
])
def test_rapidocr_rebinds_one_normalized_exact_high_confidence_candidate(
    purpose,
    text,
):
    expected = "发送" if purpose.endswith("submit") else text.replace(
        " ", ""
    ).replace("\n", "").replace("\t", "")
    control = FakeControl(text=expected)
    engine = FakeEngine(output(text=text))
    page = FakePage(control)

    bound = RapidOCRVisualLocator(engine=engine, now=lambda: NOW).locate_control(
        page,
        purpose=purpose,
        deadline_at=NOW + timedelta(seconds=1),
    )

    assert bound is control
    assert engine.images == [b"png"]
    assert page.screenshot_calls == 1
    assert page.rebind_points == [{"x": 60.0, "y": 30.0}]


def test_rapidocr_rebind_accepts_a_real_playwright_element_handle():
    """Regression: ElementHandle APIs reject Locator-only timeout kwargs."""
    playwright = pytest.importorskip("playwright.sync_api")
    with playwright.sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 320, "height": 240})
            page.set_content(
                '<button style="position:fixed;left:20px;top:20px;'
                'width:120px;height:48px">发送</button>'
            )

            control = RapidOCRVisualLocator._rebind(
                page,
                x=80,
                y=44,
                expected_label="发送",
            )

            assert control.text_content() == "发送"
        finally:
            browser.close()


def test_rapidocr_accepts_the_pinned_engines_numpy_box_shape():
    engine = FakeEngine(EngineOutput(
        txts=("发私信",),
        scores=(0.99,),
        boxes=np.array([[
            [10, 10], [110, 10], [110, 50], [10, 50],
        ]], dtype=np.float32),
    ))
    control = FakeControl()

    bound = RapidOCRVisualLocator(
        engine=engine,
        now=lambda: NOW,
    ).locate_control(
        FakePage(control),
        purpose="direct_message_entry",
        deadline_at=NOW + timedelta(seconds=1),
    )

    assert bound is control


@pytest.mark.parametrize("text", ["发私信给TA", "点击发私信", "发送中", "Send"])
def test_rapidocr_rejects_non_exact_labels(text):
    locator = RapidOCRVisualLocator(
        engine=FakeEngine(output(text=text)), now=lambda: NOW,
    )

    with pytest.raises(VisualLocatorFailure, match="control_missing"):
        locator.locate_control(
            FakePage(FakeControl()),
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )


@pytest.mark.parametrize("score", [True, -0.1, 0.0, 0.899999, 1.01, float("nan")])
def test_rapidocr_rejects_invalid_or_low_confidence_candidates(score):
    locator = RapidOCRVisualLocator(
        engine=FakeEngine(output(score=score)), now=lambda: NOW,
    )

    with pytest.raises(VisualLocatorFailure, match="control_missing"):
        locator.locate_control(
            FakePage(FakeControl()),
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )


@pytest.mark.parametrize("box", [
    [[-1, 10], [110, 10], [110, 50], [10, 50]],
    [[10, 10], [1281, 10], [110, 50], [10, 50]],
    [[10, 10], [110, 10], [110, 721], [10, 50]],
    [[10, 10], [10, 10], [10, 10], [10, 10]],
    [[10, 10], [110, 10], [110, 50]],
])
def test_rapidocr_rejects_out_of_viewport_or_malformed_coordinates(box):
    locator = RapidOCRVisualLocator(
        engine=FakeEngine(output(box=box)), now=lambda: NOW,
    )

    with pytest.raises(VisualLocatorFailure, match="control_missing"):
        locator.locate_control(
            FakePage(FakeControl()),
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )


def test_rapidocr_rejects_multiple_matching_candidates_without_rebind():
    engine = FakeEngine(EngineOutput(
        txts=["发私信", "私信"],
        scores=[0.99, 0.98],
        boxes=[
            [[10, 10], [110, 10], [110, 50], [10, 50]],
            [[210, 10], [310, 10], [310, 50], [210, 50]],
        ],
    ))
    page = FakePage(FakeControl())

    with pytest.raises(VisualLocatorFailure, match="control_ambiguous"):
        RapidOCRVisualLocator(engine=engine, now=lambda: NOW).locate_control(
            page,
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )

    assert page.rebind_points == []


@pytest.mark.parametrize("page", [
    FakePage(FakeControl(), screenshot=b"x" * (8 * 1024 * 1024 + 1)),
    FakePage(FakeControl(), viewport={"width": 4097, "height": 720}),
    FakePage(FakeControl(), viewport={"width": 1280, "height": 4097}),
])
def test_rapidocr_bounds_screenshot_and_viewport(page):
    locator = RapidOCRVisualLocator(
        engine=FakeEngine(output()), now=lambda: NOW,
    )

    with pytest.raises(VisualLocatorFailure, match="control_missing"):
        locator.locate_control(
            page,
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )


def test_rapidocr_bounds_total_candidates_before_rebind():
    candidate_count = 101
    engine = FakeEngine(EngineOutput(
        txts=["无关"] * candidate_count,
        scores=[0.99] * candidate_count,
        boxes=[[[10, 10], [20, 10], [20, 20], [10, 20]]] * candidate_count,
    ))
    page = FakePage(FakeControl())

    with pytest.raises(VisualLocatorFailure, match="control_ambiguous"):
        RapidOCRVisualLocator(engine=engine, now=lambda: NOW).locate_control(
            page,
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )

    assert page.rebind_points == []


@pytest.mark.parametrize("control", [
    None,
    FakeControl(text="发私信给TA"),
    FakeControl(role="link", tag="a"),
    FakeControl(visible=False),
    FakeControl(enabled=False),
])
def test_rapidocr_requires_exact_visible_enabled_button_dom_rebind(control):
    page = FakePage(control)

    with pytest.raises(VisualLocatorFailure, match="control_missing"):
        RapidOCRVisualLocator(
            engine=FakeEngine(output()), now=lambda: NOW,
        ).locate_control(
            page,
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )


def test_rapidocr_deadline_is_checked_before_screenshot_and_after_engine():
    page = FakePage(FakeControl())
    with pytest.raises(VisualLocatorFailure, match="deadline_exceeded"):
        RapidOCRVisualLocator(
            engine=FakeEngine(output()), now=lambda: NOW,
        ).locate_control(
            page,
            purpose="direct_message_entry",
            deadline_at=NOW,
        )
    assert page.screenshot_calls == 0

    moments = iter([NOW, NOW, NOW + timedelta(seconds=2)])
    page = FakePage(FakeControl())
    with pytest.raises(VisualLocatorFailure, match="deadline_exceeded"):
        RapidOCRVisualLocator(
            engine=FakeEngine(output()), now=lambda: next(moments),
        ).locate_control(
            page,
            purpose="direct_message_entry",
            deadline_at=NOW + timedelta(seconds=1),
        )
    assert page.screenshot_calls == 1
    assert page.rebind_points == []


def test_configured_rapidocr_dependency_failure_is_closed(monkeypatch):
    def missing_dependency(_name):
        raise ModuleNotFoundError("sensitive dependency diagnostic")

    monkeypatch.setattr("shensi_adapter.visual_locator.import_module", missing_dependency)

    with pytest.raises(RuntimeError, match="douyin_visual_locator_unavailable") as error:
        create_visual_locator("rapidocr")

    assert "sensitive dependency diagnostic" not in str(error.value)


def test_configured_rapidocr_uses_only_validated_packaged_model_paths(
    tmp_path,
    monkeypatch,
):
    package = tmp_path / "rapidocr"
    models = package / "models"
    models.mkdir(parents=True)
    package_init = package / "__init__.py"
    package_init.write_text("", encoding="utf-8")
    expected = {
        "Det.model_path": models / "PP-OCRv6_det_small.onnx",
        "Cls.model_path": models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "Rec.model_path": models / "PP-OCRv6_rec_small.onnx",
    }
    for model in expected.values():
        model.write_bytes(b"packaged-model")
    constructions = []

    class FakeRapidOCR:
        def __init__(self, **kwargs):
            constructions.append(kwargs)

    fake_module = type("FakeRapidOCRModule", (), {
        "__file__": str(package_init),
        "RapidOCR": FakeRapidOCR,
    })()
    monkeypatch.setattr(
        "shensi_adapter.visual_locator.import_module",
        lambda name: fake_module if name == "rapidocr" else None,
    )

    locator = create_visual_locator("rapidocr")

    assert isinstance(locator, RapidOCRVisualLocator)
    assert constructions == [{"params": {
        **{key: str(value) for key, value in expected.items()},
        "Global.log_level": "error",
    }}]


@pytest.mark.parametrize("invalid", ["missing", "symlink"])
def test_configured_rapidocr_rejects_missing_or_symlinked_packaged_models(
    tmp_path,
    monkeypatch,
    invalid,
):
    package = tmp_path / "rapidocr"
    models = package / "models"
    models.mkdir(parents=True)
    package_init = package / "__init__.py"
    package_init.write_text("", encoding="utf-8")
    names = [
        "PP-OCRv6_det_small.onnx",
        "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        "PP-OCRv6_rec_small.onnx",
    ]
    for name in names[1:]:
        (models / name).write_bytes(b"packaged-model")
    if invalid == "symlink":
        (models / "target.onnx").write_bytes(b"packaged-model")
        (models / names[0]).symlink_to(models / "target.onnx")
    constructions = []
    fake_module = SimpleNamespace(
        __file__=str(package_init),
        RapidOCR=lambda **kwargs: constructions.append(kwargs),
    )
    monkeypatch.setattr(
        "shensi_adapter.visual_locator.import_module",
        lambda _name: fake_module,
    )

    with pytest.raises(RuntimeError, match="douyin_visual_locator_unavailable"):
        create_visual_locator("rapidocr")
    assert constructions == []


def test_disabled_visual_locator_never_imports_optional_dependency(monkeypatch):
    monkeypatch.setattr(
        "shensi_adapter.visual_locator.import_module",
        lambda _name: pytest.fail("disabled OCR must stay lightweight"),
    )

    assert create_visual_locator("disabled") is None
