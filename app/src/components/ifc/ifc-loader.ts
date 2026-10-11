// IFC → Three.js geometry (LINA-409 / doc 24; PRD-07 M-2). Read-only: web-ifc
// (WASM) parses the model; nothing is ever written back (D-45).
//
// Per-ELEMENT geometry, batched per IFC class: every placed geometry is baked
// (transform applied) into ONE merged BufferGeometry per (IFC class, opaque |
// transparent) — the draw-call count stays that of the old per-category merge —
// but each element keeps its own vertex and triangle RANGES, its expressID ↔
// GlobalId mapping and its base colour in a per-vertex `color` attribute. So:
//   - picking is a raycast + binary search of the hit triangle → element;
//   - highlight, colour by task / status / who edits, and fade-to-isolate are
//     writes into the colour attribute ranges, never new meshes;
//   - class show / hide is still a group toggle (the RFP viewer's isolate).
//
// Client-only: this module touches WebGL-adjacent WASM and must never be
// imported from a server component. The wasm asset is served from /wasm/.
import * as THREE from 'three';
import { IfcAPI } from 'web-ifc';

export interface IfcCategory {
  /** Human IFC type name, e.g. "IFCWALLSTANDARDCASE". */
  label: string;
  mesh: THREE.Mesh;
}

export interface IfcElement {
  expressId: number;
  globalId: string;
  name: string;
  ifcClass: string;
}

export interface IfcProperty { set: string; name: string; value: string }

export interface LoadedIfc {
  /** The model root (already rotated IFC Z-up → Three Y-up). Add to a scene. */
  object: THREE.Object3D;
  categories: IfcCategory[];
  boundingBox: THREE.Box3;
  /** Every element with geometry, by GlobalId. */
  elements: Map<string, IfcElement>;
  /** The GlobalId under a raycast hit, or null. */
  elementAt: (object: THREE.Object3D, faceIndex: number | null | undefined) => string | null;
  /**
   * Recolour every element: `pick` answers an RGB hex (e.g. '#3b6fd8') or null
   * for the element's own IFC colour. One pass, one GPU upload per mesh.
   */
  paint: (pick: (globalId: string) => string | null) => void;
  /** The element's world-space bounds (zoom-to). */
  boundsOf: (globalId: string) => THREE.Box3 | null;
  /** Read-only property sets of an element (web-ifc, lazily). */
  properties: (globalId: string) => Promise<IfcProperty[]>;
  /** Call on unmount: frees GPU buffers AND the web-ifc WASM model. */
  dispose: () => void;
}

let apiPromise: Promise<IfcAPI> | null = null;

/** One shared, initialised web-ifc instance (the WASM init is expensive). */
export async function getIfcApi(): Promise<IfcAPI> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const api = new IfcAPI();
      // Absolute path to the copied WASM; `absolute=true` so web-ifc does not
      // prefix it with its own module URL (which Next fingerprints).
      api.SetWasmPath('/wasm/', true);
      await api.Init();
      return api;
    })();
  }
  return apiPromise;
}

/** Growable typed buffers — no per-vertex JS array churn on large models. */
class Grow {
  data: Float32Array;
  length = 0;
  constructor(n = 3 * 4096) { this.data = new Float32Array(n); }
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data[this.length] = a; this.data[this.length + 1] = b; this.data[this.length + 2] = c; this.length += 3;
  }
  view() { return this.data.subarray(0, this.length); }
}
class GrowU32 {
  data = new Uint32Array(3 * 4096);
  length = 0;
  push(v: number) {
    if (this.length + 1 > this.data.length) { const d = new Uint32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    this.data[this.length] = v; this.length += 1;
  }
  view() { return this.data.subarray(0, this.length); }
}

interface Bucket {
  type: number;
  transparent: boolean;
  pos: Grow; norm: Grow; col: Grow; idx: GrowU32;
  /** Element ranges in order: triangle start, vertex start/count, expressID. */
  triStart: number[]; vStart: number[]; vCount: number[]; owner: number[];
  baseColour: Array<[number, number, number]>;
  mesh?: THREE.Mesh;
}

interface Placement { bucket: Bucket; range: number }

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && v !== null && 'value' in v) return String((v as { value: unknown }).value ?? '');
  return String(v);
}

