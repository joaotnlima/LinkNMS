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

// Band B (ADR-0011): membership/invitation roles widen with migration 0009 and
// the Project shape gains the draft/operating-model fields the wizard drives.
const roleEnum = { type: 'string', enum: ['owner', 'counterparty', 'subcontractor'] };
const roleEnumVisible = { type: 'string', enum: ['counterparty', 'subcontractor'] };
const partyRoleEnum = { type: 'string', enum: ['owner', 'contractor', 'viewer'] };
// The three Band B operating models; null is the "not chosen yet" state (ADR-0011).
const operatingModelEnum = { type: ['string', 'null'], enum: [null, 'turnkey', 'direct', 'hybrid'] };
const projectStatusEnum = { type: 'string', enum: ['draft', 'active'] };

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
            enum: ['unauthenticated', 'forbidden', 'not_found', 'conflict', 'bad_request', 'rate_limited'],
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
      // null until first-login setup has been done — "never asked" is a
      // different fact from a chosen language, and the portal needs both.
      language: { type: ['string', 'null'], enum: ['en', 'pt', 'es', null] },
      setupComplete: { type: 'boolean' },
    },
  },
  // ── Account setup (LINA-189) ─────────────────────────────────────────────
  // The setup screen's vocabulary, NOT the record's: `general_contractor` here
  // is stored as party role `contractor`. The two are translated at the service
  // boundary so neither side has to know the other's spelling.
  CompleteProfileRequest: {
    type: 'object',
    required: ['displayName', 'role', 'language'],
    properties: {
      displayName: { type: 'string' },
      // A CHOICE, not an entitlement: it sets the label on the party and grants
      // access to nothing. Build access is membership (ADR-0004).
      role: { type: 'string', enum: ['owner', 'general_contractor'] },
      language: { type: 'string', enum: ['en', 'pt', 'es'] },
    },
  },
  CompletedProfile: {
    type: 'object',
    required: ['profile'],
    properties: {
      profile: {
        type: 'object',
        required: ['displayName', 'role', 'language', 'setupComplete'],
        properties: {
          displayName: { type: 'string' },
          role: { type: 'string', enum: ['owner', 'general_contractor'] },
          language: { type: 'string', enum: ['en', 'pt', 'es'] },
          setupComplete: { type: 'boolean' },
        },
      },
    },
  },
  Member: {
    type: 'object',
    required: ['partyId', 'role', 'joinedAt'],
    properties: { partyId: { type: 'string' }, role: roleEnum, joinedAt: { type: 'string' } },
  },
  // GET /projects — the portfolio card (ADR-0012 §A1), a projection, not the
  // full Project payload. `role` is the acting party's role on the build,
  // derived server-side; `updatedAt` is the record's most recent ledger
  // activity; `counts` are the cheap server-batched folds.
  ProjectSummary: {
    type: 'object',
    required: [
      'id', 'name', 'status', 'role', 'operatingModel',
      'baselineBudgetCents', 'currentBudgetCents', 'members', 'counts', 'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      status: projectStatusEnum,
      role: roleEnum,
      operatingModel: operatingModelEnum,
      baselineBudgetCents: { type: 'integer' },
      currentBudgetCents: { type: 'integer' },
      members: {
        type: 'array',
        items: {
          type: 'object',
          required: ['role', 'name'],
          properties: {
            role: roleEnum,
            name: { type: ['string', 'null'] },
          },
        },
      },
      counts: {
        type: 'object',
        required: ['changeOrders', 'decisions'],
        properties: {
          changeOrders: { type: 'integer', minimum: 0 },
          decisions: { type: 'integer', minimum: 0 },
        },
      },
      // ISO-8601; the ledger head's occurredAt (most recent record activity).
      updatedAt: { type: 'string' },
    },
  },
  ProjectList: {
    type: 'object',
    required: ['projects'],
    properties: {
      projects: { type: 'array', items: { $ref: '#/components/schemas/ProjectSummary' } },
    },
  },
  Project: {
    type: 'object',
    required: [
      'id', 'name', 'ownerPartyId', 'baselineBudgetCents', 'currentBudgetCents',
      'operatingModel', 'status', 'actingRole', 'createdAt', 'members',
    ],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      ownerPartyId: { type: 'string' },
      baselineBudgetCents: { type: 'integer' },
      currentBudgetCents: { type: 'integer' },
      operatingModel: operatingModelEnum,
      status: projectStatusEnum,
      // Basics descriptive fields (LINA-219): null on legacy rows and drafts
      // that skipped them, set once at genesis otherwise. Nullable, not required.
      siteAddress: { type: ['string', 'null'] },
      buildType: { type: ['string', 'null'] },
      expectedStart: { type: ['string', 'null'] },
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
  // GET /invitations/:token — the unauthenticated preview behind the Band B
  // accept deep link (LINA-182). The token IS the credential (ADR-0004 in
  // reverse: here the caller is the invitee who has not signed up yet), so the
  // shape deliberately carries no actor and no membership. It is the ONLY
  // unauthenticated read of a token-keyed row and is rate-limited at the
  // transport layer; unknown and spent tokens return the same 404 (no oracle).
  InvitationPreview: {
    type: 'object',
    required: ['projectName', 'invitedByName', 'role', 'email', 'status'],
    properties: {
      projectName: { type: ['string', 'null'] },
      invitedByName: { type: ['string', 'null'] },
      role: roleEnumVisible,
      email: {
        type: ['string', 'null'],
        description: 'The address the invitation was mailed to; null on the out-of-band path. Returned because it is the INVITEE’s own address (pre-fill), not a third party’s.',
      },
      status: { type: 'string', enum: ['pending'] },
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
      // Band B (ADR-0011): true selects the wizard step-1 path — the build row is
      // created `status='draft'` with `operatingModel=null`. Absent/false keeps
      // the legacy one-shot path: an immediately `active` project, unchanged.
      draft: { type: 'boolean', default: false, description: 'Create the build as a draft (Band B wizard step 1).' },
      // Basics descriptive fields (LINA-219). Optional; the service trims, caps at
      // 300 chars, and stores null for blanks. `expectedStart` is a "YYYY-MM"
      // month string from the picker, kept as free text (no DB CHECK).
      siteAddress: { type: 'string', description: 'Site address (Basics).' },
      buildType: { type: 'string', description: 'Build type slug (Basics).' },
      expectedStart: { type: 'string', description: 'Expected start month, YYYY-MM (Basics).' },
    },
  },
  InviteRequest: {
    type: 'object',
    properties: {
      // The launch vocabulary (0009): a build invites the role(s) its operating
      // model admits — turnkey → counterparty, direct → subcontractor, hybrid →
      // both. `subcontractor` is only accepted when the model allows it (service-
      // enforced); the enum here mirrors the DB CHECK.
      role: roleEnumVisible,
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
  SetOperatingModelRequest: {
    type: 'object',
    required: ['operatingModel'],
    properties: {
      operatingModel: { type: 'string', enum: ['turnkey', 'direct', 'hybrid'] },
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
    '/me/profile': {
      post: {
        operationId: 'completeProfile',
        summary: 'First-login account setup: display name, role choice, language. Once only.',
        description:
          'Self-only — the party is the session’s and cannot be named in the body (ADR-0004). '
          + 'The role is a CHOICE recorded on the party, not a grant: access to any build is '
          + 'membership, minted only by creating a project or accepting an invitation. '
          + 'Idempotent: a repeat submit is 409 and the client treats it as success.',
        requestBody: { required: true, content: json('CompleteProfileRequest') },
        responses: {
          200: { description: 'Profile stored', content: json('CompletedProfile') },
          400: errorResponse('Invalid field; the body names the offending field'),
          401: errorResponse('No acting party in session'),
          409: errorResponse('Profile already set up'),
        },
      },
    },
    '/projects': {
      get: {
        operationId: 'listProjects',
        summary: 'The acting party’s own portfolio: every build they are a member of, most-recent-first (ADR-0012 §A1).',
        description:
          'Membership-scoped to the session — the party is NEVER a body/query param, and an ' +
          'acting party can only ever list their own builds. Drafts are included (badged ' +
          '`draft`) so an abandoned wizard is resumable. Budgets are ledger-authoritative ' +
          '(baseline + Σ approved change orders); per-card counts are batched server-side.',
        responses: {
          200: {
            description: 'The party’s projects, ordered most-recent-first',
            content: json('ProjectList'),
          },
          401: errorResponse('No acting party in session'),
        },
      },
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
    '/projects/{id}/operating-model': {
      patch: {
        operationId: 'setOperatingModel',
        summary: 'Choose the operating model on a draft (Band B wizard step 2). Owner only.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: json('SetOperatingModelRequest') },
        responses: {
          200: { description: 'Operating model set; updated project view', content: json('Project') },
          400: errorResponse('Unsupported operating model'),
          401: errorResponse('No acting party in session'),
          403: errorResponse('Only the owner may set the operating model'),
          404: errorResponse('Project not found'),
          409: errorResponse('The project is not a draft'),
        },
      },
    },
    '/projects/{id}/invitations': {
      post: {
        operationId: 'inviteCounterparty',
        summary: 'Invite the role the build’s operating model admits (Band B). Owner only (FR1).',
        description:
          'Turnkey invites counterparty, direct invites subcontractor, hybrid invites either. ' +
          'The first invite on a draft commits the build (draft→active).',
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
    '/invitations/{token}': {
      get: {
        operationId: 'previewInvitation',
        summary: 'The unauthenticated invite preview behind the Band B accept deep link (LINA-182).',
        description:
          'Returned to a signed-out visitor who holds only the token: which build they were ' +
          'invited to, who invited them, and the email the invitation was mailed to (for the ' +
          'inline sign-up pre-fill). The token is the credential for this read. Unknown and ' +
          'already-accepted tokens return the IDENTICAL 404, so the endpoint is not a ' +
          'token-validity oracle. Rate-limited at the transport layer.',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Invitation preview', content: json('InvitationPreview') },
          400: errorResponse('Missing token'),
          404: errorResponse('Unknown or already-accepted invitation — deliberately indistinguishable'),
          429: errorResponse('Rate limit exceeded'),
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
