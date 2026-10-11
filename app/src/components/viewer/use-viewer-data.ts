'use client';

// The viewer's reads (PRD-06), one hook each, all through the server actions of
// `lib/v2/viewer-actions.ts`: the markups of the open file, the inline URL of a
// PDF version (and of the overlay base, V-7), the DWG/DXF preview of a version
// (polled while "Making preview…", V-11), and the parties a question can go to.
import { useEffect, useState } from 'react';

import {
  loadMarkupsAction, viewUrlAction, previewAction, questionPartiesAction,
} from '@/lib/v2/viewer-actions';
import type { MarkupView, V2Preview } from '@/lib/v2/viewer-view';

export function useMarkups(documentId: string | null, tick: number) {
  const [markups, setMarkups] = useState<MarkupView[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMarkups([]); setError(null);
    if (!documentId) return undefined;
    loadMarkupsAction(documentId)
      .then((r) => { if (live) { if (r.ok) setMarkups(r.value); else setError(r.message); } })
      .catch(() => { if (live) setError('The markups could not be loaded.'); });
    return () => { live = false; };
  }, [documentId, tick]);
  return { markups, setMarkups, error };
}

/** A short-lived inline URL for one version (null ref → nothing). */
export function useViewUrl(versionRef: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null); setError(null);
    if (!versionRef) return undefined;
    viewUrlAction(versionRef)
      .then((r) => { if (live) { if (r.ok) setUrl(r.value); else setError(r.message); } })
      .catch(() => { if (live) setError('This file could not be opened.'); });
    return () => { live = false; };
  }, [versionRef]);
  return { url, error };
}

const POLL_MS = 5000;
const POLL_MAX = 24; // two minutes of "Making preview…", then the user can reopen

export function usePreview(versionRef: string | null) {
  const [preview, setPreview] = useState<V2Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setPreview(null); setError(null);
    if (!versionRef) return undefined;
    const load = (attempt: number) => {
      previewAction(versionRef)
        .then((r) => {
          if (!live) return;
          if (!r.ok) { setError(r.message); return; }
          setPreview(r.value);
          if (r.value.status === 'pending' && attempt < POLL_MAX) timer = setTimeout(() => load(attempt + 1), POLL_MS);
        })
        .catch(() => { if (live) setError('The preview could not be loaded.'); });
    };
    load(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [versionRef]);
  return { preview, error };
}

export function useQuestionParties(projectId: string) {
  const [parties, setParties] = useState<Array<{ orgId: string; name: string }>>([]);
  useEffect(() => {
    let live = true;
    questionPartiesAction(projectId).then((r) => { if (live && r.ok) setParties(r.value); }).catch(() => {});
    return () => { live = false; };
  }, [projectId]);
  return parties;
}
