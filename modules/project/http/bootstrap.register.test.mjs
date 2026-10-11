// PRD-09 over the /api/v2 router, DB-free: the build home's overview composed
// from the owning modules' ports (O-1), the participants list with trade and
// staffed people (O-3), the PartyInvite and the inviter's invitations (O-4),
// and the accept preview naming the actual role (O-5).
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createRouter } from '../../../platform/router.mjs';
import { createViewerContext } from '../../../platform/viewer-context.mjs';
import { registerProject } from './register.mjs';

const OWNER_ORG = '01920000-0000-7000-8000-0000000007a1';
const GC_ORG = '01920000-0000-7000-8000-0000000007a2';
const STRANGER = '01920000-0000-7000-8000-0000000007a9';
const PROJECT = '01920000-0000-7000-8000-0000000007b1';
const ME = '01920000-0000-7000-8000-0000000007c1';

function fakeStore() {
  const invitations = [];
  return {
    invitations,
    async getPersonByClerkId() { return { id: ME, email: 'ana@casa.pt' }; },
    async getProject(id) {
      return id === PROJECT ? { id, owner_org_id: OWNER_ORG, created_by_org_id: OWNER_ORG, name: 'Casa Almeida', municipality_code: '1111', status: 'draft', version: 1 } : null;
    },
    async isParticipant(projectId, orgId) { return projectId === PROJECT && orgId === GC_ORG; },
    async isStaffed() { return true; },
    async isPrimeSupplier() { return false; },
    async getOperatingModel() { return 'undetermined'; },
    async listParticipants() {
      return {
        items: [
          { org_id: OWNER_ORG, capacity: 'owner', source: 'project', org_kind: 'household', legal_name: 'Família Almeida' },
          { org_id: GC_ORG, capacity: 'consultant', source: 'invitation', invite_capacity: 'contractor', specialty_code: 'electrical', org_kind: 'contractor', legal_name: 'Ferreira' },
        ],
        nextCursor: null,
      };
    },
    async listInvitationsSentBy(_p, orgId) {
      return { items: invitations.filter((i) => i.invited_by_org_id === orgId), nextCursor: null };
    },
    async createInvitation(cmd) {
      const row = {
        id: cmd.id, project_id: cmd.projectId, invited_by_org_id: cmd.invitedByOrgId, email: cmd.email,
        capacity: cmd.capacity, specialty_code: cmd.specialtyCode, invitee_name: cmd.inviteeName, scope_note: cmd.scopeNote,
        status: 'pending', token_hash: cmd.tokenHash, expires_at: cmd.expiresAt, created_at: '2026-10-11T10:00:00Z',
      };
      invitations.push(row);
      return row;
    },
    async getInvitationPreviewByTokenHash(hash) {
      const i = invitations.find((x) => x.token_hash === hash);
      return i ? { ...i, project_name: 'Casa Almeida', invited_by_name: 'Família Almeida' } : null;
    },
  };
}

const specialties = {
  async exists(code) { return code === 'electrical'; },
  async describe(code) { return code === 'electrical' ? { code, name_en: 'Electrical', name_pt: 'Instalações elétricas' } : null; },
};

const facts = {
  planning: { async planFacts() { return { rows: 7, top_level: 2, start: '2026-09-01', end_date: { baseline: null, current: '2026-10-20' }, open_variations: 1, health: { undated_rows: [], blocking: false } }; } },
  contracting: { async costFor({ viewer }) { return viewer.has('org:money:view') ? { contracts: 1, baseline_cents: 100, current_cents: 120 } : null; } },
  quality: { async projectFacts() { return { pending_verifications: 2, open_nonconformities: { quality: 0, safety: 1 } }; } },
  questions: { async openQuestionCount() { return 3; } },
};

const viewer = (orgId, permissions = ['org:projects:staff', 'org:money:view']) => createViewerContext({
  clerkUserId: 'user_me', orgId, clerkOrgId: `c_${orgId}`, orgKind: 'household', orgRole: 'admin', permissions,
});

