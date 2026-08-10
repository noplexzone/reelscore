# Competitive Integrity Foundation

## Status and scope

Migration 7 establishes the data contract for explainable, reversible scoring. The scoring-service integration now makes `score_events` authoritative for lifetime totals while preserving migrated algebraic totals exactly. Achievement eligibility and revocation still use the compatibility path until the next phase.

## Event and time model

`watches` remains the durable event history. Deletion will be represented by `deleted_at`, not loss of the row. `logical_canonical_watch_id` links every event for the same logical viewing identity to the established canonical watch while preserving each source event.

Canonical watch time consists of:

- `watched_at_utc`: the immutable instant in ISO UTC form;
- `watched_day_local`: the `YYYY-MM-DD` calendar day derived at ingestion;
- `timezone_used`: the valid IANA timezone used for that derivation.

Migration 7 interprets legacy timezone-free timestamps as UTC, sets `timezone_used` to `UTC`, derives the local day without consulting TMDB, and applies the same 30-day eligibility policy under the provenance version `competition-v1-backfill`. Future timezone changes apply only to future events. `server/src/time.js` validates IANA names through `Intl.DateTimeFormat` and derives calendar dates with formatted calendar parts, rather than fixed-hour arithmetic, so midnight and DST changes are handled by the runtime timezone database.

## Versioned eligibility

`competitive-v1` is a pure policy over events ordered by `(watched_at_utc, id)`, scoped by user and TMDB movie id. Its persisted outputs are explicit:

| Event state | Volume | Achievement | Streak | Season |
| --- | ---: | ---: | ---: | ---: |
| Canonical first, non-deleted watch | 1 | 1 | 1 | 1 |
| Rewatch less than 30 days after the prior accepted history event | 0 | 0 | 0 | 0 |
| Rewatch outside cooldown | 0 | 0 | 1 | 1 |
| Pending duplicate candidate | 0 | 0 | 0 | 0 |
| Deleted event | 0 | 0 | 0 | 0 |

Pending duplicate and deleted events do not move the cooldown clock. Eligibility outputs include the policy version and a stable reason. The pure evaluator accepts duplicate state as an input so later duplicate reconciliation can recompute the same fields without embedding policy in routes or SQL.

## Ledger contract

`score_events` is append-oriented. Rows identify a user and optionally a watch, achievement, and future season; record category, signed points, rule version, metadata snapshot, and creation time; and are reversed by setting `reversed_at` and appending one idempotent compensating row linked by `reverses_event_id`. Award points are never edited or deleted during normal scoring reconciliation; totals include both original and compensating rows. `season_id` is intentionally nullable and has no foreign key until the seasons schema is introduced; adding an SQLite reference to a table that does not yet exist makes the current database schema unusable with foreign keys enabled.

Migration 7 creates one `legacy-v1` row for every stored watch and achievement, including zero-point explanatory events. Metadata is built only from stored columns. Unique deterministic `event_key` values make this backfill idempotent, and `achievements.score_event_id` points at its imported award. This ledger import preserves the exact algebraic sum, including negative stored values. Runtime totals now sum lifetime ledger rows, including compensating reversals; `watches.points` remains a compatibility projection rather than the score source.


## Runtime watch reconciliation

Manual logging and provider imports insert the immutable watch record, derive local-day fields, evaluate eligibility, and append the award in one SQLite transaction. First watches, cooldown rewatches, and paid rewatches receive distinct categories, including zero-point explanatory events whose metadata snapshots the stored rating, runtime, timestamp, source, calculation, and reason.

Reconciliation is deterministic per `(user_id, tmdb_id)` timeline. A late import, duplicate-pending transition, or soft deletion sets the prior award's `reversed_at`, appends one idempotent negative compensating event, and issues a replacement only when required. Unchanged `legacy-v1` awards retain their historical stored values even when the current formula would differ. Deleted events remain in history, are excluded from read projections, and no longer affect watch points or the interim UTC streak calculation. Placeholder reconciliation retains the provider event as a soft-deleted provenance row linked to the surviving canonical watch.

## Duplicate review contract

`duplicate_cases` stores a durable fingerprint, canonical/candidate watch references, evidence, pending/resolved state, and one of the supported resolutions: `merge`, `keep_both`, `keep_separate`, or `ignore_future_matching`. `duplicate_ignore_rules` is scoped by user and fingerprint. Later services own candidate detection and idempotent resolution; migration 7 only creates the durable schema.

## Migration safety and invariants

- Version 7 runs through the existing verified `VACUUM INTO` backup gate for any populated database.
- All schema additions are conditional or `IF NOT EXISTS`, and ledger imports use unique identities plus `INSERT OR IGNORE`.
- Existing users, watches, achievements, relationships, and stored point columns are preserved; the authoritative runtime total moves from mutable projections to the equivalent ledger sum.
- Foreign keys protect user/watch/achievement references; indexes support active user totals, source award lookup, pending duplicate queues, and ignore-rule matching.
- Migration backfill is deterministic and performs no network calls.
