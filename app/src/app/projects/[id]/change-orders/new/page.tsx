// Raising a change order — RETIRED for the v2 cutover (LINA-354, S4 of doc 22 §3).
//
// v1 shipped a free-cost `RaiseChangeOrderForm` here: type a dollar amount, POST
// it to the v1 contract endpoint. v2 does not work that way — a change order's
// `amount_delta` is DERIVED server-side from BoQ line ops against a SIGNED
// contract, never free-typed (LINA-358 ruling 2). Proposing therefore needs the
// contract + BoQ authoring surface that arrives with S2; until then there is no
// honest way to raise one, and the free-cost form is retired.
//
// The list page (`../page.tsx`) already reads/decides on v2 and shows raising as
// a pending entry point. The top-bar "Log a change" action now points straight at
// that list (PortalShell), so this route is reached only by a stale bookmark or
// deep link — redirect it to the list rather than 404 or re-open the dead v1 form.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function RaiseChangeOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${id}/change-orders`);
}