describe('PRD-09 build home, participants, PartyInvite', () => {
  let router, store;
  const call = (method, path, v = viewer(OWNER_ORG), body = null) => router.dispatch({ method, path, viewer: v, body, headers: {}, query: {} });

  beforeEach(() => {
    router = createRouter();
    store = fakeStore();
    // Identity's organisation port answers who each org staffed on the build.
    const orgs = {
      async staffedPeople(_p, orgIds) {
        return orgIds.includes(GC_ORG) ? [{ org_id: GC_ORG, person_id: ME, name: 'Nuno Ferreira' }] : [];
      },
    };
    registerProject(router, { store, shareBaseUrl: () => 'https://x', specialties, facts, orgs });
  });

  test('O-1: the overview composes the ports; money is absent without org:money:view', async () => {
    const res = await call('GET', `/projects/${PROJECT}/overview`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plan, { rows: 7, top_level: 2, start: '2026-09-01' });
    assert.deepEqual(res.body.end_date, { current: '2026-10-20' });
    assert.deepEqual(res.body.cost.current, { amount_cents: 120, currency: 'EUR' });
    assert.deepEqual([res.body.open_variations, res.body.open_questions, res.body.pending_verifications], [1, 3, 2]);
    assert.deepEqual(res.body.open_nonconformities, { quality: 0, safety: 1 });
    const noMoney = await call('GET', `/projects/${PROJECT}/overview`, viewer(OWNER_ORG, []));
    assert.equal('cost' in noMoney.body, false);
    assert.equal((await call('GET', `/projects/${PROJECT}/overview`, viewer(STRANGER))).status, 404);
  });

  test('O-3: participants carry the trade and the staffed people', async () => {
    const res = await call('GET', `/projects/${PROJECT}/participants`);
    const gc = res.body.items.find((p) => p.org.id === GC_ORG);
    assert.deepEqual([gc.invite_capacity, gc.specialty_code, gc.specialty_name], ['contractor', 'electrical', 'Electrical']);
    assert.deepEqual(gc.people, [{ person_id: ME, name: 'Nuno Ferreira' }]);
    assert.deepEqual(res.body.items.find((p) => p.org.id === OWNER_ORG).people, []);
  });

  test('O-4: PartyInvite validates the trade and the lengths; the inviter lists its own invitations', async () => {
    const bad = await call('POST', `/projects/${PROJECT}/invitations`, viewer(OWNER_ORG), { email: 'n@f.pt', capacity: 'contractor', specialty_code: 'astrology', scope_note: 'x'.repeat(1001) });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.body.errors).sort(), ['scope_note', 'specialty_code']);
    const ok = await call('POST', `/projects/${PROJECT}/invitations`, viewer(OWNER_ORG), {
      email: 'Nuno@Ferreira.pt', name: 'Nuno Ferreira — Ferreira Construção', capacity: 'contractor', specialty_code: 'electrical', scope_note: 'Whole-house wiring',
    });
    assert.equal(ok.status, 201);
    assert.deepEqual([ok.body.email, ok.body.name, ok.body.specialty_name, ok.body.status], ['nuno@ferreira.pt', 'Nuno Ferreira — Ferreira Construção', 'Electrical', 'pending']);
    assert.ok(ok.body.token);
    const mine = await call('GET', `/projects/${PROJECT}/invitations`);
    assert.equal(mine.body.items.length, 1);
    assert.equal('token' in mine.body.items[0], false);
    const theirs = await call('GET', `/projects/${PROJECT}/invitations`, viewer(GC_ORG));
    assert.equal(theirs.body.items.length, 0, 'another org never reads the addresses I invited');
    store.invitations[0].expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await call('GET', `/projects/${PROJECT}/invitations`)).body.items[0].status, 'expired');
  });

  test('O-5: the anonymous preview names the actual role — the trade, the name, the scope', async () => {
    const sent = await call('POST', `/projects/${PROJECT}/invitations`, viewer(OWNER_ORG), {
      email: 'n@f.pt', name: 'Nuno', capacity: 'contractor', specialty_code: 'electrical', scope_note: 'Wiring',
    });
    const res = await router.dispatch({ method: 'GET', path: `/project-invitations/${sent.body.token}`, viewer: null, headers: {}, query: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      project_name: 'Casa Almeida', invited_by_name: 'Família Almeida', capacity: 'contractor',
      specialty_code: 'electrical', specialty_name: 'Electrical', invitee_name: 'Nuno', scope_note: 'Wiring',
    });
    assert.equal(createHash('sha256').update(sent.body.token).digest('hex'), store.invitations[0].token_hash);
  });
});
