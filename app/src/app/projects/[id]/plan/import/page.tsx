// `/plan/import` is retired as a route (LINA-281, ADR-0023 §4). There is no
// import wizard in the app any more — nothing imports one, and `/plan` reads no
// `?compose=` flag — so this shell only redirects an old link or bookmark to the
// plan itself (PRD-01 C-1/C-2). Spreadsheet import returns with PRD-09.
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PlanImportRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${id}/plan`);
}
