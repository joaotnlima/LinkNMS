#!/usr/bin/env python3
"""
LinkNMS QA gate runner — the CI entrypoint.

Proves the invariant checker both (a) PASSES the golden fixture and (b) CATCHES
representative tampering. A gate that only ever passes proves nothing; this
runner is the regression guard on the guard.

Run:  python3 qa/checks/run_gate.py
Exit: 0 if the golden fixture passes AND every tampered variant is caught;
      1 otherwise. Wire this exact command into CI as the first quality gate.
"""
import copy
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CHECKER = os.path.join(HERE, "audit_budget_invariants.py")
GOLDEN = os.path.join(ROOT, "qa", "fixtures", "r0_shared_record.json")


def run_checker(path):
    r = subprocess.run([sys.executable, CHECKER, path], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def write_tmp(data):
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    return path


# --- tampering mutators: each must be CAUGHT (checker exit 1) ---------------
def tamper_self_approval(d):
    # GC proposes co_001 AND approves it => segregation-of-duties violation
    for co in d["change_orders"]:
        if co["id"] == "co_001":
            co["decided_by_party_id"] = co["proposer_party_id"]
    return d, "self-approval (proposer approves own CO)"


def tamper_budget_silent_edit(d):
    # bump an approved delta without touching `expected` => silent budget error
    for co in d["change_orders"]:
        if co["id"] == "co_001":
            co["delta_cents"] += 100000
    return d, "silent budget tampering (delta changed, total stale)"


def tamper_count_rejected(d):
    # count a REJECTED CO into the budget by flipping it to approved but keeping
    # expected totals => proves rejected/proposed must not move the budget
    for co in d["change_orders"]:
        if co["id"] == "co_004":
            co["status"] = "approved"
    return d, "rejected CO leaking into budget total"


def tamper_delete_history(d):
    # drop revision 1 of dec_002 => append-only history broken (gap)
    for dec in d["decisions"]:
        if dec["id"] == "dec_002":
            dec["revisions"] = [r for r in dec["revisions"] if r["rev"] != 1]
    return d, "deleted decision-history revision (audit trail mutated)"


def tamper_unattributed_approval(d):
    # approve a CO with no decider => attribution lost
    for co in d["change_orders"]:
        if co["id"] == "co_002":
            co["decided_by_party_id"] = None
    return d, "approval with no attribution"


TAMPERS = [
    tamper_self_approval,
    tamper_budget_silent_edit,
    tamper_count_rejected,
    tamper_delete_history,
    tamper_unattributed_approval,
]


def main():
    ok = True

    print("== golden fixture (must PASS) ==")
    code, out = run_checker(GOLDEN)
    print(out.rstrip())
    if code != 0:
        print("!! GOLDEN FIXTURE FAILED — gate is broken\n")
        ok = False
    else:
        print("   -> golden OK\n")

    with open(GOLDEN) as fh:
        base = json.load(fh)

    print("== tampered variants (each must be CAUGHT) ==")
    for mut in TAMPERS:
        data, label = mut(copy.deepcopy(base))
        path = write_tmp(data)
        try:
            code, out = run_checker(path)
        finally:
            os.unlink(path)
        caught = code == 1
        mark = "OK  " if caught else "MISS"
        print(f"  [{mark}] {label}")
        if not caught:
            print(f"         expected exit 1, got {code}. Output:\n{out}")
            ok = False

    print()
    if ok:
        print("GATE PASSED: golden clean, all tampering caught.")
        return 0
    print("GATE FAILED.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
