// Pure v2-wire → view transforms for `/projects/{id}/questions` and
// `/questions` (PRD-12 N-5..N-7; flows C16–C17). Who may answer, resolve,
// circulate or acknowledge is the server's answer (`actions`); a scope gap's
// addressee is the server's too (always the owner). This names things and
// validates the forms before the round trip.

export type QuestionTopic = 'clarification' | 'design_change' | 'scope_gap';
export type QuestionStatus = 'open' | 'answered' | 'resolved';

export interface V2Question {
  id: string;
  object_type: string;
  object_id: string;
  kind: 'note' | 'question' | 'answer';
  body: string;
  author: { person_id?: string; org_id: string };
  addressee_org_id?: string;
  question_status?: QuestionStatus;
  created_at: string;
  deleted: boolean;
  project_id?: string;
  topic?: QuestionTopic;
  decision?: 'approved' | 'rejected';
  actions?: Array<'answer' | 'resolve'>;
}

export interface V2Minute {
  id: string;
  project_id?: string;
  created_by_org_id?: string;
  date: string;
  attendees: string[];
  items: Array<{ text: string; owner_org_id?: string; due_date?: string }>;
  status: 'draft' | 'circulated' | 'acknowledged';
  acks: Array<{ org_id: string; person_id?: string; at: string }>;
  actions?: Array<'circulate' | 'acknowledge'>;
}

export const TOPIC_LABEL: Record<QuestionTopic, string> = {
  clarification: 'Clarification',
  design_change: 'Design change',
  scope_gap: 'Scope gap',
};

export const STATUS_LABEL: Record<QuestionStatus, string> = {
  open: 'Waiting for an answer',
  answered: 'Answered — the asker can resolve it',
  resolved: 'Resolved',
};

export const QUESTION_TABS = [
  { value: 'addressed', label: 'For us' },
  { value: 'asked', label: 'We asked' },
  { value: 'minutes', label: 'Meeting minutes' },
] as const;

export interface QuestionCard {
  id: string;
  body: string;
  topic: QuestionTopic;
  topicLabel: string;
  statusLabel: string;
  from: string;
  to: string;
  on: string;
  decision: 'approved' | 'rejected' | null;
  askedOn: string;
  actions: Array<'answer' | 'resolve'>;
  needsDecision: boolean;
  href: string | null;
}

export function questionCard(
  q: V2Question, orgs: Map<string, string>, opts: { tasks?: Map<string, string>; builds?: Map<string, string> } = {},
): QuestionCard {
  const topic = q.topic ?? 'clarification';
  const onTask = q.object_type === 'task' ? opts.tasks?.get(q.object_id) : null;
  const build = q.project_id ? opts.builds?.get(q.project_id) : null;
  return {
    id: q.id,
    body: q.body,
    topic,
    topicLabel: TOPIC_LABEL[topic],
    statusLabel: q.question_status ? STATUS_LABEL[q.question_status] : '',
    from: orgs.get(q.author.org_id) ?? 'An organisation on the build',
    to: q.addressee_org_id ? (orgs.get(q.addressee_org_id) ?? (topic === 'scope_gap' ? 'The owner' : 'An organisation on the build')) : '',
    on: onTask ? `Task: ${onTask}` : build ?? (q.object_type === 'project' ? 'The build' : q.object_type.replace('_', ' ')),
    decision: q.decision ?? null,
    askedOn: (q.created_at ?? '').slice(0, 10),
    actions: q.actions ?? [],
    needsDecision: topic === 'design_change',
    href: q.project_id ? `/projects/${encodeURIComponent(q.project_id)}/questions?q=${encodeURIComponent(q.id)}` : null,
  };
}

export interface AskForm { topic: string; body: string; addresseeOrgId: string; taskId: string }

/** The createComment body for a question, or the first thing to fix. */
export function askBody(form: AskForm, id: string): { ok: true; body: Record<string, unknown>; objectType: string; objectId: string | null }
  | { ok: false; message: string } {
  const body = form.body.trim();
  if (!body) return { ok: false, message: 'Write the question.' };
  if (body.length > 8000) return { ok: false, message: 'Keep it under 8000 characters.' };
  if (!(form.topic in TOPIC_LABEL)) return { ok: false, message: 'Pick what kind of question it is.' };
  if (form.topic !== 'scope_gap' && !form.addresseeOrgId) return { ok: false, message: 'Pick who should answer.' };
  return {
    ok: true,
    objectType: form.taskId ? 'task' : 'project',
    objectId: form.taskId || null,
    body: {
      id, kind: 'question', body, topic: form.topic,
      // A scope gap goes to the owner — the server routes it.
      ...(form.topic !== 'scope_gap' ? { addressee_org_id: form.addresseeOrgId } : {}),
    },
  };
}

export interface MinuteForm { date: string; attendees: string[]; items: string }

/** One line per minute item; "Org name: text" is not parsed — owners are picked later. */
export function minuteBody(form: MinuteForm, id: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) return { ok: false, message: 'Pick the meeting date.' };
  if (!form.attendees.length) return { ok: false, message: 'Tick the organisations that attended.' };
  const items = form.items.split('\n').map((l) => l.trim()).filter(Boolean).map((text) => ({ text }));
  return { ok: true, body: { id, date: form.date, attendees: form.attendees, items } };
}

export interface MinuteCard {
  id: string;
  date: string;
  status: V2Minute['status'];
  statusLabel: string;
  items: string[];
  acked: string[];
  waiting: string[];
  actions: Array<'circulate' | 'acknowledge'>;
}

export function minuteCard(m: V2Minute, orgs: Map<string, string>): MinuteCard {
  const name = (o: string) => orgs.get(o) ?? 'An organisation';
  const ackedIds = new Set(m.acks.map((a) => a.org_id));
  return {
    id: m.id,
    date: m.date,
    status: m.status,
    statusLabel: m.status === 'draft' ? 'Draft — only your organisation sees it'
      : m.status === 'circulated' ? 'Circulated — waiting for acknowledgements' : 'Acknowledged by everyone who attended',
    items: m.items.map((i) => i.text),
    acked: m.attendees.filter((o) => ackedIds.has(o)).map(name),
    waiting: m.status === 'draft' ? [] : m.attendees.filter((o) => !ackedIds.has(o)).map(name),
    actions: m.actions ?? [],
  };
}
