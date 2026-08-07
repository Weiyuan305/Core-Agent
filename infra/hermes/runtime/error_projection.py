"""Closed, non-reflective terminal failures for the managed Hermes gateway."""

from __future__ import annotations

from typing import Any


_RETRYABLE = {
    "model_busy": True,
    "model_service_unavailable": True,
    "model_response_timeout": True,
    "model_access_denied": False,
    "model_not_available": False,
    "model_response_invalid": False,
}

_KNOWN_CODES = tuple(_RETRYABLE)


def _normalized_attribute(error: object, name: str) -> str:
    try:
        value = getattr(error, name, None)
    except Exception:
        return ""
    if isinstance(value, (str, int)):
        return str(value).strip().lower()[:128]
    return ""


def _status_code(error: object) -> int | None:
    for name in ("status_code", "status", "http_status"):
        value = _normalized_attribute(error, name)
        if value.isdigit():
            status = int(value)
            if 100 <= status <= 599:
                return status
    return None


def _bounded_signal(error: object) -> str:
    values = [
        type(error).__name__,
        _normalized_attribute(error, "code"),
        _normalized_attribute(error, "type"),
    ]
    try:
        values.append(str(error))
    except Exception:
        pass
    return " ".join(values).lower()[:2_048]


def classify_provider_failure(error: object) -> str:
    """Classify an internal provider error without returning any raw value."""

    status = _status_code(error)
    signal = _bounded_signal(error)

    for code in _KNOWN_CODES:
        if code in signal:
            return code

    if status == 429 or any(
        marker in signal
        for marker in ("rate_limit", "rate limit", "too many requests", "overloaded", "capacity")
    ):
        return "model_busy"

    if status in (401, 403) or any(
        marker in signal
        for marker in ("unauthorized", "forbidden", "authentication", "permission denied", "access denied")
    ):
        return "model_access_denied"

    if status == 404 or any(
        marker in signal
        for marker in ("model_not_found", "model not found", "unknown model", "unsupported model")
    ):
        return "model_not_available"

    if status in (408, 504) or any(
        marker in signal
        for marker in ("timeout", "timed out", "deadline exceeded")
    ):
        return "model_response_timeout"

    if status in (500, 502, 503) or any(
        marker in signal
        for marker in ("service unavailable", "upstream unavailable", "connection refused", "connection reset")
    ):
        return "model_service_unavailable"

    return "model_response_invalid"


def project_terminal_failure(error: object, *, partial: bool) -> dict[str, Any]:
    """Return the complete allowlisted terminal record for one failed stream."""

    safe_code = classify_provider_failure(error)
    return {
        "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
        "hermes": {
            "completed": False,
            "partial": bool(partial),
            "failed": True,
            "error_code": safe_code,
            "retryable": _RETRYABLE[safe_code],
        },
    }
