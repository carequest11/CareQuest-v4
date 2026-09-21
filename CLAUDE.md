# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CareQuest matches youth volunteers with seniors, then lets them message, schedule visits, and video call each other. It's a **static HTML/CSS/vanilla-JS site with no build step**, deployed on Vercel, backed entirely by Supabase (Postgres + Auth + Realtime + Storage) for auth and data, with Daily.co for video calls. There is no frontend framework, bundler, or package manager step for the site itself — `package.json` exists only so the `/api` serverless functions can depend on `@supabase/supabase-js`.

**We are not using Cal.com.** A prior version of the scheduling feature used Cal.com embeds/webhooks; it was fully removed (including `api/cal-webhook.js`) in favor of the native availability/visits system described below. Don't reintroduce it.

## Pull before you start

Two people work in this repo. **Always run `git pull` at the start of a session, before making any edits** — the other person may have pushed directly to `main` since your local copy was last synced, and editing a stale file risks silently reverting or conflicting with their work.

## Design principle

Design for older users throughout: large text, high contrast, generous tap targets. This applies to any UI/CSS work on this site, not just `member.html`.

## You cannot run SQL

There is no way for you to execute SQL against the live Supabase project from this environment. Whenever a change requires a schema change — a new table, column, policy, function, or Storage bucket/policy — **print the full SQL** in your response for the user to paste into the Supabase SQL editor themselves, and **remind them to run it before pushing** the code that depends on it (or before deploying, if it's already pushed). See `supabase-schema.sql` below for the format to follow.

## Commands

- `npm install` — installs `@supabase/supabase-js` for the `/api` functions and `scripts/verify-schema.js`. Not needed to view/edit the HTML pages themselves.
- `node scripts/verify-schema.js` — one-off sanity check that confirms `youth_profiles`, `senior_profiles`, and `matches` exist and are reachable in the connected Supabase project (connects with the public URL + publishable key, same as the browser).
- No lint, build, or test scripts exist in this repo.
- Deployment is via Vercel, triggered by pushing to `main` (`vercel.json` sets `cleanUrls: true`, so every internal link is extension-less, e.g. `href="login"` not `href="login.html"` — preserve this when adding pages or links).

## Architecture

### No shared template — pages are self-contained copies

Every `*.html` file at the repo root embeds its **own full copy** of the same `<style>` block (CSS variables, header, buttons, dashboard cards, etc.) and the same header markup (logo + `#authSlot`). This is deliberate copy-paste, not a shared include — changing a global visual style means editing the `<style>` block in every relevant page individually. The one thing that actually is shared is `css/auth-header.css` (linked, not embedded).

Pages that talk to Supabase load three scripts in this order: the Supabase CDN build (pinned to `@^2.49.4` — see below for why), then `js/supabaseClient.js`, then `js/authHeader.js` if that page shows the header sign-in widget, then the page's own inline `<script>` at the bottom of `<body>`.

### Supabase client and key format

`js/supabaseClient.js` creates the single shared client (`cq`) using Supabase's newer `sb_publishable_...` key format rather than the legacy anon JWT. supabase-js only added support for that format in `2.49.4+`, which is why every CDN script tag is pinned to `@^2.49.4` instead of a bare `@2` — an older cached 2.x build silently mishandles the key. Keep that pin if you touch those script tags.

### Database schema and RLS (`supabase-schema.sql`)

This file is the single source of truth for the schema and is meant to be pasted into the Supabase SQL editor — it is **not** run automatically. It's organized as sequential, independently-runnable sections in the order they were added (profiles/matches → messaging/staff → scheduling → profile photos); each section is idempotent (`create table if not exists`, `drop policy if exists` + `create policy`, `drop function if exists` + `create function`). When adding a feature, append a new section rather than editing an old one in place, and give the user the new section's SQL to paste in — don't assume it's already applied.

Core tables:
- `youth_profiles`, `senior_profiles` — one row per `auth.users` row per role. **A user's role is inferred by which table has a row for their id, not an explicit flag.** RLS: a user can only read/write their own row; there is no policy letting anyone list either table.
- `matches` — links exactly one youth to one senior. **Matches are created manually by staff** (Supabase dashboard or service-role key) — there is no in-app "create match" flow. RLS: a participant can read their own match rows only.
- `messages` — one match's chat thread. RLS: participants (or staff, via `is_staff()`) can read; a user can only insert as themselves (`sender_id = auth.uid()`) into a match they're part of. No update/delete policy — messages are permanent.
- `availability` — a user's recurring weekly free time as `(day_of_week, start_time, end_time)` rows; `day_of_week` is `0=Sunday..6=Saturday` (matches JS `Date#getDay()`). RLS lets a user manage their own rows and read their matched partner's rows (via `is_matched_with()`) — never anyone else's.
- `visits` — concrete booked visits (`scheduled_at` in UTC, `duration_minutes`, `status`: scheduled/cancelled/completed). RLS: only the two match participants can read/create; either can cancel (flip to `'cancelled'` only — the policy can't be used to edit the time or un-cancel).
- `staff_users` — marks accounts that can read all messages for moderation. No insert/update policy for end users; added by an admin running SQL directly. Combined with `get_match_partner`, this is the pattern used throughout: **RLS is real authorization, not just a client-side check** — every table is locked down by default, and the few intentional exceptions are narrow SECURITY DEFINER functions, never a broad SELECT grant.

Key SECURITY DEFINER functions (bypass RLS internally, but only return a narrow, verified slice of data):
- `get_match_partner(match_id)` — the only sanctioned way a user sees a *slice* of their matched partner's profile (display name, interests, avatar path) without ever granting a SELECT policy on the other role's full table.
- `is_matched_with(other_user_id)` — reusable "is this row's owner someone I'm matched with?" check, used by `availability`'s RLS and by the `avatars` storage bucket's RLS policy.
- `is_staff()` — used by `messages`' RLS to grant staff read access without opening the table up generally.

### Profile photos (Supabase Storage)

The `avatars` bucket is **private**. `avatar_url` on both profile tables stores the storage *path* (`<user id>/avatar.<ext>`), not a URL — viewing a photo always goes through `createSignedUrl()`, which only succeeds if the bucket's RLS SELECT policy allows it (the file's owner, or their matched partner via `is_matched_with()`). Don't reintroduce `getPublicUrl()` or store a public URL; the whole point is that nobody but the owner and their match can ever view a photo.

### `member.html` is the unified post-login hub

`member.html` is where users land after login/signup — it folds in everything from the old per-role dashboards: profile photo upload, the weekly availability grid, visit scheduling, and an embedded live chat thread (last 20 messages + Realtime subscription; `messages.html` still holds the full history). `youth-dashboard.html` / `senior-dashboard.html` still exist for a couple of role-specific bits not folded in, but are no longer the primary destination and are linked to only via a small, de-emphasized text link, not a prominent button.

Visit scheduling flow (all in `member.html`): compute the exact-block overlap between the two matched users' saved `availability` rows, project it forward across the next 4 weeks as concrete date-times using **Luxon** (loaded from CDN) assuming `America/Vancouver`, convert to UTC before writing to `visits.scheduled_at`, and exclude anything already booked. Booking or cancelling a visit posts an automatic message into the shared thread **as the acting user** (not a "system" sender — RLS requires `sender_id = auth.uid()`), which is what makes it show up live via Realtime for the other person. A prior version of this scheduling flow used Cal.com embeds/webhooks; that integration was fully removed (including `api/cal-webhook.js`) in favor of this native system — don't reintroduce it.

Everyone is currently assumed to be in `America/Vancouver`; all scheduling timestamps are stored in UTC specifically so that assumption can be changed later without a data migration.

### `/api/*.js` — Vercel serverless functions

The only place secrets (`SUPABASE_SERVICE_ROLE_KEY`, `DAILY_API_KEY`) are used — see `.env.example` for the full env var list. Plain Node/CommonJS (`module.exports = async (req, res) => {...}`), not Next.js API routes.
- `create-profile.js` — inserts a `youth_profiles`/`senior_profiles` row right after `auth.signUp()`, using the service role so it works even before the user's email is confirmed (RLS would otherwise block the insert until then).
- `daily-room.js` — creates/reuses a private Daily.co room per match and mints a short-lived meeting token for video calls, after verifying the caller is actually a participant in that match, and that both participants have consented to recording.
- `daily-webhook.js` — receives Daily's `recording.started` / `recording.ready-to-download` events and writes `call_recordings` rows. Public endpoint, so it verifies Daily's HMAC signature before trusting anything. Daily signs `timestamp + '.' + JSON.stringify(event)` — the *re-serialised* JSON, not the raw bytes — so it uses the already-parsed `req.body`. Don't switch this to reading the raw request stream: on Vercel that stream is drained by the time the handler runs, `end` never fires, and the function hangs until timeout. Note the units differ within Daily's own API and only one side is documented: `event_ts` / `start_ts` / `duration` are **seconds**, but the undocumented `X-Webhook-Timestamp` header arrives in **milliseconds** — the replay check normalises by magnitude rather than assuming either. **Generate `DAILY_WEBHOOK_SECRET` yourself and pass it as `hmac` when creating the webhook** — Daily's validation POST is signed, so a Daily-generated secret arrives too late to verify the ping it triggers. The handler accepts that one unverified ping (and nothing else) when no secret is configured, purely so the webhook can be created at all; see the setup block at the top of the file.
- `recording-access.js` — the only route to play back a recording: staff accounts only, and it writes the `recording_access_log` row *before* minting Daily's access link.
- `purge-recordings.js` — deletes recordings past `expires_at` from Daily and from the DB. Authorised by `CRON_SECRET`; scheduled by the `crons` entry in `vercel.json`.

### Call recording (safeguarding)

Every video call is cloud-recorded by Daily. **The two halves of that live on different Daily objects and it's easy to get wrong:** `enable_recording: 'cloud'` is a **room** property (it permits recording), while `start_cloud_recording: true` is a **meeting token** property (it's what actually starts the recording when that token's holder joins). Putting `start_cloud_recording` in the room config makes Daily reject the room update. Don't set `enable_recording: false` on the token to stop participants halting a recording either — it contradicts `start_cloud_recording` and prevents recording starting at all; participants can't stop a recording anyway, since only owners get the Record control and these tokens don't set `is_owner`.

`daily-room.js` verifies an existing room actually has `enable_recording: 'cloud'` before reusing it, patches it if not (re-reading Daily's returned config rather than trusting a 200), and deletes + recreates the room if the patch won't take. A call that can't be recorded is refused rather than run unrecorded.

**The in-call recording banner is driven by Daily's `recording-started` / `recording-stopped` / `recording-error` events, never by the room config** — the server only knows recording was *requested*. Whoever joins second misses `recording-started`, so the join handler also checks the `record` flag on `participants()`; if nothing confirms recording within 15s the UI says the call is *not* being recorded. Keep it that way round: understating is acceptable, claiming a call is recorded when it isn't is not, since consent was given on that basis.

Room names are `cq-match-<match id>` — that naming is the only link from a Daily webhook event back to a match, so don't change it without updating `daily-webhook.js`.

**Recordings are staff-only.** `call_recordings` has a select policy for `is_staff()` and no policy at all for participants, plus no insert/update/delete policy for anyone (only the service role writes it). Participants cannot list or download their own recordings by design. Every staff playback writes a `recording_access_log` row; that table is append-only via the service role, so staff can neither forge nor delete their own audit entries, and its `recording_id` FK is `on delete set null` with `daily_recording_id` snapshotted as text so the audit trail survives a purge.

**Consent** is a `recording_consent_at` timestamp on both profile tables — null means no calls, enforced in `daily-room.js`, not just the UI. It's collected by an optional checkbox at signup and, for accounts predating this, by the prompt in `member.html`'s Calling card (`record_recording_consent()` RPC). `match_recording_consent(match_id)` is the narrow SECURITY DEFINER read that lets the UI say *whose* consent is missing without exposing the partner's profile.

**Retention** lives in the single-row `recording_settings` table and is applied when the row is first written (`expires_at = started_at + retention_days`), so changing it only affects new recordings — the backfill SQL to re-apply it to existing rows is in the header comment of `purge-recordings.js`. The "deleted automatically after 30 days" wording appears in `youth-account.html`, `senior-account.html` and `member.html`; if `retention_days` changes, update all three.

### Auth flow and redirect-loop hardening

Signup: `get-started.html` → `youth-account.html`/`senior-account.html` (both call `/api/create-profile`) → (`youth-interview.html` for youth only) → `member.html`. Login: `login.html` → `member.html`. `js/authHeader.js` is injected into every page's header (`#authSlot` div) and shows a Log In button or the signed-in user's name + Log Out, reactive to `onAuthStateChange`.

`login.html` and `member.html` both wait for the Supabase `INITIAL_SESSION` auth event (not a bare `getSession()` call) before deciding whether to redirect, since a bare call right after the client is constructed can race the localStorage session restore. They also set a short-lived `sessionStorage` marker (`cq_redirected_from` / `cq_redirected_at`) before redirecting to each other, and re-check once before trusting a result that contradicts why they were just navigated to — this is what prevents a login↔member infinite bounce. If you add another page with session-based redirect logic, replicate this pattern rather than a plain `getSession()` + redirect.
