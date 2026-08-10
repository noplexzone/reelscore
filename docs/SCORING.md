# ReelScore scoring and competitive eligibility

ReelScore keeps diary history and competitive scoring as separate concerns. A watch can remain visible in history while contributing no points, trophies, streak progress, or future season progress.

## Watch points

Base watch points are calculated from metadata stored with the watch:

```text
100 × (vote_average / 10)² × clamp(runtime_minutes / 120, 0.5, 2)
```

The stored metadata snapshot is authoritative for reconciliation. Later TMDB changes do not rewrite historical awards.

For each user and TMDB movie, accepted events are ordered by immutable UTC instant and stable watch ID:

- canonical first watch: full base points;
- rewatch less than 30 days after the prior accepted event: zero points;
- rewatch outside the cooldown: 25% of base points;
- pending duplicate, competitively excluded duplicate, or deleted watch: zero points and no competitive qualification.

## Qualification matrix

| Watch state | Volume | Achievement | Streak | Future season |
| --- | ---: | ---: | ---: | ---: |
| Canonical first watch | yes | yes | yes | yes |
| Rewatch inside 30-day cooldown | no | no | no | no |
| Rewatch outside cooldown | no | no | yes | yes |
| Pending duplicate | no | no | no | no |
| Keep-separate duplicate | no | no | no | no |
| Deleted watch | no | no | no | no |

Pending, excluded, and deleted watches do not move the cooldown clock.

## Authoritative ledger

`score_events` is the lifetime score authority. `watches.points` and `achievements.points` remain compatibility projections, not the source used to calculate totals.

Awards are append-oriented:

1. An award records its category, points, rule version, source watch or achievement, and explanatory metadata.
2. Reconciliation never edits an award's point value.
3. Removing an award marks the original event reversed and appends one idempotent compensating event with the opposite point value.
4. Lifetime totals include original and compensation rows, so their algebraic sum is authoritative.

Legacy migration events preserve the exact stored total even when today's formula would produce another result.

## Achievements

Achievement progress counts unique, non-deleted watches with `qualifies_for_achievement=1`. Losing the only basis revokes the active trophy and appends a compensating ledger event; it does not delete the achievement record. Re-qualification reactivates the record and appends a new award generation.

Collection and filmography metadata is fetched before short write transactions. Manual logging fails without inserting the watch when metadata required for that watch is unavailable, making a retry atomic and safe. Existing dynamic trophies are retained when unrelated metadata is unavailable, and duplicate resolution remains pending rather than guessing.

## Timezones and streaks

Every user has an IANA timezone. Current streaks and streak trophies use distinct stored user-local calendar days, not elapsed 24-hour windows. Timezone changes derive local days again from immutable UTC instants, rebase duplicate fingerprints and ignore rules, repair affected eligibility, and reconcile static achievements in one transaction.

## Duplicate review

A newly inserted provider watch matching an active manual watch for the same user, TMDB movie, and local day receives its own pending review case before scoring. Every pending candidate is noncompetitive until one of these actions is applied atomically:

- **Merge:** retain provider provenance but soft-delete the candidate and link it to the manual canonical watch.
- **Keep both:** accept both events under normal first-watch/rewatch rules.
- **Keep separate:** retain both diary rows while permanently excluding the provider candidate from competition.
- **Keep both and ignore future matching:** accept the current pair and suppress future cases for the exact user/movie/local-day fingerprint.

See [`architecture/competitive-integrity.md`](architecture/competitive-integrity.md) for schema and reconciliation invariants.
