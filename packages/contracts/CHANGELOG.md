# Changelog

## 0.4.0 - 2026-08-07

- Add the closed `AgentRunFailureCode` vocabulary and expose it on Agent Run
  resources. Structural compatibility remains additive; producer and persistence
  invariants require it exactly for failed Runs.
- Add the optional `run.failed.payload.code` field so historical events remain
  readable while new producers can persist structured failure semantics.

## 0.3.0 - 2026-08-04

- Add the `runtime.command_accepted` ProductEvent branch with command-specific
  desired-state bindings.

## 0.2.0 - 2026-08-03

- Add bounded Message and CreateAgentRunRequest contracts plus the
  `message.created` ProductEvent family.
- Add the Runtime v1 stable error-code literals.

## 0.1.0 - 2026-08-03

- Establish wire schema version 1 for identity, runtime, trusted context,
  product events, audit events, errors, idempotency, and external references.
- Add generated JSON Schema, anonymous fixtures, and compatibility checks.
