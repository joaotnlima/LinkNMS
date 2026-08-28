#!/usr/bin/env python3
"""
LinkNMS R0 audit-trail / budget / permission invariant checker.

This is the FIRST quality gate: a stack-agnostic guard on the three properties
that, if wrong, mean the product has no reason to exist. It runs against a
fixture (or, later, a JSON export from a real API endpoint) and fails the build
on any violation.

Invariants enforced
--------------------
  A. AUDIT IMMUTABILITY (append-only history)
     - Every decision has >=1 revision; revisions are strictly increasing and
       never deleted (rev N implies rev 1..N-1 all present).
     - Every revision is attributed (has `by`) and time-stamped (`at`).
     - Editing a decision must ADD a revision, never mutate an existing one
       (see companion snapshot test in test strategy §5).

  B. BUDGET MATH (no silent data errors)
     - current_total == baseline + sum(delta of APPROVED change orders only).
     - proposed / rejected change orders contribute 0.
     - If the fixture declares `expected`, the computed numbers must match it.

  C. PERMISSION / SEGREGATION OF DUTIES
     - An APPROVED change order must be decided by someone.
     - The decider MUST NOT be the proposer (can't approve your own change).
     - The decider MUST NOT be the project owner acting as... (owner MAY approve
       as the paying party; the rule we enforce is: proposer != decider, AND a
       change proposed BY the owner cannot be self-approved by the owner).
     - Every approved/rejected CO is attributed (decided_by + decided_at set);
       every proposed CO has no decision stamp.

Usage
-----
  python3 audit_budget_invariants.py qa/fixtures/r0_shared_record.json
  # exit 0 = all invariants hold; exit 1 = violation(s); exit 2 = bad input

This file is the seed of the CI gate. When the repo/stack lands, it wires into
CI unchanged (or is ported to the chosen test runner); the fixture and the
expected numbers are the contract.
"""
import json
import sys


class Violation(Exception):
    pass


def _fail(errors, msg):
    errors.append(msg)


def check_audit_immutability(data, errors):
    for d in data.get("decisions", []):
        did = d.get("id", "<no-id>")
        revs = d.get("revisions", [])
        if not revs:
            _fail(errors, f"[AUDIT] decision {did} has no revisions (history must be append-only, never empty)")
            continue
        nums = [r.get("rev") for r in revs]
        if nums != sorted(nums) or len(set(nums)) != len(nums):
            _fail(errors, f"[AUDIT] decision {did} revisions not strictly increasing/unique: {nums}")
        # rev 1..N all present (no gaps => nothing silently dropped)
        if set(nums) != set(range(1, len(nums) + 1)):
            _fail(errors, f"[AUDIT] decision {did} revision sequence has gaps (deleted history?): {nums}")
        for r in revs:
            if not r.get("by"):
                _fail(errors, f"[AUDIT] decision {did} rev {r.get('rev')} is not attributed (missing `by`)")
            if not r.get("at"):
                _fail(errors, f"[AUDIT] decision {did} rev {r.get('rev')} has no timestamp (`at`)")


def check_budget_math(data, errors):
    baseline = data["project"]["budget_baseline_cents"]
    approved_total = 0
    for co in data.get("change_orders", []):
        status = co.get("status")
        delta = co.get("delta_cents", 0)
        if status == "approved":
            approved_total += delta
        elif status in ("proposed", "rejected"):
            pass  # must not move the budget
        else:
            _fail(errors, f"[BUDGET] change order {co.get('id')} has unknown status {status!r}")
    computed_total = baseline + approved_total

    exp = data.get("expected")
    if exp:
        if exp.get("approved_delta_total_cents") != approved_total:
            _fail(errors, f"[BUDGET] approved-delta mismatch: computed {approved_total}, expected {exp.get('approved_delta_total_cents')}")
        if exp.get("current_budget_total_cents") != computed_total:
            _fail(errors, f"[BUDGET] current-total mismatch: computed {computed_total}, expected {exp.get('current_budget_total_cents')}")
    return computed_total, approved_total


def check_permissions(data, errors):
    owner = data["project"].get("owner_party_id")
    for co in data.get("change_orders", []):
        cid = co.get("id")
        status = co.get("status")
        proposer = co.get("proposer_party_id")
        decider = co.get("decided_by_party_id")
        decided_at = co.get("decided_at")

        if status == "proposed":
            if decider or decided_at:
                _fail(errors, f"[PERM] proposed CO {cid} must not carry a decision stamp (decided_by/decided_at)")
            continue

        if status in ("approved", "rejected"):
            if not decider:
                _fail(errors, f"[PERM] {status} CO {cid} is not attributed (missing decided_by_party_id)")
            if not decided_at:
                _fail(errors, f"[PERM] {status} CO {cid} has no decided_at timestamp")
            if decider and proposer and decider == proposer:
                _fail(errors, f"[PERM] CO {cid} was {status} by its own proposer {proposer} (segregation of duties violated)")
            # owner-proposed change cannot be self-approved by the owner
            if proposer == owner and decider == owner:
                _fail(errors, f"[PERM] owner-proposed CO {cid} was self-approved by the owner {owner}")


def run(path):
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: cannot read fixture {path}: {e}", file=sys.stderr)
        return 2

    errors = []
    check_audit_immutability(data, errors)
    total, approved = check_budget_math(data, errors)
    check_permissions(data, errors)

    name = data.get("_meta", {}).get("name", path)
    if errors:
        print(f"FAIL  {name}  ({len(errors)} violation(s))")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f"PASS  {name}")
    print(f"      budget baseline={data['project']['budget_baseline_cents']} "
          f"+ approved_delta={approved} => current_total={total}")
    print(f"      decisions={len(data.get('decisions', []))} "
          f"change_orders={len(data.get('change_orders', []))} "
          f"(append-only history + segregation-of-duties verified)")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: audit_budget_invariants.py <fixture.json>", file=sys.stderr)
        sys.exit(2)
    sys.exit(run(sys.argv[1]))
