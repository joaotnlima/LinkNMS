# 20 — URL structure (navigation)

**Status:** review + proposal for LINA-308 item 5.
**Scope:** user-facing Next.js navigation URLs only. The REST API (`/api/v2`) is owned by
[11 — API conventions](./11-api-conventions.md) and is out of scope here.

The founder's bar: every URL must be **descriptive, stable, shareable and consistent** for
"whoever still looks into urls". Public URLs additionally carry SEO weight (Directory).

## 1. Conventions (proposed, binding)

1. **Plural nouns** for collections, singular id/slug segment beneath: `/projects/{id}/contracts/{id}`.
2. **Lowercase, hyphenated**, ASCII only. No camelCase, no underscores, no verbs — except a
   trailing explicit action segment on flows that are pages, not mutations (`/new`, `/accept`).
3. **UUIDs only where private.** Anything behind auth may use the raw UUID (it is never typed,
   only followed). Anything public (Directory, RFP links, invitations) gets a human slug or an
   opaque token — never a bare DB id.
4. **Hierarchy = breadcrumb.** The path segments read exactly like the breadcrumb trail:
   `Projects › Casa Silva › Tendering › RFP` ⇒ `/projects/{id}/tendering/rfps/{id}`.
5. **To-be vocabulary only** ([02 — Domain map](./02-domain-map.md)): *tasks* not *stages*,
   *plan* not *build*, *tendering*, *contracts*, *change orders*, *measurements*. The words
   "build", "stage", "record" (as a page name) do not appear in a v2 path.
6. **Query params are view state, never location.** `?compose=`, `?tab=`, `?status=` may filter
   or open a panel; they must never be the only way to reach a distinct screen a user would
   bookmark. Distinct screens get paths.
7. **One canonical URL per screen.** Shell routes that only 307 elsewhere are deleted, not kept.

## 2. As-is inventory and verdicts

All routes under `app/src/app` (excluding `/api`), from `find … -name page.tsx`:

| Current URL | What it is | Verdict |
|---|---|---|
| `/` | portfolio (list of projects) | OK. Also gate: redirects anonymous→`/sign-in`, unseated→`/no-access`, unset-up→`/onboarding/setup`. Keep. |
| `/sign-in`, `/sign-up` | auth doors | OK. Keep. |
| `/no-access` | seatless landing | OK, descriptive. Keep. |
| `/onboarding/setup` | first-run setup (`?persona=` prefill) | OK. Keep; `?persona=` is fine as prefill state. |
| `/projects` | shell — `redirect('/')` | Dead weight. Delete or keep as permanent alias of `/`. |
| `/projects/new` | "your role" pre-step | OK (explicit-action `/new` allowed). Keep. |
| `/projects/new/basics` (`?as=`) | wizard step 2 | Acceptable; wizard steps under `/new/*` read well. Keep pattern. |
| `/projects/[id]` | shell — redirects to `/plan` | Should become the **project brief/overview**, not a bounce. |
| `/projects/[id]/plan` | the Gantt; `?compose=build\|import` opens authoring inline; `?imported`/`?drafted` are toasts | Path OK ("plan" matches to-be Planning & Execution). `?compose=` is fine per rule 6 (panel state, not a screen). |
| `/projects/[id]/plan/build` | shell — 307 → `/plan?compose=build` | Legacy word "build" + pure redirect. Delete. |
| `/projects/[id]/plan/import` | shell — 307 → `/plan?compose=import` | Pure redirect. Delete. |
| `/projects/[id]/plan/tasks/[stageKey]` | task workspace drawer route | Word "tasks" is right; the *param* is a stage key. Rename param semantics to task id; path shape keeps. |
| `/projects/[id]/record` (`?tab=`, `?compare=`) | M14 record home (ledger view) | "record" collides with to-be Record=ledger context, but as the audit surface it is the one legit use. Fold into `/history` (see §3) to free the word. |
| `/projects/[id]/record/[stageId]` | per-stage record | Legacy "stage". Replaced by task workspace. |
| `/projects/[id]/audit` | audit trail | Merge with record → one `/history`. Two names for one concept today. |
| `/projects/[id]/budget` | budget view | Money moves to Contracting in to-be: becomes `/contracts` surface. |
| `/projects/[id]/change-orders` and `/new` | change orders list/create | Right words, wrong level: to-be COs hang off a **contract**. Re-parent. |
| `/change-orders/[id]` | top-level CO detail | **Worst offender**: project-less, bare UUID, no context, breadcrumb-broken. Re-parent under project+contract. |
| `/projects/[id]/decisions` | decisions list | To-be has no "decisions" context; these are change-order/sign-off events. Fold into contracts + history. |
| `/projects/[id]/invite` | invite participants | Becomes `/participants` (list + invite action), matching Project context. |
| `/projects/[id]/operating-model` | v1 owner/GC setup step | v1 concept; superseded by participations/contracts. Drop. |
| `/invitations/accept?token=` | invite redeem (query token) | Duplicate of the path-token route below; token-in-query gets stripped by some auth round-trips (the path variant exists precisely because of that). Delete. |
| `/invitations/[token]/accept` | invite deep link (public landing, POST to accept) | Correct shape: token in path, survives Clerk round-trip, opaque not UUID. Keep as the only one. |
| `/rfp/[token]` and `/rfp/[token]/submitted` | public RFP form (single-use token) | Good token design; singular "rfp" breaks rule 1 → `/rfps/…`. |

