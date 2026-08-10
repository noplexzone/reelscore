# Competitive Experience Design

## Outcome

Phase 2 turns ReelScore's integrity foundation into private fantasy leagues with immutable seasons, season-scoped score projections, useful leaderboards, and challenge bonuses. Lifetime diary scoring remains independent and authoritative for lifetime views.

## Product contract

### Leagues and membership

- Leagues are private. Discovery is limited to memberships and explicit invite links.
- Effective roles are `owner`, `admin`, and `member`. `leagues.owner_user_id` is the sole authoritative owner identity; membership rows store only `admin` or `member`. League creation and ownership transfer synchronize the owner identity and active membership in one immediate transaction.
- Owners can archive the league, transfer ownership, manage administrators, seasons, and invites. Administrators can manage member invites and seasons but cannot transfer ownership or archive the league. Members can read league competition data and leave.
- League membership is represented as immutable membership episodes. Joining creates a new episode; leaving closes it. Rejoining never rewrites the previous interval.
- When a season activates, it snapshots `season_members` from membership episodes already active at the exact season start, including an immutable username/display snapshot for historical standings, then sets immutable `participants_locked_at` in the same transaction. The marker prevents later participant insertion/deletion while one-way eligibility cutoffs remain possible. Users joining at or after the start instant can view the active season but do not participate until the next one.
- Leaving or removal during a season closes that participant's eligibility window. Earned points remain; later watches stop counting; rejoining the league does not reactivate that season.
- A watch can enter a season only when its immutable watched instant is inside both the season interval and the participant's eligibility window. Late imports inside those intervals reconcile during the active/finalizing lifecycle. Watches from before the season or participant window never become league points.

### Invite links

- Invite secrets are random, displayed only when created, and stored only as keyed hashes.
- Invites are league-scoped and member-role only. Expiry and capacity are immutable, revocation is one-way, and transactionally recorded consumption is rejected after expiry or revocation. An undeletable invite-use row makes capacity enforcement and distinct-user idempotency auditable.
- Invite inspection reveals only the league name and expiration before authentication. Acceptance requires an authenticated, active account and is replay-safe for an existing active member.
- Owners and administrators can create/revoke member invites. Role promotion is a separate owner-only mutation.

### Seasons

- Every season belongs to one league and snapshots the league mode and timezone.
- Boundaries are immutable half-open UTC instants: `[starts_at, ends_at)`. The season timezone is retained for display and calendar-period grouping but later league/user timezone changes never move a boundary.
- Seasons cannot overlap within a league. A league can have at most one active season.
- New seasons start on a future league-local calendar day. This prevents old diary history from entering a newly created competition and makes participant snapshots deterministic.
- Scheduled seasons may be edited or cancelled before they begin. Once started, scoring mode, boundaries, timezone, rule version, and participant set are immutable.
- At the end instant a season enters a 72-hour `finalizing` grace period. Only provider events attested during the grace whose watched instants are in range, and resolutions of duplicate cases created before the end instant, may alter standings; manual entries created after the end are excluded even if future editing adds backdating. Explicit finalization after the grace freezes standings irreversibly; later diary corrections continue to repair lifetime scoring but do not rewrite the archive.

### Modes

Caleb selected the following contract:

- `casual`: every watch with `qualifies_for_season=1` may project into the season.
- `verified`: the watch must qualify for the season and have provider evidence. Direct Plex/Trakt watches qualify; a manual canonical qualifies when an active merged provider candidate supplies preserved provenance.
- `challenge`: uses Casual watch eligibility and adds challenge bonus events.

A season snapshots its mode. Changing the league default affects future seasons only.

## Score authority and reconciliation

`score_events` continues to hold both lifetime and season rows:

