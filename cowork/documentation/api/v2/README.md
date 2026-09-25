# api/v2 — LinkNMS API contract (OpenAPI 3.1)

**`openapi.yaml` is the source of truth** for the UI, for the implementation and for the MCP server.
Every endpoint in `cowork/documentation/to-be/12-api-catalogue.md` is here, grouped by domain (tag).

- Open **`index.html`** in a browser (works from disk, no server needed: Swagger UI is vendored in `vendor/`).
- After editing `openapi.yaml`, regenerate the page: `python3 api/v2/embed.py` (needs `pip install pyyaml`).
- Lint: `npx @redocly/cli lint api/v2/openapi.yaml` (add to CI).

## Extensions used on every operation

| Extension | Meaning |
|---|---|
| `x-clerk-permission` | Custom Clerk permission the person needs in the active org (to-be/16 §5) |
| `x-relationship` | Relationship LinkNMS checks on the object (to-be/04, 05 §12) |
| `x-mcp-tool` / `x-mcp-mode` | Name of the MCP tool that exposes it; `read` or `write-confirm` (to-be/19) |
| `x-human-only` | Never exposed to agents: signing, publishing, approving, verifying, paying |

## Maintenance rules

1. Contract first: a new or changed endpoint lands here **before** the route handler and the UI.
2. Any change to a behaviour in `to-be/` that affects the wire updates this file in the same PR.
3. Additive changes only within v2 (to-be/11). A breaking change starts `api/v3`.
4. Keep `operationId`s stable: the MCP tool names and the generated clients depend on them.
