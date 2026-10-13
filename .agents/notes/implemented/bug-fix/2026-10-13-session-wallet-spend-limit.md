# Agent Note: Send the current session spend-limit value on admission

Status: implemented

## Problem

POST /api/v1/freebuff/session/admission carried `x-freebuff-wallet-spend-limit: 0`.
That value came from a client capture taken before the field changed. A current
official release mints the same request with the literal string `session` instead
of a number, so the proxy was presenting a retired request shape on the one
endpoint that establishes a paid hour. The same value was hard-coded in the Node
side request-header assembly, so both transports needed the correction.

## Decision

Both transports send `session`. The Node helper keeps an override parameter for
tests, but its default is the current official value. No numeric fallback remains,
because a numeric value is the retired shape.

## Alternatives considered

- Keep `0`: it is what the older capture shows, and the field is not documented as
  a gate. Retaining a retired value leaves the request shape provably different
  from the shipping client on the admission path.
- Send both a numeric and a string value: the header is single-valued, and a
  duplicated shape is not something any real client emits.

## Consequences

The admission request now matches the current official client on this field.
Protocol shape alone does not prove the upstream accepts the proxy; acceptance is
established only by a live single-session run. The reverse-engineering documents
that quoted the older value describe a capture, not the current contract.

## Verification

Registered protocol regressions assert the exact header value on the POST path
and that other methods do not gain it. Live acceptance remains separate.