- Lifetime events retain `season_id IS NULL`.
- A projected season watch award has `season_id=<season>`, the same integer points and category semantics as its active lifetime watch award, and a deterministic key `season/<season-id>/watch-event/<lifetime-event-id>`.
- Season rows never feed lifetime totals and lifetime rows are never summed to answer a season query. Every ledger row has immutable `effective_at` for scoring-period attribution; `created_at` remains append/audit time, and compensating reversals inherit the original effective time.
- Only active lifetime watch awards in categories `watch_first`, `watch_rewatch`, and `watch_cooldown` are projection sources. Achievements remain lifetime-only. Challenge bonuses are native season rows.
- A season projection stores source event ID, source watch ID, season-member ID, eligibility mode, participant cutoff, and verification evidence in immutable metadata.
- Reconciliation computes the desired projection set from watches, active lifetime awards, season bounds, membership episodes, and mode. Missing desired rows are appended. Undesired rows are reversed with compensating season rows. Repeated reconciliation is idempotent.
- Manual logging, provider imports (including verification-only updates), duplicate resolution, watch deletion, eligibility changes, membership cutoffs, and season lifecycle changes invoke season reconciliation in the same database transaction as their competitive mutation for non-finalized seasons.
- Reconciliation covers the entire affected movie chronology because a late watch can reissue later lifetime awards across season boundaries. A bounded owner/admin repair endpoint reconciles one active/finalizing season in cursor-based batches and records its actor, bounds, and result. It cannot mutate a finalized season. Ordinary correctness still does not depend on later repair.

## Leaderboards

- Leaderboards are computed only from season-scoped rows for seasonal, weekly, and monthly periods; lifetime boards use only `season_id IS NULL`.
- Weekly periods are Monday 00:00 through the next Monday in the season timezone. Monthly periods are calendar months in that timezone. Both are clipped to the season interval.
- Ranking order is points descending, qualifying movie count descending, then username case-insensitively and user ID for deterministic ties.
- Equal points and qualifying counts receive the same competition rank; the next rank skips accordingly.
- Responses include rank, prior-period rank, rank change, points, distance to the next strictly higher score, qualifying movie count, membership status, and snapshotted user identity for season boards. Weekly compares with the immediately preceding clipped week, monthly with the immediately preceding clipped month, seasonal with the previous finalized season, and lifetime has null prior rank/change.
- The requesting member is always included even when pagination or a display limit would otherwise exclude them.

## Challenges

Challenge definitions exist only in `challenge` seasons and snapshot a positive integer point value plus one strict versioned rule: `release_year {year}`, `genre {genre_name}`, `collection {collection_id,required_count}`, `runtime {minimum_minutes,maximum_minutes?}`, `recommendation {tmdb_id}`, or `league_unique {}`. Years and IDs are positive bounded integers, names are normalized bounded strings, collection counts are 2-10, runtime bounds are 1-1000 and ordered, bonus points are 1-1000, and unknown keys/versions are rejected. Assignments are user-specific immutable rows. A deterministic earliest qualifying basis completes an assignment; an active completion appends one season `challenge_bonus` event, and loss of basis appends a compensating reversal. `league_unique` remains complete only while exactly one participating user has an active qualifying projection for that TMDB ID. Evaluation uses stored watch metadata rather than later TMDB responses.

## Security and integrity boundaries

- Every league route checks active membership and role server-side; IDs are never authorization.
- Cross-league season, membership, participant, invite, challenge, source-event, and score references are rejected by foreign keys plus ownership triggers where SQLite cannot express the composite invariant directly.
- Invite and mutation routes retain session authentication, CSRF protection, strict positive-ID parsing, bounded strings, and generic secret-validation failures.
- No endpoint exposes invite hashes, provider credentials, private user timezone, email, or internal reconciliation evidence not needed by the client.
- Schema migration is additive and covered by exact schema-8 upgrade, backup, foreign-key, and idempotency tests.

## Delivery slices

1. League/membership/invite schema and ownership-scoped API.
2. Season lifecycle and immutable boundaries.
3. Season watch projection and reconciliation hooks.
4. League and season pages with leaderboard APIs.
5. Challenge definitions, assignments, completion, and bonuses.
6. Whole-phase migration, integrity, documentation, CI, image, and runtime verification.
