# ADR 0007: isolate synthetic contract fixtures from quality holdouts

- Status: Accepted
- Date: 2026-09-29
- Scope: `server/cmd/eval/manifest.go`

## Context

Promotion counts require verified holdout annotations. A manifest could mark a
synthetic fixture as a verified holdout and have it counted as product-quality
evidence, despite synthetic fixtures being intended only for contract tests.

## Decision

Synthetic fixtures must use the `contract` split and `contract-test`
annotation. Both manifest validation and the promotion-eligibility predicate
reject synthetic records from development and holdout splits.

## Consequences

Synthetic data remains useful for model-free contract regressions but cannot
increase product holdout or promotion-eligible counts. Product-quality
promotion still requires verified, non-synthetic holdout data.

## Evidence

Go tests reject a synthetic verified holdout at load time and at the promotion
predicate boundary.
