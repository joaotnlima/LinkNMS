# PRD-04 — Connecting the RFP and the directory

| | |
|---|---|
| Status | Draft — for founder review |
| Date | 2026-10-10 |
| Validated against | `main` @ `18b0ec4` |
| Design boards | 4c · C0 Loop, C1 AddFromProfile, C2 Review, C3 LiveSources; 4b · D3 FromTask |
| Superseded boards | tendering/Marketplace, tendering/Bid, tendering/RfpDraft (in the APAGAR area) |
| Related decisions | D-15, D-29, D-36, **D-40 (conflict)** |
| Depends on | PRD-02 (in-panel composer), PRD-03 (directory) |

## 1. Problem

The RFP (sent from the plan) and the directory (where companies are found) are two doors to the same thing: a company bidding on a task. Today they don't meet:

- An invite is an email address on `rfp_recipient` with no idea where it came from.
- An "open" RFP lets any company claim a bid lane without the owner's say (`applyToOpenRfp`).
- A company found in a directory, which doesn't exist yet, couldn't be added to an RFP.

## 2. Today (as-built)

| Element | State | Where |
|---|---|---|
| `tendering.rfp_recipient` (email, token, status, nullable `org_id`) | Built, **no `source`** | `db/v2/0001_schema.sql:391` |
| `rfp.visibility` invite_only / open | Built | `0001_schema.sql:348` |
| `/marketplace` browse + `/marketplace/bid/{rfpId}` editor | Built | `app/src/app/marketplace/MarketplaceBrowser.tsx`, `bid/[rfpId]/BidEditor.tsx` |
| Self-serve apply creates a lane **without owner approval** | Built (D-40 Slice 1) | `modules/tendering/application/use-cases.mjs:867-900`, `http/register.mjs:118-123` |
| Bidders shown in the drawer | Built, no source or proof | `TenderDrawerTab.tsx:267-293` |

## 3. The model: the invite is the join

Every bidder on an RFP is an **invite** with a `source`:

| source | How it is created | company_id |
|---|---|---|
| `directory` | Added from search (D1) or a profile (C1) | Set |
| `email` | Typed by the owner | Empty until the invitee claims a profile |
| `asked_to_bid` | A company asked from an open request, and the owner approved | Set |

`rfp.listed` (on/off) replaces "open on the marketplace": a listed RFP appears as an **open request** to companies with the matching specialty and area. Companies *ask to bid*; they never get a lane without approval.

## 4. Requirements

### 4.1 From the plan (D3, C2, C3)

| ID | Requirement | Priority |
|---|---|---|
| X-1 | Composer step 2 · Bidders (PRD-02) shows **suggested companies** matched on the task's specialty code and the build's location, with proof lines and `＋ Add` / `✓ Added`. `Search the directory →` opens D1 prefilled and returns to the panel. | Must |
| X-2 | Add by email stays. The email invitee gets an **unclaimed profile** when the RFP is sent. | Must |
| X-3 | Toggle **"Also list it as an open request"** (`rfp.listed`): companies with that specialty within the radius see it and can ask to bid. Nobody gets a link until approved. | Must |
| X-4 | Review & send (C2) lists bidders tagged by source and shows the critical-path warning. | Must |
| X-5 | Out for bids (C3): an **Asking to bid** section, with proof lines and Approve (sends the link) / Decline per request. Bidders list shows source tags. `＋ Find more in the directory`. | Must |

### 4.2 From the directory (C1)

| ID | Requirement | Priority |
|---|---|---|
| X-6 | `Ask for a proposal` on a profile opens a dialog: pick build → pick task (tasks matching the company's specialties first) → add to the existing RFP draft for that task, or create a new draft prefilled from the task. | Must |
| X-7 | Nothing is sent from the dialog. The company is added to the draft with source `directory`; sending happens from the task panel. | Must |
| X-8 | "Save to my shortlist instead": a per-user list of companies, reusable across builds. | Could |

### 4.3 Company side (D4)

| ID | Requirement | Priority |
|---|---|---|
| X-9 | "Requests for you" shows each invite with its origin (found you in the directory / invited by email), bids due, task count, files, and `Open and price` / `Decline`. | Must |
| X-10 | "Open requests near you" lists listed RFPs matching the company's specialties and area, with `Ask to bid`. | Must |
| X-11 | Pricing uses the existing proposal flow (`/rfp/{token}`, or in-app when signed in). | Must |

### 4.4 Retire the inverted marketplace

| ID | Requirement | Priority |
|---|---|---|
| X-12 | `/marketplace` redirects to the company inbox "Open requests near you". `/marketplace/bid/{rfpId}` redirects to the proposal for that RFP. | Must |
| X-13 | `POST /rfps/{id}:apply` becomes "ask to bid": it creates a pending request, not a lane. Approval creates the lane, adopting a prior email invite exactly as Slice 1 does today. | Must — **decision** |

## 5. Data and API

- `tendering.rfp_recipient`: add `source` (`directory | email | asked_to_bid`) and `company_id` (nullable; set on claim).
- `tendering.rfp`: add `listed boolean` and migrate `visibility='open'` to `listed=true`. Keep or drop `visibility`: decide.
- New `tendering.bid_request` (rfp_id, org_id, status `pending | approved | declined`, decided_by, decided_at), plus events `BidRequested`, `BidRequestApproved` and `BidRequestDeclined`.
- Unclaimed profile: `organization_profile` row with a `claimed_at` null, keyed to the invite email's domain or address. The claim flow verifies control of that email.
- "On the record" counts (PRD-03) read award events. Source does not change counting.

## 6. Acceptance criteria

1. A company added from search appears in the draft with source Directory; sending creates its personal link like any invite.
2. With `listed=true`, a matching company sees the request, asks to bid, and gets **no** link until the owner approves. Declining notifies the company.
3. An email invitee who later signs up and claims the profile has `company_id` back-filled on every past invite to that address.
4. `/marketplace` no longer offers a direct Apply that creates a lane.

## 7. Decisions needed

> **Decided — D-47:** ask-to-bid with owner approval; `/marketplace` becomes the company inbox.

1. **Amend D-40.** Self-serve apply (shipped) gives companies a lane without owner approval. This PRD turns it into ask-to-bid with approval. The loss: less friction for bidders. The gain: the owner controls who bids, which matches invite-only as the default (D-15).
2. Keep `visibility` or replace it with `listed`.
3. Unclaimed-profile identity: per email address or per domain. Domains merge colleagues; addresses fragment companies.
