# Public Plex History Feasibility for ReelScore

Research performed against Plex's official documentation on 2026-07-28. No authenticated user credentials or servers were accessed.

## Feasibility verdict

**A universal, complete, supported Plex watch-event import is not currently feasible from Plex’s hosted account APIs alone.**

ReelScore can support:

1. **Best-effort account-level import** if Plex’s private Profile/Activity API proves usable, but it is undocumented and inherently incomplete.
2. **More complete per-server import** from Plex Media Server history, including for shared-library users, but that requires contacting every relevant user-accessible server and cannot safely or reliably be universal in a typical hosted backend.

The product should not promise “complete Plex history.” A defensible promise is:

> Import available Plex movie watch activity. Results depend on Plex Watch State Sync, retained Plex history, server availability, and library metadata compatibility.

## What the APIs represent

### Plex account authentication

Plex’s documented PIN/JWT flow authenticates a Plex account and yields an `X-Plex-Token`. JWTs are currently documented as short-lived, seven-day tokens and can be used against Plex-hosted endpoints or a PMS.

Source: [Plex API — Authenticating with Plex](https://developer.plex.tv/pms/#section/API-Info/Authenticating-with-Plex)

Authentication alone does **not** provide a documented account-history endpoint.

### Account watch state

Account watch state is the current watched/unwatched value for a Plex GUID. It is not an event log. Synced data includes:

- Plex account user ID
- Title GUID
- Date/time the state was changed
- Watched or unwatched state

In-progress position is not synced. Only movies and television items are supported, with metadata-agent and movie-edition exclusions.

Source: [Sync Watch State and Ratings](https://support.plex.tv/articles/sync-watch-state-and-ratings/)

### Account watch history

Plex separately maintains an account-level ongoing log and exposes it in Plex Profile UI. The user can remove activities or edit a watched date.

Source: [Plex Profile — Watch History](https://support.plex.tv/articles/profile/)

However:

- Plex publishes no supported account-history API contract comparable to the PMS API.
- The current hosted web application contains private activity/profile machinery, but reverse-engineering it would couple ReelScore to an internal API.
- Plex’s public provider descriptors expose metadata and scrobble actions, but no documented history-list feature.
- Anonymous executable probes confirmed account/user endpoints require authentication and obvious guessed history routes are absent or unauthorized; they did not establish a supported history API.

Most importantly, Plex’s cloud history is not historically complete:

- Before Watch State Sync is enabled, Plex uploads only **one record per watched title**, using the most recent viewing time—not every past viewing.
- Only later viewings become additional records.
- Users can delete cloud watch history.
- Sync can be disabled.
- Unsupported metadata agents, edition movies, music, and in-progress playback are excluded.
- Events deliberately do not identify whether activity came from a PMS, Discover, Plex streaming, or a manual mark-as-watched action.

Thus, even a working private cloud endpoint cannot deliver complete lifetime playback history or reliably prove that an event was an actual movie playback.

Source: [Sync Watch State and Ratings — FAQ and privacy details](https://support.plex.tv/articles/sync-watch-state-and-ratings/)

## Plex Media Server history

The documented server endpoint is:

`GET /status/sessions/history/all`

It supports pagination and filtering by `accountID`, `viewedAt`, library, and metadata item. Records include:

- `historyKey`
- Server-local `ratingKey`
- `librarySectionID`
- `viewedAt` as Unix epoch seconds
- `accountID`
- Media metadata

Authorization is explicit:

> Admin can see all users; others can only see their own.

Therefore:

- **Server owner/admin:** can read all users’ history on that server.
- **Ordinary shared-library account:** should be able to read its own history from that server using its user-scoped server access token.
- **Shared user cannot read other users’ history.**
- A user’s total history may span multiple owned and shared servers, so every relevant server must be queried.

Source: [Plex API — List Playback History](https://developer.plex.tv/pms/#tag/Status/operation/statusGetHistoryAll)

### Identifiers and timestamps

- `historyKey`, e.g. `/status/sessions/history/12`, identifies a single record **within one PMS**.
- The numeric ID is not a universal Plex account event ID. Namespace it with the server `machineIdentifier`.
- The endpoint also supports fetching and deleting a single history item, so these records are not immutable in the durable-ledger sense.
- Server migration/restoration or database maintenance may affect assumptions about ID permanence; Plex does not document cross-install stability.
- `ratingKey` is also server-local and must not be used as a universal movie identity.
- Prefer Plex GUIDs/TMDb IDs obtained from item metadata for title matching.
- `viewedAt` is epoch seconds and is not unique; multiple events can share a timestamp.
- A reasonable server-side dedupe key is `(machineIdentifier, historyId)`, with an explicitly documented fallback fingerprint only when no history ID is returned.
- The cloud/Profile activity API’s event-ID stability is undocumented and must not be assumed.

## Hosted networking and SSRF implications

Plex account resources can advertise multiple PMS connections, including LAN/private, public, custom, and relay connections. Personal servers require Remote Access or Relay to be reachable away from the server network.

Sources:

- [Managing Library Access](https://support.plex.tv/articles/201105738-creating-and-managing-server-shares/)
- [Remote Access](https://support.plex.tv/articles/200289506-remote-access/)
- [Secure Server Connections](https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/)
- [Plex Relay](https://support.plex.tv/articles/216766168-accessing-a-server-through-relay/)

A hosted ReelScore backend must not blindly fetch connection URLs returned by Plex:

- `plex.direct` names can intentionally resolve to private/LAN addresses.
- Public connection addresses ultimately point to user-controlled PMS hosts.
- Redirects, DNS rebinding, IPv6, link-local, loopback, cloud metadata ranges, and internal service ranges create SSRF risk.
- A normal global “block private IPs” rule conflicts with Plex’s LAN discovery model.
- Relay availability does not guarantee that every PMS API endpoint works reliably through Relay.
- Offline servers, disabled Remote Access/Relay, revoked shares, certificates, and NAT failures prevent universal coverage.

If PMS access is added, it should run in a dedicated, egress-isolated connector with no access to ReelScore’s database, control plane, cloud metadata endpoint, or internal network. Accept only connections obtained directly from the authenticated Plex resource response; do not accept user-entered server URLs. Re-resolve and validate every redirect/hop, cap response sizes and pagination, enforce short timeouts, and use HTTPS only.

## Smallest safe spike

1. **Cloud-only test first—no PMS requests**
   - Authenticate one consenting owner account and one independent shared-library-only account using documented PIN/JWT auth.
   - In browser DevTools, capture the Profile → Watch History requests made by Plex’s own current client.
   - Test whether the same token can read only that account’s activity.
   - Record pagination, replay preservation, edited dates, deletions, GUIDs, event IDs, and rate limits.
   - Compare returned results against the visible Profile UI.
   - Do not ship this route unless Plex confirms it as a supported third-party contract.

2. **Completeness fixture**
   - On controlled test accounts, create:
     - two watches of the same movie before sync opt-in,
     - two after opt-in,
     - a manual watched mark,
     - an edited watched date,
     - an unwatched transition,
     - activity on an owned server and a shared server.
   - Verify the expected historical collapse and source ambiguity documented by Plex.

3. **PMS permission probe in an isolated environment**
   - Against controlled servers only, call `/status/sessions/history/all` with:
     - owner token,
     - shared user token,
     - unrelated token.
   - Verify owner/all-users versus shared-user/own-only behavior, pagination, `historyKey` stability, and GUID retrieval.
   - Test direct remote and Relay connections separately.

4. **Go/no-go gate**
   - **Go:** label it best-effort “available Plex watch activity,” with per-source diagnostics.
   - **No-go:** if the requirement remains complete lifetime account playback history without contacting PMS hosts.

## Work performed

- Reviewed Plex’s current official authentication, watch-state sync, Profile, PMS history, sharing, remote-access, secure-connection, and Relay documentation.
- Probed public Plex provider/account routes without credentials and inspected the current hosted client’s public API surface.
- No credentials were accessed or exposed.
- **Files created or modified:** none.
- **Issue encountered:** no authenticated test accounts were available, so private cloud activity response fields and shared-token behavior still require the controlled spike above.