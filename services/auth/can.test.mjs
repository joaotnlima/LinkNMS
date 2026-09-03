// can() — unit + adversarial tests (LINA-143; Architect §8.1 merge gate).
//
// The mandatory merge-gate requirement (LINA-142 §8.1): LINA-143's `can()` is
// rejected at merge unless the `change_order.decide` runtime two-sided rule is
// present and an adversarial test proves a proposer CANNOT decide their own
// change order (even with a static role grant and no ACL). These tests attack
// that rule directly, plus deny-by-default and the resource_acls override order.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { can, PERMISSION } from './can.mjs';

const owner = { userId: 'u-owner', clerkUserId: 'usr_owner', activeOrgId: 'o-1' };
const gc = { userId: 'u-gc', clerkUserId: 'usr_gc', activeOrgId: 'o-1' };
const sub = { userId: 'u-sub', clerkUserId: 'usr_sub', activeOrgId: 'o-1' };
const outsider = { userId: 'u-stranger', clerkUserId: 'usr_x', activeOrgId: null };

const OWNER_PERMS = [PERMISSION.PROJECT_READ, PERMISSION.CHANGE_ORDER_CREATE, PERMISSION.CHANGE_ORDER_DECIDE];
const GC_PERMS = [PERMISSION.PROJECT_READ, PERMISSION.CHANGE_ORDER_CREATE, PERMISSION.CHANGE_ORDER_DECIDE, PERMISSION.SCHEDULE_UPDATE];

function ownerMember(actor) {
  return { actor, action: PERMISSION.CHANGE_ORDER_DECIDE, membership: { roleId: 'r-owner', roleKey: 'owner' }, rolePermissions: OWNER_PERMS };
}

describe('can() — deny by default', () => {
  test('unknown action denies', () => {
    assert.equal(can({ actor: owner, action: 'totally.made_up', membership: { roleKey: 'owner' }, rolePermissions: OWNER_PERMS }).allow, false);
  });

  test('no acting user denies', () => {
    assert.equal(can({ actor: {}, action: PERMISSION.PROJECT_READ }).allow, false);
  });

  test('non-member with no grant denies (403)', () => {
    const r = can({ actor: outsider, action: PERMISSION.BUDGET_READ, membership: null, rolePermissions: [] });
    assert.equal(r.allow, false);
    assert.match(r.reason, /not a member/);
  });

  test('member but role lacks the permission denies (403)', () => {
    const r = can({ actor: sub, action: PERMISSION.PROJECT_UPDATE, membership: { roleId: 'r-sub', roleKey: 'subcontractor' }, rolePermissions: [PERMISSION.PROJECT_READ] });
    assert.equal(r.allow, false);
    assert.match(r.reason, /cannot/);
  });

  test('project.create is the bootstrap exception (no membership needed)', () => {
    assert.deepEqual(can({ actor: { userId: 'u-new' }, action: PERMISSION.PROJECT_CREATE }), { allow: true });
  });
});

describe('can() — role grants allow', () => {
  test('member with the permission allows', () => {
    assert.deepEqual(can({ actor: gc, action: PERMISSION.SCHEDULE_UPDATE, membership: { roleId: 'r-gc', roleKey: 'gc' }, rolePermissions: GC_PERMS }), { allow: true });
  });
});

