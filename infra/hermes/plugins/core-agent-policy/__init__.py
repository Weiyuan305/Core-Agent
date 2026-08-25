"""Core-Agent's fail-closed policy hook for reviewed MCP tools."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
from typing import Any
from urllib import error, parse, request


_GATEWAY_PREFIX = "mcp__core_agent_gateway__"
_REVIEWED_TOOLS = {
    "mcp__core_agent_gateway__core_agent_synthetic_profile":
        "core_agent.synthetic_profile",
}
_PROOF_FIELD = "__core_agent_policy"
_DEFAULT_TOKEN_FILE = "/run/secrets/core_agent_policy_plugin_token"
_MAX_TOKEN_BYTES = 4096
_MAX_RESPONSE_BYTES = 8192
_MAX_ARGUMENT_PROPERTIES = 128
_BLOCK_MESSAGE = "This tool call was not authorized by Core-Agent policy."


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _block() -> dict[str, str]:
    return {"action": "block", "message": _BLOCK_MESSAGE}


def _load_token(path_value: str) -> str:
    path = Path(path_value)
    if not path.is_absolute():
        raise ValueError("token path must be absolute")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or stat.S_IMODE(before.st_mode) not in (0o400, 0o600)
            or before.st_size < 16
            or before.st_size > _MAX_TOKEN_BYTES
        ):
            raise ValueError("token file is unsafe")
        payload = bytearray()
        while len(payload) <= _MAX_TOKEN_BYTES:
            chunk = os.read(descriptor, min(1024, _MAX_TOKEN_BYTES + 1 - len(payload)))
            if not chunk:
                break
            payload.extend(chunk)
        after = os.fstat(descriptor)
        if (
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
            != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            or len(payload) != before.st_size
            or b"\x00" in payload
            or b"\r" in payload
            or b"\n" in payload
        ):
            raise ValueError("token file changed or is invalid")
        return bytes(payload).decode("utf-8")
    finally:
        os.close(descriptor)


def _decision_url() -> str:
    origin = os.environ.get("CORE_AGENT_POLICY_GATEWAY_ORIGIN", "").strip()
    parsed = parse.urlsplit(origin)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"policy-mcp-gateway", "127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("gateway origin is invalid")
    return origin.rstrip("/") + "/v1/policy/decisions"


def _parse_decision(payload: bytes) -> dict[str, Any]:
    if not payload or len(payload) > _MAX_RESPONSE_BYTES:
        raise ValueError("decision response size is invalid")

    def reject_duplicates(pairs):  # noqa: ANN001
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate response property")
            result[key] = value
        return result

    document = json.loads(payload.decode("utf-8"), object_pairs_hook=reject_duplicates)
    if type(document) is not dict or document.get("schema_version") != 1:
        raise ValueError("decision response is invalid")
    if document.get("decision") == "allow":
        if set(document) != {
            "schema_version", "decision_id", "decision", "reason",
            "execution_proof", "expires_at",
        }:
            raise ValueError("allow response is not closed")
        if (
            document.get("reason") != "POLICY_ALLOWED"
            or type(document.get("decision_id")) is not str
            or type(document.get("execution_proof")) is not str
            or not 24 <= len(document["execution_proof"]) <= 512
            or type(document.get("expires_at")) is not str
        ):
            raise ValueError("allow response is invalid")
        return document
    if document.get("decision") == "deny":
        if set(document) != {"schema_version", "decision_id", "decision", "reason"}:
            raise ValueError("deny response is not closed")
        if type(document.get("decision_id")) is not str or type(document.get("reason")) is not str:
            raise ValueError("deny response is invalid")
        return document
    raise ValueError("decision response is invalid")


def _post_decision(document: dict[str, Any]) -> dict[str, Any]:
    token_path = os.environ.get("CORE_AGENT_POLICY_PLUGIN_TOKEN_FILE", _DEFAULT_TOKEN_FILE)
    token = _load_token(token_path)
    payload = json.dumps(
        document, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    operation = request.Request(
        _decision_url(), data=payload, method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    opener = request.build_opener(_NoRedirect())
    with opener.open(operation, timeout=2.0) as response:
        if response.status != 200 or response.headers.get_content_type() != "application/json":
            raise ValueError("decision request failed")
        body = response.read(_MAX_RESPONSE_BYTES + 1)
    return _parse_decision(body)


def _on_pre_tool_call(
    tool_name="", args=None, task_id="", session_id="", tool_call_id="", **_,
):
    del task_id
    if not isinstance(tool_name, str) or not tool_name.startswith(_GATEWAY_PREFIX):
        return None
    public_name = _REVIEWED_TOOLS.get(tool_name)
    if public_name is None:
        return _block()
    if (
        type(args) is not dict
        or len(args) > _MAX_ARGUMENT_PROPERTIES
        or _PROOF_FIELD in args
        or type(session_id) is not str
        or not session_id
        or type(tool_call_id) is not str
        or not tool_call_id
    ):
        return _block()
    try:
        decision = _post_decision({
            "schema_version": 1,
            "hermes_session_ref": session_id,
            "tool_call_id": tool_call_id,
            "tool_name": public_name,
            "arguments": args,
        })
    except (OSError, UnicodeError, ValueError, TypeError, error.URLError, json.JSONDecodeError):
        return _block()
    if decision["decision"] != "allow":
        return _block()
    modified = dict(args)
    modified[_PROOF_FIELD] = decision["execution_proof"]
    return {"action": "modify", "args": modified}


def register(ctx):
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
