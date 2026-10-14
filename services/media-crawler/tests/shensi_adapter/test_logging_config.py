import io
import logging
import multiprocessing
from contextlib import redirect_stderr


def _spawn_logging_probe(results) -> None:
    captured = io.StringIO()
    with redirect_stderr(captured):
        import shensi_adapter  # noqa: F401

        logging.getLogger("shensi_adapter.spawn_probe").info(
            "fresh_spawn_info_visible"
        )
    results.put(captured.getvalue())


def test_fresh_spawn_process_emits_application_info_to_stderr_once():
    context = multiprocessing.get_context("spawn")
    results = context.Queue()
    process = context.Process(target=_spawn_logging_probe, args=(results,))

    process.start()
    output = results.get(timeout=5)
    process.join(timeout=5)

    assert process.exitcode == 0
    assert output.count("fresh_spawn_info_visible") == 1
    assert "INFO shensi_adapter.spawn_probe fresh_spawn_info_visible" in output


def test_logging_configuration_is_idempotent_and_does_not_touch_root():
    from shensi_adapter.logging_config import (
        SHENSI_LOG_HANDLER_NAME,
        configure_shensi_logging,
    )

    root = logging.getLogger()
    original_root_level = root.level
    package_logger = logging.getLogger("shensi_adapter")

    configure_shensi_logging()
    configure_shensi_logging()

    handlers = [
        handler
        for handler in package_logger.handlers
        if handler.get_name() == SHENSI_LOG_HANDLER_NAME
    ]
    assert len(handlers) == 1
    assert package_logger.level == logging.INFO
    assert package_logger.propagate is False
    assert root.level == original_root_level

    captured = io.StringIO()
    handler = handlers[0]
    original_stream = handler.stream
    handler.setStream(captured)
    try:
        logging.getLogger("shensi_adapter.idempotency_probe").info(
            "idempotent_info_visible"
        )
    finally:
        handler.setStream(original_stream)

    assert captured.getvalue().count("idempotent_info_visible") == 1
