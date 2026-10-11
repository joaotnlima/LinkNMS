'use server';

// The session-bound doors the questions page's client components reach the
// server-only data layer (`./questions.ts`) through (PRD-12 N-5, N-6). Every
// answer is a serializable `{ ok, … }`; a refusal carries the server's
// sentence. The server routes scope gaps and decides every transition.
import { revalidatePath } from 'next/cache';

import { V2Error } from './client';
import {
  answerQuestionV2, askQuestionV2, createMinuteV2, moveMinuteV2, resolveQuestionV2,
} from './questions';

export type QuestionsResult = { ok: true } | { ok: false; code: string; message: string };

async function run(paths: string[], fn: () => Promise<unknown>): Promise<QuestionsResult> {
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true };
  } catch (err) {
    if (err instanceof V2Error) {
      const field = err.errors ? Object.values(err.errors)[0] : null;
      return { ok: false, code: err.code, message: field ?? err.detail ?? err.message };
    }
    return { ok: false, code: 'internal', message: 'Something went wrong. Try again.' };
  }
}

const pathsOf = (projectId: string) => [`/projects/${projectId}/questions`, '/questions'];

export async function askQuestionAction(
  projectId: string, objectType: string, objectId: string | null, body: Record<string, unknown>,
): Promise<QuestionsResult> {
  return run(pathsOf(projectId), () => askQuestionV2(objectType, objectId ?? projectId, body));
}

export async function answerQuestionAction(
  projectId: string, questionId: string, input: { id: string; body: string; decision?: 'approved' | 'rejected' },
): Promise<QuestionsResult> {
  return run(pathsOf(projectId), () => answerQuestionV2(questionId, {
    id: input.id, body: input.body.trim(), ...(input.decision ? { decision: input.decision } : {}),
  }));
}

export async function resolveQuestionAction(projectId: string, questionId: string): Promise<QuestionsResult> {
  return run(pathsOf(projectId), () => resolveQuestionV2(questionId));
}

export async function createMinuteAction(projectId: string, body: Record<string, unknown>): Promise<QuestionsResult> {
  return run(pathsOf(projectId), () => createMinuteV2(projectId, body));
}

export async function moveMinuteAction(projectId: string, minuteId: string, action: 'circulate' | 'acknowledge'): Promise<QuestionsResult> {
  return run(pathsOf(projectId), () => moveMinuteV2(minuteId, action));
}
