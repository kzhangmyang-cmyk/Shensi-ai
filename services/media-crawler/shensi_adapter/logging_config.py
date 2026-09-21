"""Process-local logging for the private Shensi adapter."""

from __future__ import annotations

import logging
import sys


SHENSI_LOG_HANDLER_NAME = "shensi-adapter-stderr"
_SHENSI_LOGGER_NAME = "shensi_adapter"
_SHENSI_LOG_FORMAT = "%(levelname)s %(name)s %(message)s"


def configure_shensi_logging() -> None:
    logger = logging.getLogger(_SHENSI_LOGGER_NAME)
    handler = next(
        (
            candidate
            for candidate in logger.handlers
            if candidate.get_name() == SHENSI_LOG_HANDLER_NAME
        ),
        None,
    )
    if handler is None:
        handler = logging.StreamHandler(sys.stderr)
        handler.set_name(SHENSI_LOG_HANDLER_NAME)
        logger.addHandler(handler)
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter(_SHENSI_LOG_FORMAT))
    logger.setLevel(logging.INFO)
    logger.propagate = False
