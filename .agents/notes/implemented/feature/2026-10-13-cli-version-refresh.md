# Agent Note: Optional CLI version metadata refresh

Status: implemented

## Problem

The request/settings behavior described in [the design](../../../../docs/design/cli-version-refresh.md) needs a maintained contract.

## Decision

Apply the narrow behavior and executable regression coverage described in [the design](../../../../docs/design/cli-version-refresh.md).

## Alternatives considered

- Do nothing: leaves the defects and missing configuration path present.
- Add broad retries or claim an npm metadata check upgrades a binary: changes unrelated behavior and misstates compatibility.

## Consequences

Runtime verification remains separate from mock verification. No live account data is part of this note.

## Verification

Use the registered protocol regression suite named in the design and the project verification gates.
