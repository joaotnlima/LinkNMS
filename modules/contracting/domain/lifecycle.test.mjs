// The doc-06/09 contract state machine and the doc-04 projection, pure.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { transition, signatureOutcome, visibilityOf, contractBody } from './lifecycle.mjs';

const CLIENT = 'org-client';
const SUPPLIER = 'org-supplier';

describe('transition table (doc 09 §Contract)', () => {
  test('the legal path: draft → signed → active → provisionally_received → closed', () => {
    assert.deepEqual(transition('draft', 'sign', { bothPartiesSigned: true }), { ok: true, to: 'signed' });
    assert.deepEqual(transition('signed', 'activate'), { ok: true, to: 'active' });
    assert.deepEqual(
      transition('active', 'receive_provisionally', { noOpenNonConformities: true }),
      { ok: true, to: 'provisionally_received' },
    );
    assert.deepEqual(transition('provisionally_received', 'close'), { ok: true, to: 'closed' });
  });

  test('sign without both signatures is refused', () => {
    assert.equal(transition('draft', 'sign', {}).ok, false);
  });

  test('cancel only from draft; terminate from signed/active only', () => {
    assert.equal(transition('draft', 'cancel').ok, true);
    assert.equal(transition('signed', 'cancel').ok, false);
    assert.equal(transition('signed', 'terminate').ok, true);
    assert.equal(transition('active', 'terminate').ok, true);
    assert.equal(transition('draft', 'terminate').ok, false);
    assert.equal(transition('closed', 'terminate').ok, false);
  });

  test('provisional reception is blocked by open non-conformities', () => {
    assert.equal(transition('active', 'receive_provisionally', { noOpenNonConformities: false }).ok, false);
  });
});

describe('signatureOutcome', () => {
  const base = { clientOrgId: CLIENT, supplierOrgId: SUPPLIER };

  test('first signature does not sign the contract', () => {
    assert.deepEqual(
      signatureOutcome({ ...base, signatures: [], signerOrgId: CLIENT }),
      { alreadySigned: false, becomesSigned: false },
    );
  });

  test('counter-signature by the other party signs it', () => {
    assert.deepEqual(
      signatureOutcome({ ...base, signatures: [{ org_id: CLIENT }], signerOrgId: SUPPLIER }),
      { alreadySigned: false, becomesSigned: true },
    );
  });

  test('an org cannot sign twice', () => {
    assert.equal(
      signatureOutcome({ ...base, signatures: [{ org_id: CLIENT }], signerOrgId: CLIENT }).alreadySigned,
      true,
    );
  });
});

describe('projection (doc 04 V2/V3, invariant §6.5)', () => {
  const found = {
    contract: {
      id: 'c1', project_id: 'p1', kind: 'sub', parent_contract_id: 'c0',
      reference: 'SUB-1', specialties: ['plumbing'],
      scope_inclusions: 'all pipes', scope_exclusions: null,
      payment_terms: 'measurement_monthly', retention_bp: 500, payment_days: 30,
      contractual_start: '2026-10-01', contractual_end: null,
      revision: 1, status: 'draft', client_org_id: CLIENT, supplier_org_id: SUPPLIER,
      sponsored_by_org_id: null, version: 1,
    },
    client: { id: CLIENT, kind: 'contractor', legal_name: 'Douro', nif: null },
    supplier: { id: SUPPLIER, kind: 'contractor', legal_name: 'Norte', nif: '500100200' },
    roots: ['t1'],
    signatures: [],
    valueCents: 760000,
  };

  test('parties are V2 (full)', () => {
    assert.equal(visibilityOf(found.contract, CLIENT), 'full');
    assert.equal(visibilityOf(found.contract, SUPPLIER), 'full');
  });

  test('anyone else — including the ancestor client (V3) — is scope-only', () => {
    assert.equal(visibilityOf(found.contract, 'org-owner'), 'scope');
  });

  test('full + org:money:view carries the value and the commercial terms', () => {
    const body = contractBody(found, { visibility: 'full', canSeeMoney: true });
    assert.deepEqual(body.value, { amount_cents: 760000, currency: 'EUR' });
    assert.equal(body.retention_bp, 500);
    assert.equal(body.payment_terms, 'measurement_monthly');
    assert.equal(body._visibility, 'full');
    assert.equal(body.contractual_start, '2026-10-01');
  });

  test('full WITHOUT org:money:view: value ABSENT (not null), terms present', () => {
    const body = contractBody(found, { visibility: 'full', canSeeMoney: false });
    assert.equal('value' in body, false);
    assert.equal(body.retention_bp, 500);
  });

  test('scope view: value AND commercial terms absent, scope text present', () => {
    const body = contractBody(found, { visibility: 'scope', canSeeMoney: true });
    assert.equal('value' in body, false);
    assert.equal('retention_bp' in body, false);
    assert.equal('payment_terms' in body, false);
    assert.equal('payment_days' in body, false);
    assert.equal(body.scope_inclusions, 'all pipes');
    assert.equal(body.status, 'draft');
    assert.equal(body._visibility, 'scope');
  });
});
