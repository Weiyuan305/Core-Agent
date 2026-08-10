"""Contract tests for Core-Agent's closed Hermes terminal projection."""

from __future__ import annotations

import json

import pytest

from core_agent_error_projection import project_terminal_failure


class ProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@pytest.mark.parametrize(
    ("error", "expected_code", "retryable"),
    [
        (ProviderError("busy", status_code=429), "model_busy", True),
        (ProviderError("upstream service unavailable"), "model_service_unavailable", True),
        (ProviderError("deadline", status_code=504), "model_response_timeout", True),
        (ProviderError("denied", status_code=403), "model_access_denied", False),
        (ProviderError("unknown model"), "model_not_available", False),
        (ProviderError("unrecognized provider failure"), "model_response_invalid", False),
    ],
)
def test_terminal_projection_classifies_all_public_codes(
    error: Exception,
    expected_code: str,
    retryable: bool,
) -> None:
    projection = project_terminal_failure(error, partial=False)

    assert projection == {
        "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
        "hermes": {
            "completed": False,
            "partial": False,
            "failed": True,
            "error_code": expected_code,
            "retryable": retryable,
        },
    }


@pytest.mark.parametrize("partial", [False, True])
def test_terminal_projection_preserves_only_boolean_partial(partial: bool) -> None:
    projection = project_terminal_failure(TimeoutError("timed out"), partial=partial)

    assert set(projection) == {"choices", "hermes"}
    assert projection["choices"] == [
        {"index": 0, "delta": {}, "finish_reason": "error"}
    ]
    assert set(projection["hermes"]) == {
        "completed",
        "partial",
        "failed",
        "error_code",
        "retryable",
    }
    assert projection["hermes"]["partial"] is partial


def test_terminal_projection_ignores_hostile_accessors_and_hidden_attributes() -> None:
    class HostileProviderError(Exception):
        secret_accesses = 0

        @property
        def status_code(self) -> int:
            raise RuntimeError("status-canary")

        @property
        def status(self) -> int:
            raise RuntimeError("status-canary")

        @property
        def http_status(self) -> int:
            raise RuntimeError("status-canary")

        @property
        def code(self) -> str:
            raise RuntimeError("code-canary")

        @property
        def type(self) -> str:
            raise RuntimeError("type-canary")

        @property
        def private_provider_credential(self) -> str:
            type(self).secret_accesses += 1
            raise AssertionError("reflection-canary")

        def __str__(self) -> str:
            raise RuntimeError("message-canary")

    error = HostileProviderError()
    projection = project_terminal_failure(error, partial=True)

    assert projection["hermes"]["error_code"] == "model_response_invalid"
    assert projection["hermes"]["partial"] is True
    assert HostileProviderError.secret_accesses == 0
    serialized = json.dumps(projection, sort_keys=True)
    assert "canary" not in serialized
    assert "credential" not in serialized


def test_terminal_projection_never_reflects_raw_provider_text() -> None:
    error = ProviderError(
        "credential-canary https://private.invalid model-canary traceback-canary"
    )

    projection = project_terminal_failure(error, partial=False)
    serialized = json.dumps(projection, sort_keys=True)

    assert projection["hermes"]["error_code"] == "model_response_invalid"
    for forbidden in (
        "credential-canary",
        "private.invalid",
        "model-canary",
        "traceback-canary",
        "message",
    ):
        assert forbidden not in serialized
    assert "error" not in projection
    assert "error" not in projection["hermes"]
