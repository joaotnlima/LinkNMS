// Identity & Membership — OpenAPI 3.1 contract, authored in code (ADR-0006 §2).
//
// This object is the single source of truth. `openapi.yaml` (the artifact rendered
// at /api/docs) is emitted from it by `toYaml(spec)`, and the contract test asserts
// the committed YAML is in sync and validates real service responses against the
// `components.schemas` here — so the doc can never drift from the running service.
//
// Errors are uniformly `{ error: { code, message } }` (design §6). The acting party
// is derived server-side from the session (never a body/query param), so no request
// schema carries an actor field — that is a security property of the contract.

const roleEnum = { type: 'string', enum: ['owner', 'counterparty'] };
const partyRoleEnum = { type: 'string', enum: ['owner', 'contractor', 'viewer'] };

export const schemas = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            enum: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'bad_request'],
          },
          message: { type: 'string' },
        },
      },
    },
  },
  // GET /me — the acting party's own profile (LINA-154). The display name is the
  // authoritative identity.party value (LINA-132 setup), never derived from the
  // email local-part.
  MeProfile: {
    type: 'object',
    required: ['partyId', 'displayName'],
    properties: {
      partyId: { type: 'string' },
      displayName: { type: 'string' },
      email: { type: ['string', 'null'] },
      role: partyRoleEnum,
    },
  },
  Member: {
    type: 'object',
    required: ['partyId', 'role', 'joinedAt'],
    properties: { partyId: { type: 'string' }, role: roleEnum, joinedAt: { type: 'string' } },
  },
  Project: {
    type: 'object',
    required: [
      'id', 'name', 'ownerPartyId', 'baselineBudgetCents', 'currentBudgetCents',
      'actingRole', 'createdAt', 'members',
    ],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      ownerPartyId: { type: 'string' },
      baselineBudgetCents: { type: 'integer' },
      currentBudgetCents: { type: 'integer' },
      actingRole: roleEnum,
      createdAt: { type: 'string' },
      members: { type: 'array', items: { $ref: '#/components/schemas/Member' } },
    },
  },
  Membership: {
    type: 'object',
    required: ['id', 'projectId', 'partyId', 'role', 'joinedAt'],
    properties: {
      id: { type: 'string' },
      projectId: { type: 'string' },
      partyId: { type: 'string' },
      role: roleEnum,
      joinedAt: { type: 'string' },
    },
  },
  Invitation: {
    type: 'object',
    required: ['id', 'projectId', 'role', 'status', 'createdAt'],
    properties: {
      id: { type: 'string' },
      projectId: { type: 'string' },
      role: roleEnum,
      status: { type: 'string', enum: ['pending', 'accepted'] },
      // OpenAPI 3.1 is JSON Schema 2020-12: nullability is a type union, not the
      // 3.0 `nullable` keyword (which 3.1 removed).
      email: {
        type: ['string', 'null'],
        description: 'The address the invitation was mailed to; null on the out-of-band path.',
      },
      createdAt: { type: 'string' },
    },
  },
  // The invite response returns the raw token EXACTLY once (never persisted).
  InvitationCreated: {
    type: 'object',
    required: ['invitation', 'token'],
    properties: {
      invitation: { $ref: '#/components/schemas/Invitation' },
      token: { type: 'string' },
      emailed: {
        type: 'boolean',
        description:
          'True only when the invitation was actually handed to the mailer. The raw token ' +
          'is returned either way, so a delivery failure never strands the inviter.',
      },
    },
  },
  MembershipCreated: {
    type: 'object',
    required: ['membership'],
    properties: { membership: { $ref: '#/components/schemas/Membership' } },
  },
  CreateProjectRequest: {
    type: 'object',
    required: ['name', 'baselineBudgetCents'],
    properties: {
      name: { type: 'string' },
      baselineBudgetCents: { type: 'integer', minimum: 0 },
    },
  },
  InviteRequest: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['counterparty'] },
      email: {
        type: ['string', 'null'],
        format: 'email',
        description:
          'Optional (LINA-84). Supplied, the invitation link is emailed to this address and ' +
          'the response reports `emailed`. Omitted, nothing is sent and the caller delivers ' +
          'the raw token out of band. Lower-cased server-side, same normalisation as sign-in.',
      },
    },
  },
};

