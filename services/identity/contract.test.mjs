// Contract tests (design §9, ADR-0006 §2): the published openapi.yaml stays in
// sync with the in-code spec, and REAL service responses validate against the
// spec's schemas — so the doc can never drift from the running service. Zero-dep.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spec, schemas, toYaml } from './openapi.mjs';
import { createMemoryLedger } from './ledger-port.mjs';
import { createMemoryStore } from './store.mjs';
import { createIdentityService } from './identity.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// A tiny JSON-Schema-subset validator: type, required, properties, enum, items,
// $ref (into components.schemas), integer/minimum. Returns a list of paths that
// failed — enough to contract-test our own responses without a dependency.
function validate(schema, value, path = '$', errs = []) {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return validate(schemas[name], value, path, errs);
  }
  // OpenAPI 3.1 is JSON Schema 2020-12, where `type` may be a UNION and
  // nullability is spelled `['string', 'null']` (3.0's `nullable` is gone). A
  // union passes if the value satisfies any branch — without this, an optional
  // field like `Invitation.email` could not be expressed at all.
  if (Array.isArray(schema.type)) {
    const ok = schema.type.some(
      (one) => validate({ ...schema, type: one }, value, path, []).length === 0,
    );
    if (!ok) errs.push(`${path}: expected one of ${schema.type.join(' | ')}`);
    return errs;
  }
  const t = schema.type;
  if (t === 'null') {
    if (value !== null) errs.push(`${path}: expected null`);
  } else if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errs.push(`${path}: expected object`); return errs;
    }
    for (const req of schema.required ?? []) {
      if (!(req in value)) errs.push(`${path}.${req}: required, missing`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) validate(sub, value[k], `${path}.${k}`, errs);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) { errs.push(`${path}: expected array`); return errs; }
    value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errs));
  } else if (t === 'integer') {
    if (!Number.isInteger(value)) errs.push(`${path}: expected integer`);
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path}: < minimum`);
  } else if (t === 'string') {
    if (typeof value !== 'string') errs.push(`${path}: expected string`);
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  }
  return errs;
}

const conforms = (schemaName, value) => {
  const errs = validate({ $ref: `#/components/schemas/${schemaName}` }, value);
  assert.equal(errs.length, 0, `response violates ${schemaName}: ${errs.join('; ')}`);
};

function svc() {
  const ledger = createMemoryLedger();
  const store = createMemoryStore({ ledger });
  return createIdentityService({ store, ledger });
}

describe('OpenAPI artifact', () => {
  test('committed openapi.yaml is the exact render of the in-code spec (no drift)', () => {
    const onDisk = readFileSync(join(here, 'openapi.yaml'), 'utf8');
    assert.equal(onDisk, toYaml(spec),
      'openapi.yaml is stale — re-run: node -e "import(\'./openapi.mjs\').then(m=>process.stdout.write(m.toYaml(m.spec)))" > openapi.yaml');
  });

  test('the Identity operations are all present', () => {
    const ops = Object.values(spec.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
    for (const op of [
      'createProject', 'getProject', 'setOperatingModel',
      'inviteCounterparty', 'acceptInvitation', 'previewInvitation', 'getMe',
    ]) {
      assert.ok(ops.includes(op), `missing operation ${op}`);
    }
  });
});

describe('live responses conform to the published schemas', () => {
  test('createProject → Project', async () => {
    const s = svc();
    const p = await s.createProject({ actorPartyId: randomUUID(), name: 'Maple', baselineBudgetCents: 500 });
    conforms('Project', p);
  });

  test('getProject → Project', async () => {
    const s = svc();
    const o = randomUUID();
    const p = await s.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 500 });
    conforms('Project', await s.getProject({ actorPartyId: o, projectId: p.id }));
  });

  test('inviteCounterparty → InvitationCreated (with a one-time token)', async () => {
    const s = svc();
    const o = randomUUID();
    const p = await s.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 500 });
    const res = await s.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    conforms('InvitationCreated', res);
  });

  test('acceptInvitation → MembershipCreated', async () => {
    const s = svc();
    const o = randomUUID();
    const p = await s.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 500 });
    const { token } = await s.inviteCounterparty({ actorPartyId: o, projectId: p.id });
    conforms('MembershipCreated', await s.acceptInvitation({ actorPartyId: randomUUID(), token }));
  });

  test('previewInvitation → InvitationPreview (LINA-182)', async () => {
    // Stub the sender so a real email address is stored and flows through the
    // preview payload (the schema's `email` can be null, but the mailed path is
    // the one the deep-link pre-fill depends on).
    const ledger = createMemoryLedger();
    const store = createMemoryStore({ ledger });
    const s = createIdentityService({
      store,
      ledger,
      sender: { isConfigured: () => true, send: async () => {} },
      env: {},
    });
    const o = randomUUID();
    const p = await s.createProject({ actorPartyId: o, name: 'Maple', baselineBudgetCents: 500 });
    const { token } = await s.inviteCounterparty({
      actorPartyId: o, projectId: p.id, email: 'gc@example.com',
    });
    const preview = await s.previewInvitation({ token });
    conforms('InvitationPreview', preview);
  });
});
