# Design: Optional periodic CLI version metadata refresh

Status: implemented

> 最后核对: 2026-10-13 - 对应代码: 2.11.2 working tree
> 真源: cli-version-refresh

## Problem

A long-running service needs a way to check published CLI version information after it
starts. A scheduler armed only when enabled at startup cannot observe a later enable.
A setting missing from validation or persisted-state loading cannot control it.

## Decision

cliVersionAutoRefresh is a boolean runtime setting, default false. The settings API and
dashboard expose it and the stored value is read back after restart. Successful saves
notify the version scheduler, including false-to-true transitions while serving requests.

Enabling performs one npm metadata check and arms a six-hour unref interval. Disabling
clears the interval and aborts the in-flight check. A pending check is never overlapped;
re-enabling during cancellation starts one fresh check after it settles. Shutdown clears
the timer and subscription. Failed, invalid, timed-out or cancelled checks retain cache.

The cache is published CLI version information only. It neither installs a binary nor
changes the SDK UA or any request header.

This is the current behavior for the periodic metadata scheduler described by the
[existing periodic version note](../../.agents/notes/implemented/feature/2026-10-02-cli-fingerprint-periodic-align.md).
The existing note's claim that npm metadata updates the SDK UA is not the current contract.

## Alternatives considered

- Do nothing or reuse the startup-only scheduler: minimal wiring. A saved enable
  remains ineffective until restart and a missing setting cannot be selected at all.
- Poll settings continuously: avoids a subscription. It keeps a polling timer active
  while the feature is disabled and delays live changes.
- Fetch on every model request: provides frequent metadata. It adds unrelated network
  latency and failure modes to the chat path.

## Consequences

The disabled default produces no registry requests or refresh timers. Explicit enable
permits only registry metadata checks; this scheduler does not trigger model requests.
The dashboard explains the interval and the absence of binary installation or upgrades.
The setting subscription and cancellation state add lifecycle code that requires direct
transition tests. Metadata freshness cannot establish live upstream compatibility.

## Verification

The registered cli-version-refresh suite exercises the real settings save route, persistence,
enabled and disabled startup, live toggles, overlap prevention, cancellation and shutdown.
Injected fetch and timer functions cover failure and timeout behavior without external IO
or sleeps. The dashboard-version suite checks rendering, persistence requests and readback.
Execution and mutation checks are delegated to the parent Node22/Bun test environment.
