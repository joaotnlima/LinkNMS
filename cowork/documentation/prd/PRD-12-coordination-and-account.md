# PRD-12 — Coordination and account: quality, questions, notifications, settings, share links

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 6 · account/Gaps. **Screens not drawn yet** |
| Related decisions | D-05, D-16, D-19, D-34 |
| Related docs | to-be/08 supporting domains, to-be/16 access (Clerk), to-be/20 §3, flows C15–C17, D21, E22–E23 |
| Note | "Documents — files, versions, photos" from account/Gaps is covered by **PRD-05** (F-19) |

## 1. Problem

Many backend capabilities have no screen, so nobody knows something is waiting for them:

- quality (non-conformities, inspections);
- questions and minutes;
- notifications;
- billing.

The onboarding copy promises a settings page that doesn't exist.

## 2. Today (as-built)

| Element | Backend | UI |
|---|---|---|
| Non-conformities (raise, assign, fix, close, reject fix), inspections, verifications (`/me/verifications`, accept/reject) | Registered, `modules/quality/http/register.mjs` | None |
| Questions (answer, resolve, `/me/questions`), minutes (create, circulate, acknowledge) | Registered, `modules/collaboration/http/register.mjs` | None |
| Notifications (list, mark read, preferences) | Registered, `modules/collaboration` | None |
| Subscriptions (change, cancel, webhook) | Registered, `modules/billing/http/register.mjs` | None |
| Share links (`createShareLink`) | Registered, `modules/project/http/register.mjs` | None |
| `/settings*` | — | **No route**, yet `onboarding/setup/page.tsx:286` promises "change it later in settings" |
| `/pricing` | — | Landing only, nav hidden (`marketing-site/src/lib/landing-flags.ts:17`) |

## 3. Requirements

### 3.1 Notification centre: `/notifications` (do first, everything else feeds it)

| ID | Requirement | Priority |
|---|---|---|
| N-1 | A bell with unread count in the shell. The list shows grouped notifications with deep links: bids in, deliverables to review, change orders awaiting decision, sign-offs, invites accepted, clarifications answered, model versions saved. | Must |
| N-2 | Mark read, mark all read, and email preferences per type. | Must |

### 3.2 Quality: `/projects/{id}/quality` (flow C15)

| ID | Requirement | Priority |
|---|---|---|
| N-3 | Inspector or HSE raises a non-conformity (location, task, photos, severity). It is assigned → fixed → closed **only by whoever raised it**, or the fix is rejected back. | Must |
| N-4 | Inspections recorded against tasks or locations. | Should |

### 3.3 Questions and minutes: `/projects/{id}/questions` (flows C16–C17)

| ID | Requirement | Priority |
|---|---|---|
| N-5 | The architect's queue for clarifications and design-change approvals. Scope-gap flags are routed to the owner. | Must |
| N-6 | Meeting minutes: create, circulate, acknowledge. | Should |
| N-7 | "Questions for me" across builds (`/me/questions`). | Should |

### 3.4 Settings: `/settings`, `/settings/organization`, `/settings/billing` (to-be/16, to-be/20)

| ID | Requirement | Priority |
|---|---|---|
| N-8 | Personal settings: name, language, notifications. | Must |
| N-9 | Organisation: members, roles and seats (Clerk, D-34). The public profile editor is PRD-03 R-20. | Must |
| N-10 | Billing: plan, entitlements, invoices; change and cancel subscription (D-05). Pricing numbers are out of scope (AGENT-INDEX). | Should |

### 3.5 Pricing, share link, neighbours

| ID | Requirement | Priority |
|---|---|---|
| N-11 | `/pricing` public page, or remove the dead links. | Could |
| N-12 | Scoped, expiring share link for the licensing authority (flow D21): pick documents, set an expiry, revoke, and see access logs. | Should |
| N-13 | Neighbour log (flows E22–E23): occurrences and disruptive-work notices, fed by the site calendar (PRD-10 E-12). | Could |

## 4. Acceptance criteria

1. When a bid arrives, the owner sees an unread notification that deep-links to the Tender tab of the task.
2. A non-conformity can't be closed by the party that fixed it; only the raiser can close it.
3. The onboarding link to settings opens a real page.
4. A share link opened after its expiry shows an expired state, and every access before expiry is logged.

## 5. Decisions needed

- Order of delivery. Recommendation: notifications first, because every other PRD sends events into it.