const json = (ref) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } });
const errorResponse = (desc) => ({ description: desc, content: json('Error') });

export const spec = {
  openapi: '3.1.0',
  info: {
    title: 'LinkNMS Identity & Membership',
    version: '0.1.0',
    description:
      'Projects, memberships, invitations, and the sole authorizer (ADR-0004). ' +
      'The acting party is always derived server-side from the session, never the body.',
  },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/me': {
      get: {
        operationId: 'getMe',
        summary: 'The acting party’s own profile (identity.party): display name, email, role.',
        responses: {
          200: { description: 'The party’s profile', content: json('MeProfile') },
          401: errorResponse('No acting party in session'),
          404: errorResponse('Party not found'),
        },
      },
    },
    '/projects': {
      post: {
        operationId: 'createProject',
        summary: 'Start a shared record; the creator becomes its owner (FR1).',
        requestBody: { required: true, content: json('CreateProjectRequest') },
        responses: {
          201: { description: 'Project created', content: json('Project') },
          400: errorResponse('Invalid name or baseline'),
          401: errorResponse('No acting party in session'),
        },
      },
    },
    '/projects/{id}': {
      get: {
        operationId: 'getProject',
        summary: 'Project + memberships + budget summary. Members only.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Project view', content: json('Project') },
          401: errorResponse('No acting party in session'),
          403: errorResponse('Not a member of this project'),
          404: errorResponse('Project not found'),
        },
      },
    },
    '/projects/{id}/invitations': {
      post: {
        operationId: 'inviteCounterparty',
        summary: 'Invite the one GC (counterparty). Owner only (FR1).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, content: json('InviteRequest') },
        responses: {
          201: { description: 'Invitation minted; raw token returned once', content: json('InvitationCreated') },
          400: errorResponse('Unsupported role'),
          401: errorResponse('No acting party in session'),
          403: errorResponse('Only the owner may invite'),
          404: errorResponse('Project not found'),
          409: errorResponse('A counterparty or pending invite already exists'),
        },
      },
    },
    '/invitations/{token}/accept': {
      post: {
        operationId: 'acceptInvitation',
        summary: 'The invited GC accepts and joins as counterparty.',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Joined; membership created', content: json('MembershipCreated') },
          400: errorResponse('Missing token'),
          401: errorResponse('No acting party in session'),
          404: errorResponse('Invitation not found'),
          409: errorResponse('Invitation already accepted, or already a member'),
        },
      },
    },
  },
  components: { schemas },
};

// ── Minimal YAML emitter (sufficient for this spec: nested maps, arrays, scalars).
// Deterministic key order = object insertion order, so the rendered file is stable.
export function toYaml(value) {
  const lines = [];
  emit(value, 0, lines);
  return lines.join('\n') + '\n';
}

function emit(value, indent, lines) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) { lines[lines.length - 1] += ' []'; return; }
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${scalar(item)}`);
      } else {
        // Emit the object one level deeper, then fold the first line onto the dash.
        const start = lines.length;
        emit(item, indent + 1, lines);
        lines[start] = `${pad}- ${lines[start].slice((indent + 1) * 2)}`;
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const key = keyText(k);
    if (isScalar(v)) {
      lines.push(`${pad}${key}: ${scalar(v)}`);
    } else if (Array.isArray(v) && v.length === 0) {
      lines.push(`${pad}${key}: []`);
    } else {
      lines.push(`${pad}${key}:`);
      emit(v, indent + 1, lines);
    }
  }
}

const isScalar = (v) => v === null || typeof v !== 'object';
function keyText(k) {
  // OpenAPI keys include '/paths', '200', '$ref', '{id}' — quote when not a plain word.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `'${k.replace(/'/g, "''")}'`;
}
function scalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote strings that YAML could misread (empty, special chars, leading symbols).
  if (s === '' || /[:#\-?*&!|>'"%@`{}\[\],]/.test(s) || /^\s|\s$/.test(s) || /^\d/.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}
