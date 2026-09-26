// Clerk webhook payload → mirror command, pure (to-be doc 16 §3, §8).
//
// The mirror (identity.person / organization / org_membership) exists for
// attribution and the ledger only — it never decides a permission. This file
// translates each Clerk event into ONE explicit command the application layer
// executes; everything Clerk-shaped is unpacked here so the rest of the module
// never sees a webhook envelope.
//
// Commands: {kind: 'upsert_person'|'upsert_organization'|'upsert_membership'
//            |'remove_membership'|'guard_org_delete'|'ignore', ...fields}

const MEMBERSHIP_ROLES = new Set([
  'admin', 'manager', 'representative', 'site_lead', 'finance', 'member', 'inspector',
]);
const ORG_KINDS = new Set(['household', 'contractor', 'consultant', 'supplier']);

/** @param {{type: string, data: Record<string, any>}} event Clerk webhook body */
export function commandFor(event) {
  const { type, data } = event ?? {};
  if (!type || !data) return { kind: 'ignore', reason: 'no type/data' };

  switch (type) {
    case 'user.created':
    case 'user.updated': {
      const email = primaryEmail(data);
      if (!email) return { kind: 'ignore', reason: 'user has no primary email yet' };
      return {
        kind: 'upsert_person',
        clerkUserId: data.id,
        email: email.toLowerCase(),
        name: fullName(data),
        phone: primaryPhone(data),
        platformRole: data.public_metadata?.platform_role ?? null,
      };
    }
    case 'user.deleted':
      // Attribution outlives the account (doc 16 §8: past actions stay in the
      // ledger). The person row stays; their org memberships are removed by
      // the organizationMembership.deleted events Clerk sends alongside.
      return { kind: 'ignore', reason: 'person rows are kept for attribution' };

    case 'organization.created':
    case 'organization.updated': {
      const kind = data.public_metadata?.kind;
      if (!ORG_KINDS.has(kind)) {
        // An org born outside createOrganization (dashboard, script) without a
        // kind cannot be mirrored — kind decides the role set and visibility.
        return { kind: 'reject', reason: `organization ${data.id} has no valid public_metadata.kind` };
      }
      return {
        kind: 'upsert_organization',
        clerkOrgId: data.id,
        orgKind: kind,
        legalName: data.name,
        nif: data.public_metadata?.nif ?? null,
        approvalPolicy: data.public_metadata?.approval_policy === 'all' ? 'all' : 'any',
      };
    }
    case 'organization.deleted':
      // Doc 16 §8: deleting an org that is party to a signed contract is
      // blocked — the record cannot lose a party. The application layer asks
      // contracting; here we only name the guard.
      return { kind: 'guard_org_delete', clerkOrgId: data.id };

    case 'organizationMembership.created':
    case 'organizationMembership.updated': {
      const role = bareRole(data.role);
      if (!MEMBERSHIP_ROLES.has(role)) {
        return { kind: 'reject', reason: `membership role ${data.role} is not in the doc-16 §4 catalogue` };
      }
      return {
        kind: 'upsert_membership',
        clerkOrgId: data.organization?.id,
        clerkUserId: data.public_user_data?.user_id,
        orgRole: role,
      };
    }
    case 'organizationMembership.deleted':
      return {
        kind: 'remove_membership',
        clerkOrgId: data.organization?.id,
        clerkUserId: data.public_user_data?.user_id,
      };

    default:
      return { kind: 'ignore', reason: `unhandled event type ${type}` };
  }
}

function primaryEmail(data) {
  const id = data.primary_email_address_id;
  const all = data.email_addresses ?? [];
  return (all.find((e) => e.id === id) ?? all[0])?.email_address ?? null;
}

function primaryPhone(data) {
  const id = data.primary_phone_number_id;
  const all = data.phone_numbers ?? [];
  return (all.find((p) => p.id === id) ?? all[0])?.phone_number ?? null;
}

function fullName(data) {
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ').trim();
  return name || primaryEmail(data) || data.id;
}

/** Clerk spells roles `org:admin`; the mirror stores the bare key (doc 16 §4). */
function bareRole(role) {
  return typeof role === 'string' ? role.replace(/^org:/, '') : '';
}
