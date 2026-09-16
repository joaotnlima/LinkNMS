// The build's overview — for now, the plan (LINA-306 item 5).
//
// The founder's call: "overview page should only show the plan for now. we will
// iterate on more features going forward." So `/projects/:id` is a straight
// redirect onto the plan surface rather than its own screen. The four-pillar
// M14 record home (ADR-0015) that used to live here is preserved in git history
// at 92876fa — when the record has more to show, we restore it in place of this
// redirect instead of pointing a second nav item at the plan.
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function RecordHomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}`);
  redirect(`/projects/${id}/plan`);
}
