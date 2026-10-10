import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_CATEGORIES, effectivePreferences, planTaskUrl, rfpUrl,
  bidSubmittedTargets, clarificationAnsweredTargets, awardedTargets, cancelledTargets,
  invitationAcceptedTargets, variationDigestOrgs, notificationEmail,
} from './notifications.mjs';

const RFP = {
  rfp_id: 'r1', project_id: 'p1', title: 'Telhado', issuer_org_id: 'issuer',
  root_task_ids: ['t1', 't2'], awarded_proposal_id: null,
  bidders: [
    { org_id: 'a', proposal_id: 'pa', proposal_status: 'submitted', active: true },
    { org_id: 'b', proposal_id: 'pb', proposal_status: 'submitted', active: true },
    { org_id: 'gone', proposal_id: 'pg', proposal_status: 'invited', active: false },
  ],
};
const evt = (data = {}) => ({ event_id: 'e', project_id: 'p1', data });

describe('deep links (PRD-12 N-1)', () => {
  test('task panel on a tab; tender at its own address', () => {
    assert.equal(planTaskUrl('p1', 't1', 'tender'), '/projects/p1/plan?task=t1&tab=tender');
    assert.equal(planTaskUrl('p1', null), '/projects/p1/plan');
    assert.equal(rfpUrl('p1', 'r1', 'clarifications'), '/projects/p1/tendering/rfps/r1?tab=clarifications');
  });
});

describe('event → targets', () => {
  test('bids in → the issuer, on the first root task’s Tender tab', () => {
    const [t] = bidSubmittedTargets(evt(), RFP);
    assert.equal(t.orgId, 'issuer');
    assert.equal(t.category, 'bids');
    assert.equal(t.audience, 'project');
    assert.equal(t.objectRef.url, '/projects/p1/plan?task=t1&tab=tender');
    assert.equal(bidSubmittedTargets(evt(), { ...RFP, root_task_ids: [] })[0].objectRef.url, '/projects/p1/tendering/rfps/r1');
    assert.deepEqual(bidSubmittedTargets(evt(), null), []);
  });

  test('clarification answered → active bidder orgs only, by permission', () => {
    const ts = clarificationAnsweredTargets(evt(), RFP);
    assert.deepEqual(ts.map((t) => t.orgId), ['a', 'b']);
    assert.ok(ts.every((t) => t.audience === 'org' && t.permission === 'org:tendering:bid'));
    assert.ok(!ts.some((t) => t.orgId === 'issuer'));
  });

  test('awarded → winner hears it won, the others that they were not selected', () => {
    const ts = awardedTargets(evt({ proposal_id: 'pb' }), RFP);
    assert.deepEqual(ts.map((t) => [t.orgId, /awarded “Telhado”/.test(t.title)]), [['a', false], ['b', true]]);
  });

  test('cancelled → active bidders', () => {
    assert.deepEqual(cancelledTargets(evt(), RFP).map((t) => t.orgId), ['a', 'b']);
  });

  test('invitation accepted → the inviter', () => {
    const [t] = invitationAcceptedTargets(evt({ invited_by_org_id: 'owner' }));
    assert.equal(t.orgId, 'owner');
    assert.equal(t.objectRef.url, '/projects/p1');
    assert.deepEqual(invitationAcceptedTargets(evt({})), []);
  });

  test('variation digest orgs: subscription narrows the audience and opts others in', () => {
    const audience = { kind: 'time', org_ids: ['owner', 'client'] };
    assert.deepEqual(variationDigestOrgs(audience, []), ['owner', 'client']);
    assert.deepEqual(
      variationDigestOrgs(audience, [{ org_id: 'client', kinds: ['cost'] }, { org_id: 'arch', kinds: ['time'] }]),
      ['owner', 'arch'],
    );
    assert.deepEqual(variationDigestOrgs(null), []);
  });
});

describe('preferences and e-mail', () => {
  test('effective set: every category × channel, stored value or enabled', () => {
    const eff = effectivePreferences([{ category: 'bids', channel: 'email', enabled: false }]);
    assert.equal(eff.length, NOTIFICATION_CATEGORIES.length * 2);
    assert.equal(eff.find((p) => p.category === 'bids' && p.channel === 'email').enabled, false);
    assert.equal(eff.find((p) => p.category === 'bids' && p.channel === 'in_app').enabled, true);
  });

  test('e-mail carries the absolute link and escapes the title in HTML', () => {
    const m = notificationEmail({ title: 'A <b>bid</b>', url: '/projects/p1' }, { baseUrl: 'https://x.pt/' });
    assert.equal(m.subject, 'A <b>bid</b>');
    assert.match(m.text, /https:\/\/x\.pt\/projects\/p1/);
    assert.match(m.html, /A &lt;b&gt;bid&lt;\/b&gt;/);
  });
});