General findings:

- **UUIDs everywhere, no slugs** — acceptable while everything is private; unacceptable for the
  to-be public Directory. Private URLs stay UUID (rule 3).
- **Two vocabularies coexist** ("build/stage/record" v1 vs "task/plan" to-be) — one URL rename
  pass at v2 cutover, not incrementally.
- **Sign-in bounces** consistently use `/sign-in?next=<url>` — good pattern, keep.
- **Redirect-only shells** (`/projects`, `/projects/[id]`, `/plan/build`, `/plan/import`) exist
  only for history; pre-launch, history is worthless — delete them.

## 3. To-be navigation URL map

Covers the full to-be surface from [02](./02-domain-map.md) / [12](./12-api-catalogue.md).
`{id}` = UUID (private), `{slug}` = human slug (public), `{token}` = opaque capability token.

### Public (unauthenticated, SEO-relevant)

| URL | Screen |
|---|---|
| `/` | marketing/landing when anonymous; portfolio when signed in |
| `/companies` | directory search (marketplace) — filters as query: `?specialty=&area=&q=` |
| `/companies/{slug}` | public company profile (e.g. `/companies/construtora-silva`) |
| `/companies/{slug}/portfolio` | public track record / portfolio entries |
| `/specialties/{slug}` | specialty landing (directory facet, SEO) |
| `/rfps/{token}` | public RFP response form (single-use token, LINA-294 contract) |
| `/rfps/{token}/submitted` | post-submission confirmation |
| `/invitations/{token}` | invitation landing (preview + accept form; POST accepts) |
| `/sign-in`, `/sign-up` | auth doors (`?next=` bounce param stays) |
| `/pricing` | plans/tiers (Billing, public) |

Note: `/invitations/{token}` replaces `/invitations/{token}/accept` — the landing *is* the
accept screen; the verb segment adds nothing (accepting stays a POST).

### Authenticated — account level

| URL | Screen |
|---|---|
| `/` | portfolio / dashboard (all projects for the viewer) |
| `/onboarding/setup` | first-run setup |
| `/no-access` | seatless landing |
| `/settings` | personal settings |
| `/settings/organization` | org settings, members, seats |
| `/settings/organization/profile` | edit the public Directory profile (what `/companies/{slug}` shows) |
| `/settings/billing` | subscription, entitlements, invoices |
| `/notifications` | notification center (Collaboration) |

### Authenticated — project level (all UUID, breadcrumb-aligned)

| URL | Screen (context) |
|---|---|
| `/projects/new` | create wizard — role step; further steps `/projects/new/{step}` |
| `/projects/{id}` | project overview / brief (no longer a redirect) |
| `/projects/{id}/locations` | locations (Project) |
| `/projects/{id}/participants` | participants + invite (Project/IAM) — absorbs `/invite` |
| `/projects/{id}/plan` | the Gantt (Planning & Execution); `?compose=`, `?task=` open panels |
| `/projects/{id}/plan/tasks/{taskId}` | task workspace (comments, attachments, progress) |
| `/projects/{id}/plan/baselines` | baselines & variations |
| `/projects/{id}/tendering` | tendering home: RFPs the viewer can see |
| `/projects/{id}/tendering/rfps/new` | compose RFP |
| `/projects/{id}/tendering/rfps/{id}` | RFP detail + clarifications |
| `/projects/{id}/tendering/rfps/{id}/proposals` | proposals inbox + comparison |
| `/projects/{id}/contracts` | contract tree for the viewer (Contracting) — absorbs `/budget` |
| `/projects/{id}/contracts/{id}` | contract detail + BoQ |
| `/projects/{id}/contracts/{id}/change-orders` | change orders (list; `/new` to raise) |
| `/projects/{id}/contracts/{id}/change-orders/{id}` | CO detail — replaces top-level `/change-orders/{id}` |
| `/projects/{id}/contracts/{id}/measurements` | measurements (autos de medição) |
| `/projects/{id}/contracts/{id}/payments` | payments record |
| `/projects/{id}/quality` | verifications, non-conformities, inspections (Quality) |
| `/projects/{id}/documents` | files, versions, photos (Documents); `?folder=`/`?type=` filter |
| `/projects/{id}/questions` | threads / Q&A / meeting minutes (Collaboration) |
| `/projects/{id}/history` | the scoped ledger view (Record) — absorbs `/record` + `/audit` + `/decisions` |

