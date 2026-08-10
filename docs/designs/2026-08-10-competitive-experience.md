# Competitive Experience Design

## Outcome

Phase 2 turns ReelScore's integrity foundation into private fantasy leagues with immutable seasons, season-scoped score projections, useful leaderboards, and challenge bonuses. Lifetime diary scoring remains independent and authoritative for lifetime views.

## Product contract

### Leagues and membership

- Leagues are private. Discovery is limited to memberships and explicit invite links.
- Roles are `owner`, `admin`, and `member`. Every league has exactly one owner.
- Owners can archive the league, transfer ownership, manage administrators, seasons, and invites. Administrators can manage member invites and seasons but cannot transfer ownership or archive the league. Members can read league competition data and leave.
- League membership is represented as immutable membership episodes. Joining creates a new episode; leaving closes it. Rejoining never rewrites the previous interval.
- When a season activates, it snapshots `season_members` from membership episodes already active at the exact season start. Users joining at or after that instant can view the active season but do not participate until the next one.
- Leaving or removal during a season closes that participant's eligibility window. Earned points remain; later watches stop counting; rejoining the league does not reactivate that season.
- A watch can enter a season only when its immutable watched instant is inside both the season interval and the participant's eligibility window. Late imports inside those intervals reconcile during the active/finalizing lifecycle. Watches from before the season or participant window never become league points.

### Invite links

- Invite secrets are random, displayed only when created, and stored only as keyed hashes.
- Invites are league-scoped, member-role only, expiring, revocable, usage-limited, and transactionally consumed. A separate invite-use row makes capacity enforcement and distinct-user idempotency auditable.
- Invite inspection reveals only the league name and expiration before authentication. Acceptance requires an authenticated, active account and is replay-safe for an existing active member.
- Owners and administrators can create/revoke member invites. Role promotion is a separate owner-only mutation.

### Seasons

- Every season belongs to one league and snapshots the league mode and timezone.
- Boundaries are immutable half-open UTC instants: `[starts_at, ends_at)`. The season timezone is retained for display and calendar-period grouping but later league/user timezone changes never move a boundary.
- Seasons cannot overlap within a league. A league can have at most one active season.
- New seasons start on a future league-local calendar day. This prevents old diary history from entering a newly created competition and makes participant snapshots deterministic.
- Scheduled seasons may be edited or cancelled before they begin. Once started, scoring mode, boundaries, timezone, rule version, and participant set are immutable.
- At the end instant a season enters a 72-hour `finalizing` grace period. Late provider events whose watched instants were in range and pending duplicate decisions may reconcile during that period. Explicit finalization after the grace freezes standings irreversibly; later diary corrections continue to repair lifetime scoring but do not rewrite the archive.

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
- Season rows never feed lifetime totals and lifetime rows are never summed to answer a season query.
- Only active lifetime watch awards in categories `watch_first`, `watch_rewatch`, and `watch_cooldown` are projection sources. Achievements remain lifetime-only. Challenge bonuses are native season rows.
- A season projection stores source event ID, source watch ID, season-member ID, eligibility mode, participant cutoff, and verification evidence in immutable metadata.
- Reconciliation computes the desired projection set from watches, active lifetime awards, season bounds, membership episodes, and mode. Missing desired rows are appended. Undesired rows are reversed with compensating season rows. Repeated reconciliation is idempotent.
- Manual logging, provider imports (including verification-only updates), duplicate resolution, watch deletion, eligibility changes, membership cutoffs, and season lifecycle changes invoke season reconciliation in the same database transaction as their competitive mutation for non-finalized seasons.
- Reconciliation covers the entire affected movie chronology because a late watch can reissue later lifetime awards across season boundaries. Broad repair is available to administrators and during migrations, but ordinary correctness does not depend on a later repair job.

## Leaderboards

- Leaderboards are computed only from season-scoped rows for seasonal, weekly, and monthly periods; lifetime boards use only `season_id IS NULL`.
- Weekly periods are Monday 00:00 through the next Monday in the season timezone. Monthly periods are calendar months in that timezone. Both are clipped to the season interval.
- Ranking order is points descending, qualifying movie count descending, then username case-insensitively and user ID for deterministic ties.
- Equal points and qualifying counts receive the same competition rank; the next rank skips accordingly.
- Responses include rank, prior-period rank, rank change, points, distance to the next strictly higher score, qualifying movie count, membership status, and user identity.
- The requesting member is always included even when pagination or a display limit would otherwise exclude them.

## Challenges

Challenge definitions snapshot their rule and point value inside a season. Initial rule types are release year, genres, collection/trilogy, runtime, recommendation, and league-unique film. Assignments and completions are immutable/auditable; an active completion appends a season `challenge_bonus` event, and loss of basis appends a compensating reversal. Challenge evaluation uses stored watch metadata rather than later TMDB responses.

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
