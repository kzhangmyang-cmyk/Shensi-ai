import hmac

from fastapi import HTTPException, status


def require_service_secret(value: str) -> str:
    if any(character.isspace() for character in value) or len(
        value.encode("utf-8")
    ) < 32:
        raise ValueError(
            "MEDIACRAWLER_SERVICE_SECRET must contain at least 32 non-whitespace bytes"
        )
    return value


def authorize_bearer(authorization: str | None, service_secret: str) -> None:
    expected = f"Bearer {service_secret}"
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="unauthorized",
        )
