'use client';

// The model page's 3D viewport (PRD-07 M-2..M-4; board Component · Viewport).
// web-ifc + Three.js, client-only. Loads one version's bytes, then never
// rebuilds geometry: picking is a raycast resolved to a GlobalId by the
// loader's triangle ranges, and every colour change (task / status / who
// edits, isolate-and-fade, selection highlight) is one `paint` pass over the
// vertex colours. Read-only: nothing here writes the IFC (D-45).
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { loadIfc, type LoadedIfc } from '@/components/ifc/ifc-loader';

export interface ViewportProps {
  bytes: Uint8Array;
  /** Colour of an element (hex) or null for its own IFC colour. Re-applied when it changes. */
  colourOf: (globalId: string) => string | null;
  /** Bumped by the page whenever `colourOf`'s inputs change. */
  paintKey: string;
  onLoaded: (loaded: LoadedIfc) => void;
  onPick: (globalId: string | null, additive: boolean) => void;
  measuring: boolean;
  onMeasure?: (metres: number | null) => void;
  /** GlobalId to frame (zoom-to), e.g. when isolating a task or opening a pin. */
  focus?: string[] | null;
}

export default function ModelViewport({ bytes, colourOf, paintKey, onLoaded, onPick, measuring, onMeasure, focus }: ViewportProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const state = useRef<{ loaded: LoadedIfc; camera: THREE.PerspectiveCamera; controls: OrbitControls } | null>(null);
  const live = useRef({ colourOf, onPick, measuring, onMeasure });
  live.current = { colourOf, onPick, measuring, onMeasure };

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const loaded = await loadIfc(bytes);
        const mount = mountRef.current;
        if (cancelled || !mount) { loaded.dispose(); return; }
        const width = mount.clientWidth || 800;
        const height = mount.clientHeight || 520;
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
        const sphere = loaded.boundingBox.getBoundingSphere(new THREE.Sphere());
        const r = sphere.radius || 1;
        controls.target.copy(sphere.center);
        camera.position.set(sphere.center.x + r * 1.4, sphere.center.y + r * 1.1, sphere.center.z + r * 1.4);
        camera.near = r / 100;
        camera.far = r * 100;
        camera.updateProjectionMatrix();

        const raycaster = new THREE.Raycaster();
        const measurePts: THREE.Vector3[] = [];
        let down: { x: number; y: number } | null = null;
        const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
        const onUp = (e: PointerEvent) => {
          // A drag orbits; only a click (no travel) picks.
          if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
          down = null;
          const rect = renderer.domElement.getBoundingClientRect();
          raycaster.setFromCamera(new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1,
          ), camera);
          const hits = raycaster.intersectObjects(loaded.object.children, true).filter((h) => h.object.visible);
          if (live.current.measuring) {
            if (!hits.length) return;
            if (measurePts.length === 2) { measurePts.length = 0; measureGroup.clear(); live.current.onMeasure?.(null); }
            measurePts.push(hits[0].point.clone());
            const dot = new THREE.Mesh(new THREE.SphereGeometry(r / 150, 10, 10), new THREE.MeshBasicMaterial({ color: 0xd6453d }));
            dot.position.copy(hits[0].point);
            measureGroup.add(dot);
            if (measurePts.length === 2) {
              measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(measurePts), new THREE.LineBasicMaterial({ color: 0xd6453d })));
              live.current.onMeasure?.(measurePts[0].distanceTo(measurePts[1]));
            }
            return;
          }
          const gid = hits.length ? loaded.elementAt(hits[0].object, hits[0].faceIndex) : null;
          live.current.onPick(gid, e.shiftKey || e.metaKey || e.ctrlKey);
        };
        renderer.domElement.addEventListener('pointerdown', onDown);
        renderer.domElement.addEventListener('pointerup', onUp);
        const onResize = () => {
          const w = mount.clientWidth || width;
          const h = mount.clientHeight || height;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(mount);
        let raf = 0;
        const tick = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick); };
        raf = requestAnimationFrame(tick);

        state.current = { loaded, camera, controls };
        loaded.paint((gid) => live.current.colourOf(gid));
        onLoaded(loaded);
        setLoading(false);
        cleanup = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          renderer.domElement.removeEventListener('pointerdown', onDown);
          renderer.domElement.removeEventListener('pointerup', onUp);
          controls.dispose();
          loaded.dispose();
          renderer.dispose();
          renderer.domElement.remove();
          state.current = null;
        };
      } catch (err) {
        if (!cancelled) {
          setError('This model could not be opened. It may be an unsupported IFC variant.');
          setLoading(false);
        }
        // eslint-disable-next-line no-console
        console.error('[ModelViewport] load failed:', err);
      }
    })();
    return () => { cancelled = true; cleanup(); };
    // The bytes are the scene; everything else is a repaint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  useEffect(() => {
    state.current?.loaded.paint((gid) => live.current.colourOf(gid));
  }, [paintKey]);

  useEffect(() => {
    const s = state.current;
    if (!s || !focus?.length) return;
    const box = new THREE.Box3();
    for (const gid of focus) { const b = s.loaded.boundsOf(gid); if (b) box.union(b); }
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 0.5);
    const dirv = s.camera.position.clone().sub(s.controls.target).normalize();
    s.controls.target.copy(sphere.center);
    s.camera.position.copy(sphere.center.clone().add(dirv.multiplyScalar(r * 3)));
    s.camera.updateProjectionMatrix();
  }, [focus]);

  return (
    <div className="mdl-viewport">
      <div ref={mountRef} className="mdl-canvas" />
      {loading ? <p className="mdl-overlay" role="status">Loading the model…</p> : null}
      {error ? <p className="mdl-overlay mdl-err" role="alert">{error}</p> : null}
    </div>
  );
}
