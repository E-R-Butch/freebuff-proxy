# Design: Preserve streaming RPC error summaries

Status: implemented

> 最后核对: 2026-10-13 - 对应代码: 2.11.2 working tree
> 真源: streaming-rpc-error-body

## Problem

The Bun chat endpoint streams successful SSE lines, but returns a non-200 response body in
the final chat summary. Clearing every summary body discards update-required and conflict
details before the downstream error classifier and response builder receive them.

## Decision

The streaming RPC adapter preserves chat.text for non-200 summaries, using the summary
status with the existing status-frame fallback. A 200 summary keeps an empty text field;
successful content has already been delivered through onLine.

## Alternatives considered

- Do nothing or reuse the empty summary: avoids changing the adapter, but loses the only
  copy of a non-200 body and hides actionable errors.
- Return summary text for every status: makes the branches uniform, but can deliver a
  second copy of successful streamed content.
- Add a retry on update-required: cannot recover missing response text and introduces
  another model request without a publicly established recovery predicate.

## Consequences

The adapter preserves existing status handling and normal SSE framing. Error text is
available to runStreamingRpc and downstream classification. This does not establish the
server predicate for a live 410 or claim that all update-required responses are fixed.

## Verification

The registered rpc-error-body suite supplies a fake Bun runner via FREEBUFF_BUN_BIN.
It covers 410 update-required, JSON and plain 409 bodies, summary-only status, successful
SSE framing, stop and DONE, the actual runStreamingRpc path, and one reuse call per request.
Execution and mutation checks are delegated to the parent Node22/Bun test environment.
