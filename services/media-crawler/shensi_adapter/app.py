import os
from collections.abc import Callable

from fastapi import FastAPI, Header

from .schemas import HealthView
from .security import authorize_bearer, require_service_secret


UPSTREAM_COMMIT = "d6f7c5bb906b6dac40ddf343ef9e26438a3de092"


def _build_app(secret_provider: Callable[[], str]) -> FastAPI:
    application = FastAPI(docs_url=None, openapi_url=None, redoc_url=None)

    @application.get("/internal/v1/health", response_model=HealthView)
    def health(authorization: str | None = Header(default=None)) -> HealthView:
        authorize_bearer(authorization, require_service_secret(secret_provider()))
        return HealthView(
            ok=True,
            service="shensi-mediacrawler",
            upstream_commit=UPSTREAM_COMMIT,
        )

    return application


def create_app(service_secret: str) -> FastAPI:
    normalized_secret = require_service_secret(service_secret)
    return _build_app(lambda: normalized_secret)


app = _build_app(lambda: os.environ.get("MEDIACRAWLER_SERVICE_SECRET", ""))
