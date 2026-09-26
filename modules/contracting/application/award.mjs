// The award port (phase 6) — the CONTRACTING side of `awardRfp`.
//
// Doc 02's context map draws "Tendering → award → creates contract". The
// contract draft must exist the instant the RFP says `awarded` (the 201
// answers with it), so this write happens ON THE AWARD TRANSACTION: tendering
// passes its open client here, and this module writes its own tables —
// contract, contract_root, boq_item — plus the contract-scoped ledger entry
// and `contracting.contract.created`, exactly as direct entry does. One
// writer per fact still holds: only contracting code touches contracting.*.
//
// What is copied at award (doc 06 §Award):
//   platform lane — the priced lines become the contract BoQ (task binding
//     via the packaged item; variant/new-row lines are contract-level,
//     task_id NULL until the plan copy at signature);
//   email lane — no lines; value stays 0 until formalised (the baseline is
//     taken from what exists at signature; plan health flags the gap).
// The winner's PLAN enters planning only at signature (D-36), not here.
import { randomUUID } from 'node:crypto';

import { appendAuditEvent } from '../../../platform/ledger.mjs';
import { publishEvent } from '../../../platform/outbox.mjs';

/**
 * Create the draft contract for an awarded proposal, on the caller's client.
 *
 * @param client  pg client already inside the award BEGIN…COMMIT
 * @param {{ rfp: object, winner: object, actor: object }} cmd
 *   rfp    — tendering.rfp row (with root_task_ids)
 *   winner — tendering.proposal row of the awarded lane
 * @returns {{ contract, client: org, supplier: org, roots, valueCents }}
 */
export async function createContractFromAward(client, { rfp, winner, actor }) {
  const contractId = randomUUID();
  const kind = await deriveKind(client, rfp);
  const reference = `CTR-${contractId.slice(0, 8).toUpperCase()}`;

  await client.query(
    `INSERT INTO contracting.contract
       (id, project_id, kind, parent_contract_id, client_org_id, supplier_org_id,
        reference, specialties, origin, origin_proposal_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'award',$9)`,
    [contractId, rfp.project_id, kind, kind === 'sub' ? rfp.parent_contract_id : null,
      rfp.issuer_org_id, winner.bidder_org_id, reference, rfp.specialties ?? [], winner.id],
  );
  for (const taskId of rfp.root_task_ids) {
    await client.query(
      'INSERT INTO contracting.contract_root (contract_id, task_id) VALUES ($1, $2)',
      [contractId, taskId],
    );
  }

  // The winning lane's priced lines become the contract BoQ (D-09).
  let valueCents = 0;
  if (winner.channel === 'platform') {
    const { rows: lines } = await client.query(
      `SELECT pl.*, ri.code AS item_code, ri.task_id AS item_task_id,
              ri.specialty AS item_specialty
         FROM tendering.proposal_line pl
         LEFT JOIN tendering.rfp_item ri ON ri.id = pl.rfp_item_id
        WHERE pl.proposal_id = $1
        ORDER BY pl.id`,
      [winner.id],
    );
    let variantSeq = 0;
    for (const line of lines) {
      const code = line.item_code ?? `VAR-${String(++variantSeq).padStart(3, '0')}`;
      await client.query(
        `INSERT INTO contracting.boq_item
           (id, project_id, contract_id, task_id, code, description, unit,
            quantity, unit_price_cents, material_spec, specialty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), rfp.project_id, contractId, line.item_task_id ?? null,
          code, line.description, line.unit, line.quantity, line.unit_price_cents,
          line.material_spec, line.item_specialty],
      );
      valueCents += Math.round(Number(line.quantity) * Number(line.unit_price_cents));
    }
    await client.query(
      'UPDATE contracting.contract SET value_cents = $2 WHERE id = $1',
      [contractId, valueCents],
    );
  } else if (winner.summary_total_cents != null) {
    // Emailed answer: the issuer-typed total is the contract value until the
    // BoQ is formalised; there are no lines to measure against yet.
    valueCents = Number(winner.summary_total_cents);
    await client.query(
      'UPDATE contracting.contract SET value_cents = $2 WHERE id = $1',
      [contractId, valueCents],
    );
  }

  await appendAuditEvent(client, {
    projectId: rfp.project_id,
    actor,
    category: 'contracting',
    type: 'contracting.contract.created',
    scope: { type: 'contract', id: contractId },
    object: { type: 'contract', id: contractId },
    payload: {
      kind, reference,
      client_org_id: rfp.issuer_org_id, supplier_org_id: winner.bidder_org_id,
      parent_contract_id: kind === 'sub' ? rfp.parent_contract_id : null,
      root_task_ids: rfp.root_task_ids,
      origin: 'award', origin_proposal_id: winner.id, rfp_id: rfp.id,
    },
    channel: actor.channel,
  });
  await publishEvent(client, {
    event_id: randomUUID(),
    type: 'contracting.contract.created',
    project_id: rfp.project_id,
    actor: { person_id: actor.personId, org_id: actor.orgId },
    scope: { type: 'contract', id: contractId },
    data: { kind, client_org_id: rfp.issuer_org_id, supplier_org_id: winner.bidder_org_id },
  });

  const { rows: [contract] } = await client.query(
    'SELECT * FROM contracting.contract WHERE id = $1', [contractId],
  );
  const { rows: orgs } = await client.query(
    'SELECT * FROM identity.organization WHERE id = ANY($1::uuid[])',
    [[rfp.issuer_org_id, winner.bidder_org_id]],
  );
  return {
    contract,
    client: orgs.find((o) => o.id === rfp.issuer_org_id) ?? { id: rfp.issuer_org_id },
    supplier: orgs.find((o) => o.id === winner.bidder_org_id) ?? { id: winner.bidder_org_id },
    roots: rfp.root_task_ids,
    valueCents,
  };
}

/**
 * D-35: the shape follows from the tree. A sub-level RFP awards a sub
 * contract. At owner level: a package spanning MORE THAN ONE specialty is a
 * prime (the winner coordinates trades inside it — turnkey side); a single
 * specialty package is a direct contract. Default applied, flagged in the
 * phase-6 report — the docs never spell the discriminator out.
 */
async function deriveKind(client, rfp) {
  if (rfp.level === 'sub') return 'sub';
  const { rows } = await client.query(
    `SELECT count(DISTINCT specialty) AS n
       FROM tendering.rfp_package_row
      WHERE rfp_id = $1 AND package_version = $2 AND specialty IS NOT NULL`,
    [rfp.id, rfp.package_version],
  );
  return Number(rows[0]?.n ?? 0) > 1 ? 'prime' : 'direct';
}
