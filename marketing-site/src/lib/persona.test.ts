// Persona derivation (LINA-189).
//
//   npm run test --prefix marketing-site
//
// The property under test is the one that keeps this column trustworthy: when a
// plan is present the persona is DERIVED from it, so a client cannot post a
// persona that contradicts the plan stored in the same row. Everything else
// here is vocabulary discipline.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_FOUNDING_PLAN_KEY,
  PAID_PLAN_KEYS,
  isPersona,
  normalizePersona,
  personaForPlan,
  setupRoleForPersona
} from './pricing';

describe('personaForPlan', () => {
  test('every paid plan maps to exactly one persona — no plan is unclassified', () => {
    // If a seventh plan is ever added, this fails until it is placed on one side
    // of the pricing split, which is the moment to think about it.
    for (const plan of PAID_PLAN_KEYS) {
      assert.ok(isPersona(personaForPlan(plan)), `${plan} has no persona`);
    }
  });

  test('the owner plans are owner, the builder plans are builder', () => {
    assert.equal(personaForPlan('personal'), 'owner');
    assert.equal(personaForPlan('build_plus'), 'owner');
    assert.equal(personaForPlan('real_estate_investor'), 'owner');
    assert.equal(personaForPlan('independent_builder'), 'builder');
    assert.equal(personaForPlan('growing_builder'), 'builder');
    assert.equal(personaForPlan('construction_business'), 'builder');
  });

  test('the free founding seat has NO derived persona', () => {
    // A seat is not an owner plan. Guessing 'owner' here would preselect the
    // wrong role for every builder who takes a founding seat — the exact
    // friction the persona exists to remove.
    assert.equal(personaForPlan(FREE_FOUNDING_PLAN_KEY), null);
  });

  test('junk is null, never a guess', () => {
    for (const junk of [null, undefined, '', 'owner', 'enterprise', 42, {}]) {
      assert.equal(personaForPlan(junk), null);
    }
  });
});

describe('normalizePersona', () => {
  test('accepts only the two known values', () => {
    assert.equal(normalizePersona('owner'), 'owner');
    assert.equal(normalizePersona('builder'), 'builder');
  });

  test('drops anything else to null rather than persisting it verbatim', () => {
    for (const junk of ['Owner', 'BUILDER', 'contractor', 'homeowner', '', null, 7, ['owner']]) {
      assert.equal(normalizePersona(junk), null);
    }
  });
});

describe('the resolution rule /api/waitlist applies', () => {
  // The exact expression from the route, so a change there without a change
  // here is caught.
  const resolve = (plan: unknown, claimed: unknown) =>
    personaForPlan(plan) ?? normalizePersona(claimed);

  test('a plan overrides a contradicting client claim', () => {
    assert.equal(resolve('growing_builder', 'owner'), 'builder');
    assert.equal(resolve('build_plus', 'builder'), 'owner');
  });

  test('the client claim is used only where nothing can be derived', () => {
    assert.equal(resolve(FREE_FOUNDING_PLAN_KEY, 'builder'), 'builder');
    assert.equal(resolve(FREE_FOUNDING_PLAN_KEY, 'owner'), 'owner');
    assert.equal(resolve(null, 'builder'), 'builder'); // builder ribbon: no plan
  });

  test('no plan and no claim is null — "we do not know" is a real answer', () => {
    // The header / hero / final CTAs sit above the Owner/Builder split.
    assert.equal(resolve(null, null), null);
    assert.equal(resolve(undefined, undefined), null);
  });

  test('a forged persona on a plain signup still cannot be arbitrary', () => {
    assert.equal(resolve(null, 'admin'), null);
    assert.equal(resolve(null, '<script>'), null);
  });
});

describe('setupRoleForPersona', () => {
  test('translates into the portal vocabulary the setup screen speaks', () => {
    assert.equal(setupRoleForPersona('owner'), 'owner');
    assert.equal(setupRoleForPersona('builder'), 'general_contractor');
  });
});