describe('can() — resource_acls override order (deny wins, then allow, then role)', () => {
  test('resource_acls deny overrides a role grant', () => {
    const r = can({
      actor: owner, action: PERMISSION.BUDGET_READ,
      membership: { roleId: 'r-owner', roleKey: 'owner' },
      rolePermissions: [PERMISSION.BUDGET_READ],
      resourceAcls: [{ key: PERMISSION.BUDGET_READ, effect: 'deny' }],
    });
    assert.equal(r.allow, false);
    assert.match(r.reason, /ACL denies/);
  });

  test('resource_acls allow grants a permission the role lacks', () => {
    assert.deepEqual(can({
      actor: sub, action: PERMISSION.PROJECT_UPDATE,
      membership: { roleId: 'r-sub', roleKey: 'subcontractor' },
      rolePermissions: [PERMISSION.PROJECT_READ],
      resourceAcls: [{ key: PERMISSION.PROJECT_UPDATE, effect: 'allow' }],
    }), { allow: true });
  });

  test('an ACL deny beats an ACL allow on the same verb', () => {
    const one = can({
      actor: gc, action: PERMISSION.CHANGE_ORDER_READ,
      membership: { roleId: 'r-gc', roleKey: 'gc' },
      rolePermissions: GC_PERMS,
      resourceAcls: [{ key: PERMISSION.CHANGE_ORDER_READ, effect: 'allow' }, { key: PERMISSION.CHANGE_ORDER_READ, effect: 'deny' }],
    });
    assert.equal(one.allow, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MANDATORY merge-gate block — the two-sided change-order rule
// (Architect LINA-142 §8.1: rejected at merge without this + an adversarial test)
// ═══════════════════════════════════════════════════════════════════════════════

describe('can() — MANDATORY two-sided rule: a CO proposer cannot decide its own CO', () => {
  test('ADVERSARIAL: the proposer IS denied even with a static role grant and no ACL', () => {
    // The proposer (owner) statically holds change_order.decide and there is no
    // resource_acls row. A naive static-grant-only authorizer would ALLOW this —
    // which is exactly the FR4 violation the Architect's gate forbids.
    const proposer = owner;
    const r = can({
      actor: proposer,
      action: PERMISSION.CHANGE_ORDER_DECIDE,
      resource: { type: 'change_order', id: 'co-1', proposedBy: proposer.userId },
      membership: { roleId: 'r-owner', roleKey: 'owner' },
      rolePermissions: OWNER_PERMS,
      resourceAcls: [],
    });
    assert.equal(r.allow, false, 'proposer decided their own change order — FR4 broken');
    assert.match(r.reason, /cannot decide it/);
  });

  test('a different member WHO IS NOT the proposer is allowed (owner decides gc\u2019s CO)', () => {
    assert.deepEqual(can({
      actor: owner,
      action: PERMISSION.CHANGE_ORDER_DECIDE,
      resource: { type: 'change_order', id: 'co-2', proposedBy: gc.userId },
      membership: { roleId: 'r-owner', roleKey: 'owner' },
      rolePermissions: OWNER_PERMS,
    }), { allow: true });
  });

  test('gc decides another gc\u2019s CO is allowed; gc decides its OWN is denied', () => {
    assert.deepEqual(can({
      actor: gc, action: PERMISSION.CHANGE_ORDER_DECIDE,
      resource: { type: 'change_order', id: 'co-3', proposedBy: 'u-gc2' },
      membership: { roleId: 'r-gc', roleKey: 'gc' }, rolePermissions: GC_PERMS,
    }), { allow: true });

    const self = can({
      actor: gc, action: PERMISSION.CHANGE_ORDER_DECIDE,
      resource: { type: 'change_order', id: 'co-4', proposedBy: gc.userId },
      membership: { roleId: 'r-gc', roleKey: 'gc' }, rolePermissions: GC_PERMS,
    });
    assert.equal(self.allow, false);
  });

  test('FAILS CLOSED (denies) when the proposer is unknown — no silent allow', () => {
    const r = can({
      actor: gc, action: PERMISSION.CHANGE_ORDER_DECIDE,
      resource: { type: 'change_order', id: 'co-5' }, // no proposedBy
      membership: { roleId: 'r-gc', roleKey: 'gc' }, rolePermissions: GC_PERMS,
    });
    assert.equal(r.allow, false);
    assert.match(r.reason, /proposer unknown/);
  });

  test('the rule is stateful per CO instance, not a flat role ban', () => {
    // Same gc role, two different change orders: denied on their own, allowed on
    // someone else's — proving the predicate is per-resource-instance.
    const own = can({ actor: gc, action: PERMISSION.CHANGE_ORDER_DECIDE, resource: { type: 'change_order', proposedBy: gc.userId }, membership: { roleId: 'r-gc', roleKey: 'gc' }, rolePermissions: GC_PERMS });
    const others = can({ actor: gc, action: PERMISSION.CHANGE_ORDER_DECIDE, resource: { type: 'change_order', proposedBy: 'u-other' }, membership: { roleId: 'r-gc', roleKey: 'gc' }, rolePermissions: GC_PERMS });
    assert.equal(own.allow, false);
    assert.equal(others.allow, true);
  });
});
