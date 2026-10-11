'use client';

// The shared model card in a task's Files tab (PRD-05 F-4 slot; PRD-07 M-4;
// board F1 TaskModel): "Project model · Shared · 38 elements linked to this
// task · v4", whether the viewer may edit those elements (author, owner or
// awarded — the server's M-8 answer), and a link that opens the model with this
// task isolated. One read (`getTaskModel`); nothing here decides a permission.
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { taskModelAction } from '@/lib/v2/model-actions';

type Card = Awaited<ReturnType<typeof taskModelAction>>;

export function TaskModelCard({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [card, setCard] = useState<Card | null>(null);
  useEffect(() => {
    let live = true;
    setCard(null);
    void taskModelAction(taskId).then((res) => { if (live) setCard(res); });
    return () => { live = false; };
  }, [taskId]);

  if (!card) return <div className="tfl-slot" data-slot="project-model">Project model…</div>;
  if (!card.ok) return <div className="tfl-slot" data-slot="project-model">{card.message}</div>;
  const m = card.value;
  if (!m) {
    return (
      <div className="tfl-slot" data-slot="project-model">
        Project model — this build has no IFC model yet. <Link href={`/projects/${projectId}/model`}>Put it on the record</Link>
      </div>
    );
  }
  const reason = m.can_edit
    ? (m.edit_reason === 'scope'
      ? `You can edit the ${m.element_count} linked element${m.element_count === 1 ? '' : 's'} (awarded task).`
      : 'You can edit the whole model’s links and issues.')
    : 'Read-only for you — edit opens for the company awarded this task.';
  return (
    <Link className="tfl-model" data-slot="project-model" href={`/projects/${projectId}/model?task=${encodeURIComponent(taskId)}`}>
      <span className="tfl-model-ic" aria-hidden="true">IFC</span>
      <span className="tfl-model-txt">
        <b>Project model</b> <span className="tfl-badge">Shared</span>
        <span className="tfl-note"> {m.element_count} element{m.element_count === 1 ? '' : 's'} linked to this task · v{m.current_version}</span>
        <span className="tfl-note">{reason} Opens filtered to this task.</span>
      </span>
    </Link>
  );
}
