// The build home's read (PRD-09 O-1): getProjectOverview, composed from the
// owning modules' PUBLISHED query ports — never their tables (doc 02 rules
// 2–3). Each port is optional: a missing one leaves its fields honestly
// absent/zero rather than invented.
//
//   planning     planFacts(projectId)          → plan, end_date, open_variations, health
//   contracting  costFor({viewer, projectId})  → cost (client side, D-38; money-gated)
//   quality      projectFacts(projectId)       → pending_verifications, open_nonconformities
//   questions    openQuestionCount(projectId)  → open_questions
import { requireParticipant, projectBody } from './use-cases.mjs';

/** operationId: getProjectOverview */
export async function getProjectOverview({ viewer, store, facts = {}, projectId }) {
  const { project } = await requireParticipant({ viewer, store, projectId });
  const [opModel, plan, cost, quality, openQuestions] = await Promise.all([
    store.getOperatingModel(projectId),
    facts.planning?.planFacts(projectId) ?? null,
    facts.contracting?.costFor({ viewer, projectId }) ?? null,
    facts.quality?.projectFacts(projectId) ?? null,
    facts.questions?.openQuestionCount(projectId) ?? 0,
  ]);
  const money = (cents) => ({ amount_cents: Number(cents), currency: 'EUR' });
  return {
    status: 200,
    body: {
      project: projectBody(project, opModel ?? 'undetermined'),
      plan: plan ? { rows: plan.rows, top_level: plan.top_level, start: plan.start } : { rows: 0, top_level: 0, start: null },
      ...(plan?.end_date?.current || plan?.end_date?.baseline ? { end_date: dropNulls(plan.end_date) } : {}),
      // Money is field-absent (invariant §6.5), never null.
      ...(cost ? { cost: { baseline: money(cost.baseline_cents), current: money(cost.current_cents) } } : {}),
      open_variations: Number(plan?.open_variations ?? 0),
      open_questions: Number(openQuestions ?? 0),
      pending_verifications: Number(quality?.pending_verifications ?? 0),
      open_nonconformities: quality?.open_nonconformities ?? { quality: 0, safety: 0 },
      ...(plan?.health ? { health: plan.health } : {}),
    },
  };
}

function dropNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
