'use client';

// Read-only IFC 3D viewer (LINA-409 / doc 24). A client island: web-ifc (WASM)
// + Three.js + OrbitControls, mounted in the three RFP surfaces (owner inbox,
// public token form, marketplace composer). It NEVER writes the model.
//
// Lazy by design: nothing is fetched or parsed until the bidder clicks "Load
// 3D model", so opening an RFP never pulls tens of MB, and the presigned URL is
// minted fresh (short TTL) at click time via `resolveUrl` (an authed server
// action, or the public token fetcher — the island is agnostic to which).
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { loadIfc, type LoadedIfc } from './ifc-loader';

/** What the parent must supply: a thunk that mints a fresh model byte-URL. */
export type ModelUrlResolve = { url: string } | { error: string };

export interface IfcViewerProps {
  resolveUrl: () => Promise<ModelUrlResolve>;
  fileName: string;
  sizeBytes: number;
}

const LARGE_MODEL_BYTES = 50 * 1024 * 1024;

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

export default function IfcViewer({ resolveUrl, fileName, sizeBytes }: IfcViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string>('');
  const [categories, setCategories] = useState<{ label: string; visible: boolean }[]>([]);
  const [measuring, setMeasuring] = useState(false);
  const [distance, setDistance] = useState<number | null>(null);

  // Three.js handles live in refs so React re-renders never recreate the scene.
  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    loaded: LoadedIfc;
    raf: number;
    measurePts: THREE.Vector3[];
    measureGroup: THREE.Group;
    onResize: () => void;
    onClick: (e: MouseEvent) => void;
  } | null>(null);

  const measuringRef = useRef(false);
  useEffect(() => { measuringRef.current = measuring; }, [measuring]);

  const teardown = useCallback(() => {
    const t = three.current;
    if (!t) return;
    cancelAnimationFrame(t.raf);
    window.removeEventListener('resize', t.onResize);
    t.renderer.domElement.removeEventListener('click', t.onClick);
    t.controls.dispose();
    t.loaded.dispose();
    t.renderer.dispose();
    t.renderer.domElement.remove();
    three.current = null;
  }, []);

  // Dispose on unmount (route change, surface close).
  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setPhase('loading');
    setError('');
    try {
      const resolved = await resolveUrl();
      if ('error' in resolved) { setError(resolved.error); setPhase('error'); return; }
      const res = await fetch(resolved.url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const loaded = await loadIfc(bytes);

      const mount = mountRef.current;
      if (!mount) { loaded.dispose(); return; }
      const width = mount.clientWidth || 640;
      const height = 420;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf4f5f7);
      scene.add(loaded.object);
      scene.add(new THREE.AmbientLight(0xffffff, 0.75));
      const dir = new THREE.DirectionalLight(0xffffff, 0.9);
      dir.position.set(1, 2, 1.5);
      scene.add(dir);
      const measureGroup = new THREE.Group();
      scene.add(measureGroup);

      const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 1e6);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      mount.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;

      // Fit camera to the model bounds.
      const box = loaded.boundingBox;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const center = sphere.center;
      const r = sphere.radius || 1;
      controls.target.copy(center);
      camera.position.set(center.x + r * 1.4, center.y + r * 1.1, center.z + r * 1.4);
      camera.near = r / 100;
      camera.far = r * 100;
      camera.updateProjectionMatrix();

      const raycaster = new THREE.Raycaster();
      const measurePts: THREE.Vector3[] = [];

      const onClick = (e: MouseEvent) => {
        if (!measuringRef.current) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(loaded.object.children, true);
        if (!hits.length) return;
        const p = hits[0].point.clone();
        if (measurePts.length === 2) { measurePts.length = 0; measureGroup.clear(); setDistance(null); }
        measurePts.push(p);
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(r / 120, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0xd6453d }),
        );
        dot.position.copy(p);
        measureGroup.add(dot);
        if (measurePts.length === 2) {
          const geo = new THREE.BufferGeometry().setFromPoints(measurePts);
          measureGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd6453d })));
          setDistance(measurePts[0].distanceTo(measurePts[1]));
        }
      };
      renderer.domElement.addEventListener('click', onClick);

      const onResize = () => {
        const w = mount.clientWidth || width;
        renderer.setSize(w, height);
        camera.aspect = w / height;
        camera.updateProjectionMatrix();
      };
      window.addEventListener('resize', onResize);

      const tick = () => {
        controls.update();
        renderer.render(scene, camera);
        three.current!.raf = requestAnimationFrame(tick);
      };

      three.current = { renderer, scene, camera, controls, loaded, raf: 0, measurePts, measureGroup, onResize, onClick };
      three.current.raf = requestAnimationFrame(tick);

      setCategories(loaded.categories.map((c) => ({ label: c.label, visible: true })));
      setPhase('ready');
    } catch (err) {
      setError('This model could not be opened. It may be an unsupported IFC variant.');
      setPhase('error');
      // eslint-disable-next-line no-console
      console.error('[IfcViewer] load failed:', err);
    }
  }, [resolveUrl]);

  const toggleCategory = useCallback((label: string) => {
    const t = three.current;
    if (!t) return;
    const cat = t.loaded.categories.find((c) => c.label === label);
    if (!cat) return;
    cat.mesh.visible = !cat.mesh.visible;
    setCategories((prev) => prev.map((c) => (c.label === label ? { ...c, visible: cat.mesh.visible } : c)));
  }, []);

  return (
    <div className="ifc-viewer" style={{ border: '1px solid var(--border, #e3e5e8)', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderBottom: '1px solid var(--border, #e3e5e8)' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>3D model — {fileName}</strong>
          <span style={{ fontSize: 12, color: 'var(--muted, #6b7280)' }}>
            {humanSize(sizeBytes)}{sizeBytes > LARGE_MODEL_BYTES ? ' · large model — may take a moment' : ''}
          </span>
        </div>
        {phase === 'idle' || phase === 'error' ? (
          <button type="button" className="btn" onClick={start} style={{ flexShrink: 0 }}>
            {phase === 'error' ? 'Retry' : 'Load 3D model'}
          </button>
        ) : null}
        {phase === 'ready' ? (
          <button
            type="button"
            className="btn"
            aria-pressed={measuring}
            onClick={() => setMeasuring((v) => !v)}
            style={{ flexShrink: 0, background: measuring ? 'var(--accent, #d6453d)' : undefined, color: measuring ? '#fff' : undefined }}
          >
            {measuring ? 'Measuring — click two points' : 'Measure'}
          </button>
        ) : null}
      </div>

      {phase === 'error' ? (
        <p style={{ padding: '14px 12px', color: 'var(--accent, #d6453d)', margin: 0 }}>{error}</p>
      ) : null}
      {phase === 'loading' ? (
        <p style={{ padding: '14px 12px', color: 'var(--muted, #6b7280)', margin: 0 }}>Loading the model…</p>
      ) : null}

      <div style={{ display: phase === 'ready' ? 'flex' : 'none', alignItems: 'stretch' }}>
        <div ref={mountRef} style={{ flex: 1, minHeight: 420, background: '#f4f5f7' }} />
        {categories.length ? (
          <div style={{ width: 200, borderLeft: '1px solid var(--border, #e3e5e8)', padding: '10px 12px', overflowY: 'auto', maxHeight: 420 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--muted, #6b7280)' }}>Show / hide</div>
            {categories.map((c) => (
              <label key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={c.visible} onChange={() => toggleCategory(c.label)} />
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{prettyLabel(c.label)}</span>
              </label>
            ))}
            {distance != null ? (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border, #e3e5e8)', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>Distance</div>
                <div>{distance.toFixed(2)} model units</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** "IFCWALLSTANDARDCASE" → "Wall Standard Case" — kinder than the raw type. */
function prettyLabel(raw: string): string {
  const base = raw.replace(/^IFC/i, '').toLowerCase();
  return base.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/standardcase/i, ' Standard Case').trim() || raw;
}