Deliberate non-routes: money never appears in a path; sub-tabs of a screen (record tabs,
proposal comparison view mode) are `?tab=`-style view state per rule 6.

## 4. Migration table (current → to-be)

Pre-launch: no external users hold bookmarks except **public/token links already sent**
(invitations, RFP forms). Only those warrant real 301s; everything else is plain
replace + delete. "Replace" = update in-app links, old path 404s.

| Current | To-be | Policy |
|---|---|---|
| `/projects` | `/` | replace (delete shell) |
| `/projects/[id]` (redirect) | `/projects/{id}` (overview page) | replace — path survives, meaning changes |
| `/projects/[id]/plan` | same | keep |
| `/projects/[id]/plan/build` | `/projects/{id}/plan?compose=build` | delete (already a 307; keep 307 until in-app links purged, then remove) |
| `/projects/[id]/plan/import` | `/projects/{id}/plan?compose=import` | delete (same) |
| `/projects/[id]/plan/tasks/[stageKey]` | `/projects/{id}/plan/tasks/{taskId}` | replace (param semantics change with v2 model) |
| `/projects/[id]/record` | `/projects/{id}/history` | replace |
| `/projects/[id]/record/[stageId]` | `/projects/{id}/plan/tasks/{taskId}` | replace |
| `/projects/[id]/audit` | `/projects/{id}/history` | replace |
| `/projects/[id]/decisions` | `/projects/{id}/history` (+ contracts) | replace |
| `/projects/[id]/budget` | `/projects/{id}/contracts` | replace |
| `/projects/[id]/change-orders[/new]` | `/projects/{id}/contracts/{id}/change-orders[/new]` | replace |
| `/change-orders/[id]` | `/projects/{id}/contracts/{id}/change-orders/{id}` | replace; delete top-level route |
| `/projects/[id]/invite` | `/projects/{id}/participants` | replace |
| `/projects/[id]/operating-model` | — (superseded by participations/contracts) | delete |
| `/invitations/accept?token=` | `/invitations/{token}` | delete query variant now (in-app only) |
| `/invitations/[token]/accept` | `/invitations/{token}` | **301** — tokens are live in WhatsApp/email threads |
| `/rfp/[token]`, `/rfp/[token]/submitted` | `/rfps/{token}[/submitted]` | **301** — token links may have been sent to bidders |
| `/sign-in`, `/sign-up`, `/no-access`, `/onboarding/setup` | same | keep |
| — | `/companies`, `/companies/{slug}`, `/specialties/{slug}`, `/pricing`, `/settings/*`, `/notifications`, `/projects/{id}/{tendering,contracts,quality,documents,questions,locations}` | new |

The only redirects that matter: the two **token families** (invitations, RFP). Everything else
is behind auth on a pre-launch product; a 404 costs nothing and dead routes cost maintenance.

## 5. Open points (founder calls)

1. **URL language — recommend English.** Copy is PT-PT first, but EN paths (`/projects`,
   `/contracts`) are the industry norm, avoid diacritics/encoding issues (`/orçamento`), and
   keep paths stable if the UI localises later. PT paths would be marginally friendlier to the
   local market and better for PT SEO on the public directory. Decision needed before the
   Directory ships; recommendation: **EN paths everywhere**, PT everywhere else.
2. **Company slug policy.** Who mints `/companies/{slug}` — auto from legal name with numeric
   suffix on collision, or org-chosen (with reserved-word list)? Are slugs renameable (needs
   permanent 301 from old slug) or frozen at creation? Recommendation: auto-mint, one rename
   allowed, old slug 301s forever.
3. **Project slugs.** Keep project URLs UUID-only (private, recommended) or add a vanity slug
   (`/projects/{id}/{slug}` with slug ignored) for readability in shared links? Costs little,
   decide only if sharing outside the participant set becomes a feature.
4. **`/rfps/{token}` vs nesting under the project.** Public form must stay unnested (bidder has
   no project access), but should the *authenticated* RFP detail share the `/rfps` prefix or
   stay project-nested as proposed? Proposal here: project-nested; confirm.
5. **`/history` naming.** "History" chosen over "record" (context-name collision) and "audit"
   (accountant flavour). PT-PT UI label likely "Histórico"/"Registo" — confirm the path word.
