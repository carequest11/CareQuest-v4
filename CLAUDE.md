# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CareQuest matches youth volunteers with seniors, then lets them message, schedule visits, and video call each other. It's a **static HTML/CSS/vanilla-JS site with no build step**, deployed on Vercel, backed entirely by Supabase (Postgres + Auth + Realtime + Storage) for auth and data, with Daily.co for video calls. There is no frontend framework, bundler, or package manager step for the site itself — `package.json` exists only so the `/api` serverless functions can depend on `@supabase/supabase-js`.

**We are not using Cal.com.** A prior version of the scheduling feature used Cal.com embeds/webhooks; it was fully removed (including `api/cal-webhook.js`) in favor of the native availability/visits system described below. Don't reintroduce it.

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
- `daily-room.js` — creates/reuses a private Daily.co room per match and mints a short-lived meeting token for video calls, after verifying the caller is actually a participant in that match.

### Auth flow and redirect-loop hardening

Signup: `get-started.html` → `youth-account.html`/`senior-account.html` (both call `/api/create-profile`) → (`youth-interview.html` for youth only) → `member.html`. Login: `login.html` → `member.html`. `js/authHeader.js` is injected into every page's header (`#authSlot` div) and shows a Log In button or the signed-in user's name + Log Out, reactive to `onAuthStateChange`.

`login.html` and `member.html` both wait for the Supabase `INITIAL_SESSION` auth event (not a bare `getSession()` call) before deciding whether to redirect, since a bare call right after the client is constructed can race the localStorage session restore. They also set a short-lived `sessionStorage` marker (`cq_redirected_from` / `cq_redirected_at`) before redirecting to each other, and re-check once before trusting a result that contradicts why they were just navigated to — this is what prevents a login↔member infinite bounce. If you add another page with session-based redirect logic, replicate this pattern rather than a plain `getSession()` + redirect.
