// GlobalId index of an IFC file — what a version comparison (M-16) and the
// pre-upload check (M-18) read from the FILES themselves. No geometry: one
// pass over IfcProduct lines for GlobalId / Name / class, one pass over
// IfcRelDefinesByProperties for each element's flattened properties
// ("Pset.Name" → value). Client-only (web-ifc WASM); the server never parses IFC.
import { IFCPRODUCT, IFCRELDEFINESBYPROPERTIES } from 'web-ifc';

import { getIfcApi } from '@/components/ifc/ifc-loader';
import type { IfcIndex } from '@/lib/v2/model-view';

function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object' && v !== null && 'value' in v) return String((v as { value: unknown }).value ?? '');
  return String(v);
}

function ids(vec: { size(): number; get(i: number): number }): number[] {
  const out: number[] = [];
  for (let i = 0; i < vec.size(); i += 1) out.push(vec.get(i));
  return out;
}

export async function readIfcIndex(bytes: Uint8Array): Promise<IfcIndex> {
  const api = await getIfcApi();
  const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  try {
    const index: IfcIndex = new Map();
    const byExpress = new Map<number, string>();
    for (const id of ids(api.GetLineIDsWithType(modelID, IFCPRODUCT, true))) {
      const line = api.GetLine(modelID, id);
      const gid = str(line?.GlobalId);
      if (!gid) continue;
      let cls = '';
      try { cls = api.GetNameFromTypeCode(api.GetLineType(modelID, id)); } catch { /* unknown class */ }
      index.set(gid, { name: str(line?.Name), cls, props: {} });
      byExpress.set(id, gid);
    }
    for (const relId of ids(api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES))) {
      const rel = api.GetLine(modelID, relId);
      const psetId = rel?.RelatingPropertyDefinition?.value;
      if (!psetId) continue;
      const pset = api.GetLine(modelID, psetId, true);
      const setName = str(pset?.Name) || 'Properties';
      const values: Record<string, string> = {};
      for (const p of pset?.HasProperties ?? []) {
        if (str(p?.Name)) values[`${setName}.${str(p.Name)}`] = str(p?.NominalValue);
      }
      for (const q of pset?.Quantities ?? []) {
        const val = q?.LengthValue ?? q?.AreaValue ?? q?.VolumeValue ?? q?.CountValue ?? q?.WeightValue;
        if (str(q?.Name)) values[`${setName}.${str(q.Name)}`] = str(val);
      }
      for (const obj of rel?.RelatedObjects ?? []) {
        const gid = byExpress.get(obj?.value);
        const facts = gid ? index.get(gid) : null;
        if (facts) Object.assign(facts.props, values);
      }
    }
    return index;
  } finally {
    try { if (api.IsModelOpen(modelID)) api.CloseModel(modelID); } catch { /* already closed */ }
  }
}

/** Fetch a version's bytes from its short-lived inline URL. */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
