# Agent Note: Report the official client version on session requests

Status: implemented

## Problem

Session requests carried no caller version, so the upstream had no way to read
which client generation was calling. A current release states its own version on
these requests through a dedicated header, and the value it states is the released
client's version, not any other number. Omitting it left the request shape
different from the client this proxy mirrors.

## Decision

Session, admission and release requests carry the caller-version header, filled
from the cached official client version. That cache starts at the current released
version and is refreshed from the published release metadata when the optional
check is enabled. The proxy package's own version never appears on the wire.

The value is a version identity, nothing else: no capability header, no binary
installation and no change to the chat user agent.

## Alternatives considered

- Send nothing: matches an older capture, but leaves the caller version absent on
  requests where a current client states it.
- Send the proxy package version: honest about the proxy, and wrong for this
  header, because the header describes the calling client generation. It also
  marks every request as coming from something other than the mirrored client.
- Send a hard-coded version: freezes the value and silently rots on the next
  release, which is the failure this note exists to prevent.

## Consequences

The header tracks the published client version instead of a frozen literal, so a
release no longer requires a code edit. Cached-value freshness now matters: an
enabled metadata check keeps it current, and a disabled one leaves the built-in
value in place.

## Verification

The registered protocol suite asserts the header equals the cached official
version, that it is not the proxy package version, and that other request shapes
do not gain it. Live acceptance against the upstream remains a separate step.
