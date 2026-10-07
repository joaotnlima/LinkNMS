// IFC → Three.js geometry (LINA-409 / doc 24). Read-only: web-ifc (WASM) parses
// the model, we bake each placed geometry's transform + colour into ONE merged
// BufferGeometry PER IFC CATEGORY (IfcWall, IfcSlab, …). Merging by category
// keeps the mesh count low (fast WebGL) and gives the viewer its isolate/hide
// dimension for free — a category is the "discipline" a bidder toggles.
//
// Client-only: this module touches the DOM/WebGL-adjacent WASM and must never
// be imported from a server component. The wasm asset is served from /wasm/
// (copied from node_modules/web-ifc at build-of-the-repo time; see public/wasm).
import * as THREE from 'three';
import { IfcAPI } from 'web-ifc';

export interface IfcCategory {
  /** Human IFC type name, e.g. "IFCWALLSTANDARDCASE". */
  label: string;
  mesh: THREE.Mesh;
}

export interface LoadedIfc {
  /** The model root (already rotated IFC Z-up → Three Y-up). Add to a scene. */
  object: THREE.Object3D;
  categories: IfcCategory[];
  boundingBox: THREE.Box3;
  /** Call on unmount: frees GPU buffers AND the web-ifc WASM model. */
  dispose: () => void;
}

let apiPromise: Promise<IfcAPI> | null = null;

/** One shared, initialised web-ifc instance (the WASM init is ~expensive). */
async function getApi(): Promise<IfcAPI> {
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

/** A readable, stable colour key so geometries of one colour share a material. */
function materialFor(cache: Map<string, THREE.Material>, r: number, g: number, b: number, a: number): THREE.Material {
  const key = `${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)},${a.toFixed(3)}`;
  let mat = cache.get(key);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(r, g, b),
      transparent: a < 0.98,
      opacity: a,
      side: THREE.DoubleSide,
      depthWrite: a > 0.98,
    });
    cache.set(key, mat);
  }
  return mat;
}

/**
 * Parse an IFC file (as bytes) into mergeable Three.js meshes grouped by IFC
 * category. Runs on the main thread — web-ifc's WASM parse is fast for typical
 * models; the viewer shows a "large model" notice above 50 MB. (A Web Worker is
 * a deferred perf refinement, doc 24 — the view-only capability is unaffected.)
 */
export async function loadIfc(bytes: Uint8Array): Promise<LoadedIfc> {
  const api = await getApi();
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });

  // Accumulate vertex/normal/index buffers per category, then merge once.
  type Buf = { pos: number[]; norm: number[]; idx: number[]; next: number };
  const byCategory = new Map<number, Buf>();
  const matCache = new Map<string, THREE.Material>();
  // One material per (category,colour); we bake colour as a per-mesh material
  // so a category can hold several colours via multiple merged sub-meshes.
  const byCatColour = new Map<string, { buf: Buf; mat: THREE.Material; type: number }>();

  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();

  api.StreamAllMeshes(modelID, (flatMesh) => {
    const type = api.GetLineType(modelID, flatMesh.expressID);
    const geoms = flatMesh.geometries;
    for (let i = 0; i < geoms.size(); i += 1) {
      const pg = geoms.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const c = pg.color;
      const key = `${type}|${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)},${c.w.toFixed(3)}`;
      let bucket = byCatColour.get(key);
      if (!bucket) {
        bucket = { buf: { pos: [], norm: [], idx: [], next: 0 }, mat: materialFor(matCache, c.x, c.y, c.z, c.w), type };
        byCatColour.set(key, bucket);
      }
      const buf = bucket.buf;
      m.fromArray(pg.flatTransformation); // column-major, matches web-ifc
      nm.getNormalMatrix(m);
      const base = buf.next;
      // web-ifc interleaves [px,py,pz, nx,ny,nz] per vertex (6 floats).
      const vCount = verts.length / 6;
      for (let vi = 0; vi < vCount; vi += 1) {
        const o = vi * 6;
        v.set(verts[o], verts[o + 1], verts[o + 2]).applyMatrix4(m);
        buf.pos.push(v.x, v.y, v.z);
        v.set(verts[o + 3], verts[o + 4], verts[o + 5]).applyMatrix3(nm).normalize();
        buf.norm.push(v.x, v.y, v.z);
      }
      for (let ii = 0; ii < indices.length; ii += 1) buf.idx.push(base + indices[ii]);
      buf.next += vCount;
    }
  });

  // Build one Three.Mesh per (category,colour) bucket, parented under a category
  // group so isolate/hide toggles a whole IFC type at once.
  const root = new THREE.Group();
  const catGroups = new Map<number, THREE.Group>();
  for (const { buf, mat, type } of byCatColour.values()) {
    if (!buf.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.norm, 3));
    g.setIndex(buf.idx);
    const mesh = new THREE.Mesh(g, mat);
    let cg = catGroups.get(type);
    if (!cg) { cg = new THREE.Group(); catGroups.set(type, cg); root.add(cg); }
    cg.add(mesh);
  }

  // IFC is Z-up; Three is Y-up. Rotate the root so the model stands upright.
  root.rotation.x = -Math.PI / 2;

  const categories: IfcCategory[] = [];
  for (const [type, cg] of catGroups) {
    let label = `Type ${type}`;
    try { label = api.GetNameFromTypeCode(type) || label; } catch { /* keep fallback */ }
    // Expose each category group as a "mesh" handle for the isolate UI.
    categories.push({ label, mesh: cg as unknown as THREE.Mesh });
  }
  categories.sort((a, b) => a.label.localeCompare(b.label));

  const boundingBox = new THREE.Box3().setFromObject(root);

  const dispose = () => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const mat of matCache.values()) mat.dispose();
    try { if (api.IsModelOpen(modelID)) api.CloseModel(modelID); } catch { /* already closed */ }
  };

  return { object: root, categories, boundingBox, dispose };
}
