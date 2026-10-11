'use client';

// The issuer's tender at its own address (PRD-08 H-2, H-3, H-5): the SAME
// TenderWorkspace the plan's in-place overlay mounts (components/tender/*, the
// PRD-02 step components) — no second implementation. What this wrapper adds is
// only the routing: Overview and Proposals are links to their own URLs, "All
// tenders" goes to the home, and a new RFP lands on its own URL once saved.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { TenderWorkspace } from '@/components/tender/TenderWorkspace';
import type { WorkspaceSection } from '@/components/tender/TenderPanel';
import type { TaskOption } from '@/components/tender/types';
import { proposalsPath, rfpPath, tenderingPath } from '@/lib/v2/tendering-home-view';
import type { RfpMode, V2Rfp } from '@/lib/v2/tendering-view';

export function RfpWorkspaceRoute({
  projectId, rfp, tasks, initialSection = 'overview', initialCompare = null,
  initialMode = 'detailed', seedTaskId = null, openQuestions = 0,
}: {
  projectId: string;
  /** The tender, or null on /rfps/new. */
  rfp: V2Rfp | null;
  tasks: TaskOption[];
  initialSection?: WorkspaceSection;
  initialCompare?: string | null;
  initialMode?: RfpMode;
  seedTaskId?: string | null;
  openQuestions?: number;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<V2Rfp | null>(rfp);
  const todayIso = useRef(new Date().toISOString().slice(0, 10)).current;

  return (
    <TenderWorkspace
      key={current?.id ?? 'new'}
      projectId={projectId}
      rfp={current}
      seedTaskId={current ? null : seedTaskId}
      tasks={tasks}
      initialSection={initialSection}
      initialCompare={initialCompare}
      initialMode={initialMode}
      todayIso={todayIso}
      openQuestions={openQuestions}
      // Only the OTHER route's section is a link; this route's sections switch in place.
      sectionHref={!current ? {} : initialSection === 'proposals'
        ? { overview: rfpPath(projectId, current.id) }
        : { proposals: proposalsPath(projectId, current.id) }}
      onRfpChanged={(next) => {
        // A new RFP's first save gives it an address: move there (H-5).
        if (!current) router.replace(rfpPath(projectId, next.id));
        setCurrent(next);
      }}
      onBack={() => router.push(tenderingPath(projectId))}
    />
  );
}
