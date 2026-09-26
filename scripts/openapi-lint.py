#!/usr/bin/env python3
"""Lint cowork/documentation/api/v2/openapi.yaml — the /api/v2 contract.

Contract-first (to-be doc 11 / AGENT-INDEX §7) only works if the contract
itself stays coherent, so CI holds it to the rules the spec claims to follow:

  1. parses as YAML, declares OpenAPI 3.1;
  2. every operation has a unique operationId and at least one tag;
  3. every operation declares security (the global default counts; an
     explicit [] is a deliberate, machine-caller exception e.g. Svix);
  4. every $ref resolves inside the document;
  5. path templating is sane: {params} are declared, colon commands follow
     the POST /resource/{id}:verb convention;
  6. embedded Swagger UI (index.html) is not stale against openapi.yaml.

Stdlib + PyYAML only (present on GitHub runners and dev machines) — no npm
supply-chain surface for a linter.
"""
import json
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPEC_PATH = ROOT / "cowork" / "documentation" / "api" / "v2" / "openapi.yaml"
HTML_PATH = SPEC_PATH.parent / "index.html"

METHODS = {"get", "put", "post", "delete", "patch", "head", "options", "trace"}
errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def resolve_ref(spec: dict, ref: str, where: str) -> None:
    if not ref.startswith("#/"):
        err(f"{where}: external $ref not allowed: {ref}")
        return
    node = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            err(f"{where}: $ref does not resolve: {ref}")
            return
        node = node[part]


def walk_refs(spec: dict, node, where: str) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str):
                resolve_ref(spec, v, where)
            else:
                walk_refs(spec, v, f"{where}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk_refs(spec, v, f"{where}[{i}]")


def main() -> int:
    spec = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))

    version = str(spec.get("openapi", ""))
    if not version.startswith("3.1"):
        err(f"openapi must be 3.1.x, found {version!r}")
    if not spec.get("security"):
        err("a global security default is required (operations opt OUT with security: [])")

    op_ids: dict[str, str] = {}
    ops = 0
    for path, item in (spec.get("paths") or {}).items():
        # {param} declarations vs the template. The colon-command convention
        # (`/contracts/{id}:sign`) keeps the command outside the braces.
        if not path.startswith("/"):
            err(f"path must start with /: {path}")
        templated = set(re.findall(r"\{([^}/]+)\}", path))
        if re.search(r"\{[^}]*:[^}]*\}", path):
            err(f"{path}: the :command belongs after the closing brace — {{id}}:verb")

        path_level_params = {
            p.get("name")
            for p in item.get("parameters", [])
            if isinstance(p, dict) and p.get("in") == "path"
        }
        for method, op in item.items():
            if method not in METHODS or not isinstance(op, dict):
                continue
            ops += 1
            where = f"{method.upper()} {path}"

            op_id = op.get("operationId")
            if not op_id:
                err(f"{where}: missing operationId")
            elif op_id in op_ids:
                err(f"{where}: operationId {op_id!r} already used by {op_ids[op_id]}")
            else:
                op_ids[op_id] = where

            if not op.get("tags"):
                err(f"{where}: missing tags")
            if not op.get("responses"):
                err(f"{where}: missing responses")

            declared = path_level_params | {
                p.get("name")
                for p in op.get("parameters", [])
                if isinstance(p, dict) and p.get("in") == "path"
            }
            for missing in templated - declared:
                err(f"{where}: path parameter {{{missing}}} is not declared")
            for extra in declared - templated:
                err(f"{where}: declares path parameter {extra!r} that is not in the template")

            # Commands are POST (doc 11); a read-shaped command (`:download`,
            # `:stream`, `:suggest` — safe, idempotent, cacheable) is GET.
            if ":" in path and method not in ("post", "get"):
                err(f"{where}: colon commands are POST (or GET when read-shaped)")

    walk_refs(spec, spec, "#")

    # Stale embed check: index.html must carry today's spec verbatim.
    html = HTML_PATH.read_text(encoding="utf-8")
    m = re.search(r"const SPEC = (.*?);\nwindow\.ui", html, flags=re.S)
    if not m:
        err("index.html: could not find the embedded SPEC (regenerate with embed.py)")
    elif json.loads(m.group(1)) != json.loads(json.dumps(spec)):
        err("index.html is stale: run python3 cowork/documentation/api/v2/embed.py")

    if errors:
        print(f"openapi-lint: {len(errors)} problem(s) in {SPEC_PATH.relative_to(ROOT)}")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"openapi-lint: OK — {ops} operations, {len(op_ids)} operationIds, refs resolve, embed fresh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
