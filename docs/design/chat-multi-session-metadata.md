# Design: Match chat metadata to the admitted session protocol

Status: implemented

> 最后核对: 2026-10-13 - 对应代码: 2.11.2 working tree
> 真源: chat-multi-session-metadata

## Problem

Session requests use multi-session headers for desktop UUIDs as well as CLI claims.
Fallback chat metadata tied that protocol flag to the CLI prefix, selecting inconsistent
session protocols for a desktop session and its next chat request.

## Decision

Fallback chat sets freebuff_multi_session to the string 1 for a non-empty string instance
ID. The CLI surface remains limited to CLI claims. Both fields are derived from the active
instance, replacing downstream metadata left over from another session.

The public model constants describe the matching session-header and chat-metadata pair.
This is source evidence for protocol consistency, not a live server acceptance result.

## Alternatives considered

- Do nothing or reuse the CLI-only condition: preserves a smaller branch but disagrees
  with the existing desktop session protocol.
- Mark every request as CLI: supplies the flag but falsely labels desktop sessions.
- Re-admit on every mismatch: may create another paid session and does not repair the
  request metadata used with the next session.

## Consequences

Unrelated downstream metadata survives. Empty identities do not inherit a protocol or CLI
marker. This changes request construction without adding session creation or retry logic.

## Verification

The registered multi-session suite covers bare UUID, CLI claim and empty identities,
all three Node session methods, and actual fallback forwarding with a recording transport.
It checks a single chat call, intact success SSE and non-recoverable ordinary conflicts.
Execution and mutation checks are delegated to the parent Node22/Bun test environment.
