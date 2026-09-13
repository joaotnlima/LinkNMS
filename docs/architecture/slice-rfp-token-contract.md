# Slice contract — token-scoped RFP proposal (`/rfp/[token]`)

**Issues:** LINA-284 (FE, this document's author) · LINA-279 (BE, owns everything in §3)
**Derived from:** ADR-0023 §5 (auth model), §6 (UI surface map), §2 (schema)
**Status:** FE half shipped against this contract; **BE half not yet built**.

> **Why this document exists.** LINA-284 was scheduled ahead of its dependency:
> at the time the form was written, LINA-279 had not started, so there was no
> endpoint to read a shape off. Rather than stall the slice, the FE was built
> against the shapes ADR-0023 already fixes, and every place where the ADR left a
> gap is named below as a **decision**, not a guess buried in a component. The BE
> is free to disagree with any of them — but the disagreement should land here
> and in a comment on LINA-279, not as a silent 500 on a contractor's screen.
>
> **Nothing in the FE has been exercised against a live endpoint.** Type-check,
> build and the 21 unit tests over the pure helpers are green; the wire is
> unverified by definition. See §5.

---

## 0. The rules this slice keeps

1. **The token is the credential, and it only ever travels in the path.** Never
   in a body, never in a query string. Same discipline as the invitation preview
   (LINA-182).
2. **Validity is derived, never stored** (ADR-0023 §5, Option A). A token is live
   iff its RFP's procurement phase is still `active`. The FE therefore never
   displays a deadline and never computes expiry — it asks, and it asks again at
   submit time, because the window can close while the form is open.
3. **A refusal must not become a probe oracle.** Unknown token and dead token
   both answer `404 not_found`, with one uniform sentence on the FE. Only a token
   that *is* valid but whose window has closed may answer `410 rfp_closed` — that
   one is worth distinguishing because it tells the contractor not to chase it.
4. **The actor is never in the body.** The recipient identity comes from the
   token, server-side. A body that could name its own sender would let anyone
   holding one link bid as somebody else.
5. **Money is integer cents on the wire.** The FE parses typed text into cents
   with the one parser this app has (`lib/format.ts → parseAmountToCents`), which
   *rejects* a third decimal rather than rounding it.

---

## 1. Routes (FE)

| Route | Auth | What it does |
|---|---|---|
| `/rfp/[token]` | none | Reads the RFP, renders specs + proposal form. Redirects to `…/submitted` if a proposal already exists. |
| `/rfp/[token]/submitted` | none | Thank-you + read-back of what was sent. Redirects to the form if no proposal exists. |

Both pages ship `robots: noindex, nofollow, nosnippet, noarchive` — the URL
carries a live credential, and an indexed copy cannot be revoked.

Neither path is in `isProtectedRoute` in `app/src/middleware.ts`, so Clerk
attaches whatever session exists (usually none) and never redirects. **No
middleware change is needed, and none should be made:** a rule that granted
access here is a rule that can be got wrong.

---

## 2. Why the FE reads from the browser, not from a server component

ADR-0023 §5 has the `GET` mint a short-lived, `httpOnly`, `sameSite=strict`
cookie scoped to `/rfp/[token]/*`, which authenticates the subsequent upload and
submit. A `Set-Cookie` on a fetch issued *from a server component* lands in the
server's response to itself and never reaches the visitor's browser — the page
would render and then every write would 401.

So `/rfp/[token]/page.tsx` is a near-empty server component (metadata + param),
and the read happens in `ProposalClient.tsx` on mount. The price is a loading
state on first paint; the alternative was a page that looks fine and cannot
submit.

**If the BE decides not to use a cookie** (e.g. re-validates the path token on
every call instead), the FE needs no change — it always sends the token in the
path too. Say so on LINA-279 and this section becomes a footnote.

---

## 3. Endpoints (BE — LINA-279)

Base path per the LINA-284 issue text: **`/api/rfp/token/:token`**.

> **Discrepancy to settle (Architect).** ADR-0023 §5 writes the submit as
> `POST /rfp/[token]/proposals` (plural, no `/api/rfp/token` prefix); the issue
> text writes `GET /api/rfp/token/:token` and
> `POST /api/rfp/token/:token/proposal` (singular). The FE implements the
> **issue's** paths, because that is the assignment it was given. Changing them
> is a one-line edit in `app/src/lib/rfp-proposal.ts → base()`.
>
> Note also that this sits at `/api/rfp/...`, **outside** the `/api/v1/` tree
> every other route in this app lives under. That is the issue's wording, not a
> considered decision — if the Architect would rather it were
> `/api/v1/rfp/token/:token`, it is the same one-line edit.

### Route 1 — `GET /api/rfp/token/:token`

Mints the scoped cookie (§2) and returns the RFP behind the link.

```jsonc
// 200
{
  "project":        { "name": "Maple Street", "location": "Austin, TX" },  // location nullable
  "recipientEmail": "bids@acme-builders.com",
  "rfp": {
    "description":  "Full scope of works…",        // rendered pre-wrap; keep the author's newlines
    "attachments":  [ /* FileRef */ ],
    "specialties":  ["Electrical", "HVAC"]          // may be []
  },
  "proposal": null                                   // or a Proposal (see route 3) once submitted
}
```

**`FileRef`** — the R2 reference shape ADR-0023 §2 stores in the `attachments`
and `portfolio_images` jsonb columns, camelCased on the wire:

```jsonc
{ "key": "…", "filename": "plans.pdf", "size": 402133, "contentType": "application/pdf", "url": "https://…" }
```

> **DECISION 1 — `proposal` is returned, not refused.** ADR-0023 §5 says the GET
> should `REJECT if r.status = 'submitted'`. The FE needs the opposite: the
> confirmation page re-reads this endpoint so that what it shows is what the
> server actually holds, rather than a souvenir of a form submission that
> evaporates on reload, bookmark or forward. **Single-use applies to the POST,
> not to the GET.** A read of one's own submitted bid leaks nothing the submitter
> did not write.
>
> If the BE keeps the ADR's rejection instead, the confirmation page degrades
> gracefully — it shows the thank-you without the detail list — but the read-back
> is lost, and that is the part that makes it a record.

> **DECISION 2 — `specialties` is a flat `string[]`.** The issue asks for
> "specialty requirements" on the page; ADR-0023 §2 has no column for it. If
> LINA-279 models it as rows or as a typed enum, send the display labels here and
> keep the shape.

### Route 2 — `POST /api/rfp/token/:token/portfolio-images`

`multipart/form-data`, **one** `file` part and nothing else — no declared type,
no size, no uploader. All three are re-derived server-side. Mirrors the stage
attachment upload exactly (LINA-249, `handleUpload` → `readUpload`).

```jsonc
// 201
{ "image": { /* FileRef */ } }
```

> **DECISION 3 — a separate upload route, not files inside the proposal POST.**
> The gateway's `handleUpload` reads a single file part; there is no multi-file
> multipart idiom in this codebase. One-file-at-a-time also lets a contractor see
> each image land (and retry one that fails) instead of losing a whole form to
> the fourth upload. The proposal body then carries `FileRef`s, which is exactly
> what `portfolio_images jsonb` stores.

Server-side: images only (JPEG/PNG/WebP/HEIC), sniffed not trusted; 10 MB cap per
file (same as stage attachments); at most **8** per recipient — the FE enforces
all three as a courtesy and shows the server's answer when it disagrees.

### Route 3 — `POST /api/rfp/token/:token/proposal`

`application/json`. Re-checks the token **and** that the phase is still `active`
before writing (rule 2).

```jsonc
// request
{
  "companyName":     "Acme Builders",
  "websiteUrl":      "https://acme-builders.com/",   // null when not given; always http(s), never a bare domain
  "portfolioImages": [ /* FileRef, from route 2 */ ],
  "budgetMinCents":  25000000,
  "budgetMaxCents":  31000000,
  "timelineDays":    84,                              // whole days; weeks are converted client-side
  "comment":         "…"                              // null when blank; ≤ 4000 chars
}

// 201
{ "proposal": { /* the request fields, plus: */ "submittedAt": "2026-09-13T18:00:00.000Z" } }
```

The FE guarantees before sending: `companyName` non-empty and ≤ 200 chars;
`budgetMaxCents >= budgetMinCents`; `timelineDays > 0` and ≤ 3650; `websiteUrl`
is `http:`/`https:` with a dotted hostname or `null`. **The server must re-check
all of it** — this list is what the form promises, not what the API may assume.

### Error envelope

Standard `{ "error": { "code": …, "message": … } }`. The codes the FE has copy
for, and what it does with each:

| Code | Status | FE behaviour |
|---|---|---|
| `not_found` | 404 | Whole-page dead-link state. Same sentence for unknown and revoked. |
| `rfp_closed` | 410 | Whole-page **"This RFP is no longer accepting proposals."** — also handled at submit time. |
| `already_submitted` | 409 | Redirect to `…/submitted`. Not treated as an error. |
| `invalid_proposal` | 400 | Form banner. |
| `empty_file` / `attachment_too_large` / `unsupported_content_type` / `invalid_filename` / `too_many_images` | 400–415 | Upload banner; whatever already uploaded is kept. |
| anything else | 5xx | "That did not go through. Try again." Never "no longer accepting proposals" — a network blip must not send a live bidder away. |

Rate-limit the GET as the invitation preview is rate-limited (LINA-182).

---

## 4. What the FE shipped

| File | What it is |
|---|---|
| `app/src/lib/rfp-proposal.ts` | Wire types, the three calls, and the pure helpers (draft validation, URL normalisation, weeks→days, formatters). |
| `app/src/lib/rfp-proposal.test.mjs` | 21 unit tests over the pure half. |
| `app/src/app/rfp/RfpShell.tsx` | Masthead + column + the three whole-page states. |
| `app/src/app/rfp/rfp-public.css` | Layout only; every colour is a token, no hex (ADR-0009). |
| `app/src/app/rfp/[token]/page.tsx` + `ProposalClient.tsx` | The form. |
| `app/src/app/rfp/[token]/submitted/page.tsx` + `SubmittedClient.tsx` | The confirmation + read-back. |

`app/tsconfig.json` gains `allowImportingTsExtensions` — see the comment in the
file for why (`node --test --experimental-strip-types` cannot resolve an
extensionless value import, and a second copy of the money parser was the
alternative).

**Not AuthShell.** ADR-0023 §6 offers "existing AuthShell or a minimal shell".
AuthShell is the sign-in door: a photograph, three trust lines about having one
login for every project, and a legal line ending "Secured by Clerk". All of that
is false for a contractor who will never hold an account. The minimal shell
reuses the globals.css control vocabulary (`.card`, `.field`, `.btn`, `.badge`,
`.form-error`), so the net-new visual surface is two pieces: the read-only spec
panel and the portfolio image tray.

---

## 5. What is NOT verified

- **No call in §3 has ever been made.** The BE half does not exist yet. The FE's
  green signals are `tsc --noEmit`, `next build`, and 21 unit tests over pure
  functions — none of which touch the wire.
- **No browser QA.** No screenshot, no real upload, no mobile pass.
- The moment LINA-279 lands, this slice needs: a live token walked end to end, a
  closed-phase token, an already-submitted token, an over-size image, and a
  window that closes between page load and submit.
