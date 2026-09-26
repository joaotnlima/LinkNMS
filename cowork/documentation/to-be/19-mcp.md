# 19 — MCP: where agents help, and how

**Status:** Proposed (D-37). An MCP server lets a person *talk* to LinkNMS ("T3 in Maia with a garage;
I want one builder for the structure and I'll hire the electrician myself") and have the platform
build the project structure properly. The operations it may use are marked in the API contract with
`x-mcp-tool`: [`api/v2/openapi.yaml`](../../../api/v2/README.md).

## 1. Rules (non-negotiable)

1. **The MCP server is a client of the public API. It is not a side door.** It calls the same
   endpoints with the same checks: Clerk permission, relationship, entitlement. An agent can never do
   more than the person it acts for.
2. **It acts as the person.** OAuth with Clerk; the token carries the person and the active org. Every
   write is attributed to that person, with `channel = mcp` in the ledger and the field-change history
   (`record.audit_event.channel`, `planning.task_field_change.channel`).
3. **Structural writes are dry-run → confirm.** `apply_plan_changes` runs with `dry_run = true`, the
   diff is shown to the person, and only their confirmation applies it. All MCP writes are
   `x-mcp-mode: write-confirm`.
4. **Human-only acts are never tools** (`x-human-only`): signing and awarding, publishing an RFP,
   approving or rejecting change orders and measurements, verifying work, declaring or confirming
   payments, closing non-conformities, writing reviews, changing subscriptions. These are the
   moments whose value is that a person did them.
5. **Tools are generated from the contract.** Adding `x-mcp-tool` to an operation exposes it; nothing
   else can.

## 2. The zones where it earns its place

| Zone | What the person says | Tools used (in order) | Why an agent helps here |
|---|---|---|---|
| **Compose the project** | "T3, 2 floors, detached garage, Maia. Turnkey for the structure, electrician on my own." | `create_project` → `add_location` ×2 → `list_templates` / `get_template` → `list_specialties` → `apply_plan_changes (dry_run)` → *confirm* → `apply_plan_changes` | The hardest step for a first-time owner: turning a brief into a WBS with the right specialties and links. The template plus the brief gives a first plan in minutes. The contract shape (D-35) follows from which rows get tendered. |
| **Prepare a tender** | "Ask 5 plumbers near Maia for the plumbing branch." | `get_plan` → `draft_rfp` → `find_companies` → `add_rfp_recipients` | Packaging a subtree and choosing recipients is tedious. **Publishing stays human.** |
| **Understand proposals** | "Which plumbing proposal is best, and what's missing?" | `compare_proposals` → `compare_proposals_matrix` | Line-by-line reading of 3–5 priced plans; flags missing lines and outliers. The decision stays human. |
| **Import a plan** | "Here is the GC's Excel / PDF plan." | `get_plan` → `apply_plan_changes (dry_run, create_rows + links)` → *confirm* | Mapping messy spreadsheets and PDFs into rows and links, beyond the column-mapping import. |
| **Explain changes** | "Why did the end date move? Who changed what this week?" | `project_status` → `explain_changes` → `who_changed_what` → `get_task` | The owner's core anxiety. The agent narrates the variation chain (masonry +10 wd → plumbing and electrical pushed; end date unchanged) with sources in the record. |
| **Field reporting** | (voice, on site) "Plumbing on the ground floor is done, here are the photos." | `my_tasks` → `report_progress` → `ask_question` | The tradesperson who refuses forms (17: independent / rare specialty) can report in one sentence. |
| **Month-end** | "Prepare this month's measurement." | `suggest_measurement` → *(the person submits in the UI)* | Quantities come from verified rows; approval stays human. |
| **Minutes** | "Record today's site meeting: …" | `record_minutes` → `ask_question` | Turns a dictated meeting into acknowledged items linked to rows. |

## 3. The first flow to build: compose the project

```mermaid
sequenceDiagram
    autonumber
    participant U as Owner (voice / chat)
    participant A as Agent (MCP client)
    participant M as LinkNMS MCP server
    participant API as /api/v2

    U->>A: "T3, 2 floors, garage, Maia; builder for structure, my own electrician"
    A->>M: create_project(brief)
    M->>API: POST /projects
    A->>M: add_location(Moradia), add_location(Garagem)
    A->>M: list_templates(construction_type=detached_house)
    A->>M: get_template(id)
    A->>M: apply_plan_changes(dry_run, insert_template + exclude specialties + garage branch)
    M->>API: POST /projects/{id}/schedule:apply {dry_run:true}
    API-->>A: diff: 24 rows, 18 links, 3 bridged, health: 24 undated
    A-->>U: shows the tree; "Tender 'Execução — estrutura' to a GC and 'Eletricidade' directly?"
    U->>A: confirm
    A->>M: apply_plan_changes(same ops)
    M->>API: POST …:apply {dry_run:false}  (channel = mcp, attributed to the owner)
    A->>M: draft_rfp(root = Estrutura), draft_rfp(root = Eletricidade)
    A-->>U: "Two tenders drafted. Review and publish them in LinkNMS."
```

## 4. Architecture

- **LinkNMS MCP server**: remote, streamable HTTP (e.g. `mcp.linknms.com`), OAuth via Clerk. It is
  stateless: every tool is one or more API calls.
- **Tool definitions** are generated from `openapi.yaml`: the operations with `x-mcp-tool`, their
  request schemas and descriptions. Today 33 tools are marked; 14 operations are marked human-only.
- **Prompts** (MCP prompts) package the flows above: `compose_project_from_brief`,
  `prepare_tender`, `explain_this_week`.
- **No model runs inside LinkNMS for this.** The reasoning happens in the MCP client. LinkNMS stays a
  deterministic system of record. Server-side AI (for example summarising a variation digest) is a
  separate decision.

## 5. Open points

- Whether a first-party chat/voice surface ships inside the app, or only the MCP server for external
  clients.
- Rate limits and cost per org tier for agent traffic (Billing).
- Template quality is the ceiling of "compose the project": the LinkNMS starter library (D-30) needs
  to exist first.
