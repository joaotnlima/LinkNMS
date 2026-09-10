// Plan templates — resolve/upsert the caller's default plan scaffold (LINA-241;
// ADR-0018). Deliberately unlike the rest of this service:
//
//   - NO ledger seam. A template carries no audit weight — it is copied into a
//     fresh editor draft, never linked to a project's stages (ADR-0002). Nothing
//     here appends an audit event, so there is no transaction to co-commit.
//   - NO project authorization. Templates are per-USER and project-independent;
//     the ONLY gate is authentication (a caller with a session party). The
//     Identity authorizer decides project membership, which does not apply here.
//
// The acting party is ALWAYS the session (`actorPartyId`), NEVER the body — a
// template names no owner (the upsert stamps `owner_id` from the session), so a
// forged owner in a request is inert (authoring contract §0, ADR-0004).
//
// v1 resolution ladder (ADR-0018 §Decisions made): user default → system default.
// Org scope is deferred — the schema carries it, this service neither writes nor
// consults it.
import { DomainError } from './ports.mjs';

const MAX_NAME = 200;

export function createPlanTemplateService({ store }) {
  if (!store) throw new Error('createPlanTemplateService requires { store }');

  function requireActor(actorPartyId) {
    if (!actorPartyId) throw new DomainError(401, 'unauthenticated', 'acting party is required');
  }

  // GET — the applicable default body for the caller. Pure read: touches no
  // project, stage, or version. user default → system default; the migration
  // seeds exactly one system default, so a missing one is a deploy fault (500),
  // not an empty scaffold that would read as data loss.
  async function resolveDefault(actorPartyId) {
    requireActor(actorPartyId);
    const user = await store.getUserDefaultTemplate(actorPartyId);
    if (user) return shape(user, 'user');
    const system = await store.getSystemDefaultTemplate();
    if (system) return shape(system, 'system');
    throw new DomainError(500, 'no_default_template',
      'no system default template is seeded — migration 0008 must run');
  }

  // PUT "save as my default" — upsert the caller's single user default from a
  // posted body. The partial unique index (one default per owner) makes a second
  // save REPLACE the first, never create a 2nd default. The system row is not
  // user-writable in v1 — this only ever writes an `owner_scope='user'` row keyed
  // to the session party.
  async function saveDefault(actorPartyId, { name, body } = {}) {
    requireActor(actorPartyId);
    const cleanBody = validateTemplateBody(body);
    const cleanName = validateName(name);
    const row = await store.upsertUserDefaultTemplate({
      ownerId: actorPartyId, name: cleanName, body: cleanBody,
    });
    return shape(row, 'user');
  }

  return { resolveDefault, saveDefault, validateTemplateBody };
}

// The API view: the resolved body plus its provenance. `body` is surfaced at the
// top level for `seedSkeleton()` (which copies it into a draft) and also inside
// `template` alongside the metadata a "Save as my default" control shows back.
function shape(row, source) {
  return {
    source,
    body: row.body,
    template: {
      id: row.id,
      ownerScope: row.owner_scope,
      name: row.name,
      isDefault: row.is_default,
      updatedAt: row.updated_at,
    },
  };
}

function validateName(name) {
  if (name == null) return 'My default';
  if (typeof name !== 'string') {
    throw new DomainError(400, 'invalid_template', 'name must be a string');
  }
  const trimmed = name.trim();
  if (!trimmed) return 'My default';
  if (trimmed.length > MAX_NAME) {
    throw new DomainError(400, 'invalid_template', `a template name must be ≤ ${MAX_NAME} chars`);
  }
  return trimmed;
}

// The names-only two-level shape the authoring contract enforces, applied at the
// edge: `[{ name, tasks: [name, …] }]`. Everything a template must NOT carry is
// rejected here, not silently dropped —
//   - a 3rd level: a task is a bare STRING; a task-as-object throws `too_deep`;
//   - dates/owners/ids: a phase may hold ONLY { name, tasks } — any other key
//     (start, end, owner, …) is refused, so a scaffold can never smuggle plan
//     data past the copy boundary.
// Returns the normalised body (trimmed names) that gets stored.
export function validateTemplateBody(body) {
  if (!Array.isArray(body) || body.length === 0) {
    throw new DomainError(400, 'invalid_template',
      'body must be a non-empty array of phases');
  }
  return body.map((phase) => {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
      throw new DomainError(400, 'invalid_template', 'each phase must be an object { name, tasks }');
    }
    const extra = Object.keys(phase).filter((k) => k !== 'name' && k !== 'tasks');
    if (extra.length) {
      throw new DomainError(400, 'invalid_template',
        `a template is names-only — a phase carries only { name, tasks } (rejected: ${extra.join(', ')})`);
    }
    const name = typeof phase.name === 'string' ? phase.name.trim() : '';
    if (!name) throw new DomainError(400, 'invalid_template', 'every phase needs a non-empty name');
    if (name.length > MAX_NAME) {
      throw new DomainError(400, 'invalid_template', `a phase name must be ≤ ${MAX_NAME} chars`);
    }
    const rawTasks = phase.tasks ?? [];
    if (!Array.isArray(rawTasks)) {
      throw new DomainError(400, 'invalid_template', 'tasks must be an array of names');
    }
    const tasks = rawTasks.map((t) => {
      if (typeof t !== 'string') {
        throw new DomainError(400, 'too_deep',
          'a task is a name only — no dates, owners, or sub-tasks (the template is two levels)');
      }
      const tn = t.trim();
      if (!tn) throw new DomainError(400, 'invalid_template', 'every task needs a non-empty name');
      if (tn.length > MAX_NAME) {
        throw new DomainError(400, 'invalid_template', `a task name must be ≤ ${MAX_NAME} chars`);
      }
      return tn;
    });
    return { name, tasks };
  });
}
