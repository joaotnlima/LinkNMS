// Questions and minutes on `/api/v2` (PRD-12 N-5..N-7). I/O only; naming lives
// in `./questions-view.ts`. Reads fail closed (an empty list); writes rethrow
// so the action can say why.
import 'server-only';

import { v2, V2Error } from './client';
import type { QuestionTopic, V2Minute, V2Question } from './questions-view';

const enc = encodeURIComponent;

async function itemsOrEmpty<T>(p: Promise<{ items: T[] }>): Promise<T[]> {
  try {
    return (await p).items ?? [];
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

export function listProjectQuestionsV2(projectId: string, role: 'addressed' | 'asked' | 'all', topic?: QuestionTopic): Promise<V2Question[]> {
  return itemsOrEmpty(v2<{ items: V2Question[] }>({
    method: 'GET', path: `/projects/${enc(projectId)}/questions`, query: { role, topic, limit: 200 },
  }));
}

/** Questions for me — addressed to my organisation on every build (N-7). */
export function listMyQuestionsV2(opts: { status?: string; topic?: QuestionTopic } = {}): Promise<V2Question[]> {
  return itemsOrEmpty(v2<{ items: V2Question[] }>({
    method: 'GET', path: '/me/questions', query: { status: opts.status ?? 'open', topic: opts.topic, limit: 200 },
  }));
}

export function listMinutesV2(projectId: string): Promise<V2Minute[]> {
  return itemsOrEmpty(v2<{ items: V2Minute[] }>({ method: 'GET', path: `/projects/${enc(projectId)}/minutes`, query: { limit: 100 } }));
}

export function askQuestionV2(objectType: string, objectId: string, body: Record<string, unknown>): Promise<V2Question> {
  return v2<V2Question>({ method: 'POST', path: `/threads/${enc(objectType)}/${enc(objectId)}/comments`, body });
}

export function answerQuestionV2(questionId: string, body: Record<string, unknown>): Promise<V2Question> {
  return v2<V2Question>({ method: 'POST', path: `/comments/${enc(questionId)}:answer`, body });
}

export function resolveQuestionV2(questionId: string): Promise<V2Question> {
  return v2<V2Question>({ method: 'POST', path: `/comments/${enc(questionId)}:resolve` });
}

export function createMinuteV2(projectId: string, body: Record<string, unknown>): Promise<V2Minute> {
  return v2<V2Minute>({ method: 'POST', path: `/projects/${enc(projectId)}/minutes`, body });
}

export function moveMinuteV2(minuteId: string, action: 'circulate' | 'acknowledge'): Promise<V2Minute> {
  return v2<V2Minute>({ method: 'POST', path: `/minutes/${enc(minuteId)}:${action}` });
}
