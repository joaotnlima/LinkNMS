// Client-side PDF rendering (PRD-06 V-4, V-7) with pdf.js (pdfjs-dist,
// Apache-2.0). Loaded lazily — the library never enters the main bundle — and
// its worker is served from /pdfjs/ (copied by scripts/copy-pdf-worker.mjs).
// Client-only: never import from a server component.
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      return m;
    });
  }
  return lib;
}

export interface OpenPdf { doc: PDFDocumentProxy; close: () => void }

/** Open a PDF from a short-lived inline URL (XFA forms off). `close` ends the loading task and its worker. */
export async function openPdf(url: string): Promise<OpenPdf> {
  const m = await pdfjs();
  const task = m.getDocument({ url, enableXfa: false });
  const doc = await task.promise;
  return { doc, close: () => { void task.destroy(); } };
}

/** A page as displayed at scale 1 (PDF points, rotation applied) — the markup coordinate space. */
export interface PageSize { width: number; height: number }

/** Render one page into `canvas` at `scale` CSS pixels per PDF point, sharp on HiDPI screens. */
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, canvas: HTMLCanvasElement, scale: number): Promise<PageSize> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  await page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
  return { width: vp.width / scale, height: vp.height / scale };
}

/**
 * V-7 two-colour diff: ink only in the open version shows red, ink only in the
 * previous version shows blue, ink in both stays dark. Composited into `into`
 * from two canvases of the same size.
 */
export function compositeDiff(current: HTMLCanvasElement, previous: HTMLCanvasElement, into: HTMLCanvasElement) {
  const w = current.width; const h = current.height;
  into.width = w; into.height = h;
  into.style.width = current.style.width; into.style.height = current.style.height;
  const a = current.getContext('2d')?.getImageData(0, 0, w, h);
  const pc = document.createElement('canvas');
  pc.width = w; pc.height = h;
  pc.getContext('2d')?.drawImage(previous, 0, 0, w, h);
  const b = pc.getContext('2d')?.getImageData(0, 0, w, h);
  const ctx = into.getContext('2d');
  if (!a || !b || !ctx) return;
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < a.data.length; i += 4) {
    const inkA = 255 - (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3;
    const inkB = 255 - (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3;
    const both = Math.min(inkA, inkB);
    out.data[i] = 255 - inkB + both * 0.15; // red channel stays where only the open version has ink
    out.data[i + 1] = 255 - Math.max(inkA, inkB);
    out.data[i + 2] = 255 - inkA + both * 0.15; // blue stays where only the previous version has ink
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}
