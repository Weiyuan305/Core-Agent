from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


PLUGIN = Path(__file__).parents[1] / "__init__.py"
SPEC = importlib.util.spec_from_file_location("core_agent_policy_plugin", PLUGIN)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PolicyPluginTests(unittest.TestCase):
    def test_non_gateway_tool_is_unchanged(self):
        self.assertIsNone(MODULE._on_pre_tool_call(tool_name="clarify", args={}))

    def test_allow_injects_exact_proof_without_mutating_original(self):
        arguments = {"profile_ref": "demo"}
        allow = {
            "schema_version": 1,
            "decision_id": "decision-1",
            "decision": "allow",
            "reason": "POLICY_ALLOWED",
            "execution_proof": "p" * 43,
            "expires_at": "2026-08-25T10:00:00.000Z",
        }
        with mock.patch.object(MODULE, "_post_decision", return_value=allow) as post:
            result = MODULE._on_pre_tool_call(
                tool_name="mcp__core_agent_gateway__core_agent_synthetic_profile",
                args=arguments,
                session_id="hermes-session-1",
                tool_call_id="tool-call-1",
            )
        self.assertEqual(arguments, {"profile_ref": "demo"})
        self.assertEqual(result, {
            "action": "modify",
            "args": {"profile_ref": "demo", "__core_agent_policy": "p" * 43},
        })
        self.assertEqual(post.call_args.args[0]["tool_call_id"], "tool-call-1")

    def test_denial_failures_unknown_tools_and_caller_proofs_all_block(self):
        cases = [
            {"tool_name": "mcp__core_agent_gateway__unknown", "args": {}},
            {
                "tool_name": "mcp__core_agent_gateway__core_agent_synthetic_profile",
                "args": {"__core_agent_policy": "forged"},
                "session_id": "session-1", "tool_call_id": "call-1",
            },
            {
                "tool_name": "mcp__core_agent_gateway__core_agent_synthetic_profile",
                "args": {}, "session_id": "", "tool_call_id": "call-1",
            },
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(MODULE._on_pre_tool_call(**case)["action"], "block")
        with mock.patch.object(MODULE, "_post_decision", side_effect=OSError("secret detail")):
            result = MODULE._on_pre_tool_call(
                tool_name="mcp__core_agent_gateway__core_agent_synthetic_profile",
                args={}, session_id="session-1", tool_call_id="call-1",
            )
        self.assertEqual(result, {"action": "block", "message": MODULE._BLOCK_MESSAGE})

    def test_token_file_requires_private_regular_unchanged_single_line_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "token"
            path.write_text("x" * 32, encoding="utf-8")
            os.chmod(path, 0o600)
            self.assertEqual(MODULE._load_token(str(path)), "x" * 32)
            os.chmod(path, 0o644)
            with self.assertRaises(ValueError):
                MODULE._load_token(str(path))

    def test_decision_response_is_closed_and_rejects_duplicate_keys(self):
        valid = (
            b'{"decision":"allow","decision_id":"d","execution_proof":"'
            + b"p" * 43
            + b'","expires_at":"2026-08-25T10:00:00Z","reason":"POLICY_ALLOWED","schema_version":1}'
        )
        self.assertEqual(MODULE._parse_decision(valid)["decision"], "allow")
        with self.assertRaises(ValueError):
            MODULE._parse_decision(valid[:-1] + b',"decision":"allow"}')
        with self.assertRaises(ValueError):
            MODULE._parse_decision(valid[:-1] + b',"extra":true}')


if __name__ == "__main__":
    unittest.main()
