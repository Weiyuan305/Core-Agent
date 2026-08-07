#!/usr/bin/env python3
"""Install the Core-Agent terminal projection into one pinned Hermes source."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import sys
import tempfile


TARGET_PATH = Path("/opt/hermes/gateway/platforms/api_server.py")
EXPECTED_UPSTREAM_SHA256 = "2d5526cd830e6aebcaecc0d9083cfd3aa63bdcfacc2389b7beec6ca32ae99dd8"

UPSTREAM_IMPORT_ANCHOR = "from gateway.readiness import collect_runtime_readiness\n"
MANAGED_IMPORT = (
    "from gateway.readiness import collect_runtime_readiness\n"
    "from core_agent_error_projection import project_terminal_failure\n"
)

UPSTREAM_STREAM_TERMINAL_BLOCK = '''            # Finish chunk
            finish_chunk = {
                "id": completion_id, "object": "chat.completion.chunk",
                "created": created, "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                "usage": {
                    "prompt_tokens": usage.get("input_tokens", 0),
                    "completion_tokens": usage.get("output_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                },
            }
            if finish_reason != "stop":
                finish_chunk["choices"][0]["delta"] = {}
                if err_msg:
                    finish_chunk["error"] = {
                        "message": err_msg,
                        "type": type(agent_error).__name__ if agent_error else "agent_error",
                    }
                finish_chunk["hermes"] = {
                    "completed": completed,
                    "partial": is_partial,
                    "failed": is_failed,
                    "error": err_msg,
                    "error_code": "output_truncated" if finish_reason == "length" else "agent_error",
                }
            await response.write(f"data: {json.dumps(finish_chunk)}\\n\\n".encode())
'''

MANAGED_STREAM_TERMINAL_BLOCK = '''            # Successful terminals retain the upstream OpenAI shape. Failed
            # terminals use the closed Core-Agent projection and never reflect
            # provider text, request metadata, or credentials.
            if finish_reason == "stop":
                finish_chunk = {
                    "id": completion_id, "object": "chat.completion.chunk",
                    "created": created, "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                    "usage": {
                        "prompt_tokens": usage.get("input_tokens", 0),
                        "completion_tokens": usage.get("output_tokens", 0),
                        "total_tokens": usage.get("total_tokens", 0),
                    },
                }
            else:
                failure = err_msg if err_msg is not None else agent_error
                finish_chunk = project_terminal_failure(failure, partial=is_partial)
            await response.write(f"data: {json.dumps(finish_chunk)}\\n\\n".encode())
'''

UPSTREAM_STREAM_CRASH_BLOCK = '''            import traceback as _tb
            logger.error("Agent crashed mid-stream for %s: %s", completion_id, _tb.format_exc()[:300])
            try:
                error_chunk = {
                    "id": completion_id, "object": "chat.completion.chunk",
                    "created": created, "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
                }
                await response.write(f"data: {json.dumps(error_chunk)}\\n\\n".encode())
'''

MANAGED_STREAM_CRASH_BLOCK = '''            logger.error(
                "Agent crashed mid-stream for %s; failure_code=model_response_invalid",
                completion_id,
            )
            try:
                error_chunk = project_terminal_failure(_exc, partial=True)
                await response.write(f"data: {json.dumps(error_chunk)}\\n\\n".encode())
'''

UPSTREAM_AGENT_ERROR_LOG = '''                logger.error(
                    "Agent task %s failed during SSE streaming: %s", completion_id, exc
                )
'''

MANAGED_AGENT_ERROR_LOG = '''                logger.error(
                    "Agent task %s failed during SSE streaming; failure_code=model_response_invalid",
                    completion_id,
                )
'''


class OverlayInstallError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _replace_once(source: str, before: str, after: str) -> str:
    if source.count(before) != 1:
        raise OverlayInstallError("HERMES_PATCH_CONTEXT_INVALID")
    return source.replace(before, after, 1)


def _patched_source(source: str) -> str:
    source = _replace_once(source, UPSTREAM_IMPORT_ANCHOR, MANAGED_IMPORT)
    source = _replace_once(
        source,
        UPSTREAM_AGENT_ERROR_LOG,
        MANAGED_AGENT_ERROR_LOG,
    )
    source = _replace_once(
        source,
        UPSTREAM_STREAM_TERMINAL_BLOCK,
        MANAGED_STREAM_TERMINAL_BLOCK,
    )
    return _replace_once(
        source,
        UPSTREAM_STREAM_CRASH_BLOCK,
        MANAGED_STREAM_CRASH_BLOCK,
    )


def install_overlay(
    target: str | os.PathLike[str] = TARGET_PATH,
    *,
    expected_sha256: str = EXPECTED_UPSTREAM_SHA256,
) -> None:
    path = Path(target)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise OverlayInstallError("HERMES_PATCH_TARGET_INVALID") from error
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise OverlayInstallError("HERMES_PATCH_TARGET_INVALID")

    try:
        source_bytes = path.read_bytes()
    except OSError as error:
        raise OverlayInstallError("HERMES_PATCH_TARGET_INVALID") from error
    if hashlib.sha256(source_bytes).hexdigest() != expected_sha256:
        raise OverlayInstallError("HERMES_PATCH_SOURCE_MISMATCH")

    try:
        source = source_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise OverlayInstallError("HERMES_PATCH_SOURCE_INVALID") from error
    patched = _patched_source(source)

    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=".core-agent-api-server-",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(patched)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, stat.S_IMODE(metadata.st_mode))
        os.replace(temporary_name, path)
        temporary_name = None
    except OSError as error:
        raise OverlayInstallError("HERMES_PATCH_WRITE_FAILED") from error
    finally:
        if temporary_name is not None:
            try:
                os.unlink(temporary_name)
            except OSError:
                pass


def _parse_target(argv: list[str]) -> Path:
    if not argv:
        return TARGET_PATH
    if len(argv) == 2 and argv[0] == "--target" and argv[1]:
        return Path(argv[1])
    raise OverlayInstallError("HERMES_PATCH_ARGUMENTS_INVALID")


def main(argv: list[str] | None = None) -> int:
    try:
        install_overlay(_parse_target(list(sys.argv[1:] if argv is None else argv)))
    except OverlayInstallError as error:
        sys.stderr.write(f"{error.code}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