/**
 * Parse an IFC file (bytes) into per-class batched meshes that keep each
 * element addressable. Main thread, behind an explicit click (doc 24 §5).
 */
export async function loadIfc(bytes: Uint8Array): Promise<LoadedIfc> {
  const api = await getIfcApi();
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });

  const buckets = new Map<string, Bucket>();
  const placements = new Map<number, Placement[]>();
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();

  api.StreamAllMeshes(modelID, (flatMesh) => {
    const expressId = flatMesh.expressID;
    const type = api.GetLineType(modelID, expressId);
    const geoms = flatMesh.geometries;
    for (let i = 0; i < geoms.size(); i += 1) {
      const pg = geoms.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const c = pg.color;
      const transparent = c.w < 0.98;
      const key = `${type}|${transparent ? 't' : 'o'}`;
      let b = buckets.get(key);
      if (!b) {
        b = { type, transparent, pos: new Grow(), norm: new Grow(), col: new Grow(), idx: new GrowU32(), triStart: [], vStart: [], vCount: [], owner: [], baseColour: [] };
        buckets.set(key, b);
      }
      m.fromArray(pg.flatTransformation); // column-major, matches web-ifc
      nm.getNormalMatrix(m);
      const base = b.pos.length / 3;
      const vCount = verts.length / 6; // web-ifc interleaves [px,py,pz, nx,ny,nz]
      for (let vi = 0; vi < vCount; vi += 1) {
        const o = vi * 6;
        v.set(verts[o], verts[o + 1], verts[o + 2]).applyMatrix4(m);
        b.pos.push3(v.x, v.y, v.z);
        v.set(verts[o + 3], verts[o + 4], verts[o + 5]).applyMatrix3(nm).normalize();
        b.norm.push3(v.x, v.y, v.z);
        b.col.push3(c.x, c.y, c.z);
      }
      const tri0 = b.idx.length / 3;
      for (let ii = 0; ii < indices.length; ii += 1) b.idx.push(base + indices[ii]);
      b.triStart.push(tri0); b.vStart.push(base); b.vCount.push(vCount); b.owner.push(expressId);
      b.baseColour.push([c.x, c.y, c.z]);
      const list = placements.get(expressId);
      const p = { bucket: b, range: b.owner.length - 1 };
      if (list) list.push(p); else placements.set(expressId, [p]);
    }
  });

  // One mesh per bucket, grouped by class so the RFP viewer's show/hide toggles a class.
  const root = new THREE.Group();
  const catGroups = new Map<number, THREE.Group>();
  const materials: THREE.Material[] = [];
  for (const b of buckets.values()) {
    if (!b.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.pos.view().slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(b.norm.view().slice(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(b.col.view().slice(), 3));
    g.setIndex(new THREE.BufferAttribute(b.idx.view().slice(), 1));
    g.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide, transparent: b.transparent, opacity: b.transparent ? 0.45 : 1, depthWrite: !b.transparent,
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(g, mat);
    b.mesh = mesh;
    let cg = catGroups.get(b.type);
    if (!cg) { cg = new THREE.Group(); catGroups.set(b.type, cg); root.add(cg); }
    cg.add(mesh);
  }
  // IFC is Z-up; Three is Y-up. Rotate the root so the model stands upright.
  root.rotation.x = -Math.PI / 2;
  root.updateMatrixWorld(true);

  const categories: IfcCategory[] = [];
  for (const [type, cg] of catGroups) {
    let label = `Type ${type}`;
    try { label = api.GetNameFromTypeCode(type) || label; } catch { /* keep fallback */ }
    categories.push({ label, mesh: cg as unknown as THREE.Mesh });
  }
  categories.sort((a, b) => a.label.localeCompare(b.label));

  // expressID ↔ GlobalId (one GetLine per element; elements without a GlobalId
  // — rare, non-rooted geometry — stay unpickable rather than invented).
  const elements = new Map<string, IfcElement>();
  const gidOf = new Map<number, string>();
  for (const expressId of placements.keys()) {
    try {
      const line = api.GetLine(modelID, expressId);
      const globalId = str(line?.GlobalId);
      if (!globalId) continue;
      let ifcClass = '';
      try { ifcClass = api.GetNameFromTypeCode(api.GetLineType(modelID, expressId)); } catch { /* unknown class */ }
      elements.set(globalId, { expressId, globalId, name: str(line?.Name) || str(line?.ObjectType) || ifcClass, ifcClass });
      gidOf.set(expressId, globalId);
    } catch { /* unreadable line — leave unpickable */ }
  }

  const meshToBucket = new Map<THREE.Object3D, Bucket>();
  for (const b of buckets.values()) if (b.mesh) meshToBucket.set(b.mesh, b);

  const elementAt = (object: THREE.Object3D, faceIndex: number | null | undefined): string | null => {
    const b = meshToBucket.get(object);
    if (!b || faceIndex == null) return null;
    let lo = 0;
    let hi = b.triStart.length - 1;
    while (lo < hi) { // last range whose start ≤ faceIndex
      const mid = (lo + hi + 1) >> 1;
      if (b.triStart[mid] <= faceIndex) lo = mid; else hi = mid - 1;
    }
    return gidOf.get(b.owner[lo]) ?? null;
  };

  const tmp = new THREE.Color();
  const paint = (pick: (globalId: string) => string | null) => {
    for (const b of buckets.values()) {
      const attr = b.mesh?.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const arr = attr.array as Float32Array;
      for (let r = 0; r < b.owner.length; r += 1) {
        const gid = gidOf.get(b.owner[r]);
        const hex = gid ? pick(gid) : null;
        let cr: number; let cg: number; let cb: number;
        if (hex) { tmp.set(hex); cr = tmp.r; cg = tmp.g; cb = tmp.b; } else { [cr, cg, cb] = b.baseColour[r]; }
        const s = b.vStart[r] * 3;
        const e = s + b.vCount[r] * 3;
        for (let k = s; k < e; k += 3) { arr[k] = cr; arr[k + 1] = cg; arr[k + 2] = cb; }
      }
      attr.needsUpdate = true;
    }
  };

  const boundsOf = (globalId: string): THREE.Box3 | null => {
    const el = elements.get(globalId);
    const list = el ? placements.get(el.expressId) : null;
    if (!list) return null;
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (const { bucket, range } of list) {
      const pos = bucket.mesh?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || !bucket.mesh) continue;
      const s = bucket.vStart[range];
      for (let k = s; k < s + bucket.vCount[range]; k += 1) {
        box.expandByPoint(p.fromBufferAttribute(pos, k).applyMatrix4(bucket.mesh.matrixWorld));
      }
    }
    return box.isEmpty() ? null : box;
  };

  const properties = async (globalId: string): Promise<IfcProperty[]> => {
    const el = elements.get(globalId);
    if (!el || !api.IsModelOpen(modelID)) return [];
    const out: IfcProperty[] = [];
    try {
      const sets = await api.properties.getPropertySets(modelID, el.expressId, true);
      for (const set of sets ?? []) {
        const setName = str(set?.Name) || 'Properties';
        for (const prop of set?.HasProperties ?? []) {
          const value = str(prop?.NominalValue) || str(prop?.EnumerationValues?.[0]);
          if (str(prop?.Name)) out.push({ set: setName, name: str(prop.Name), value });
        }
        for (const q of set?.Quantities ?? []) {
          const val = q?.LengthValue ?? q?.AreaValue ?? q?.VolumeValue ?? q?.CountValue ?? q?.WeightValue;
          if (str(q?.Name)) out.push({ set: setName, name: str(q.Name), value: str(val) });
        }
      }
    } catch { /* properties are best-effort, the element still shows */ }
    return out;
  };

  const boundingBox = new THREE.Box3().setFromObject(root);

  const dispose = () => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const mat of materials) mat.dispose();
    try { if (api.IsModelOpen(modelID)) api.CloseModel(modelID); } catch { /* already closed */ }
  };

  return { object: root, categories, boundingBox, elements, elementAt, paint, boundsOf, properties, dispose };
}
