// FR9 four-pillar status panel. Each tile carries colour + label + icon; the RAG
// class only *adds* to the label/glyph, it is never the sole signal. The panel
// renders whatever the Ledger & Budget service derived — no status math here.
import type { Pillars, Pillar } from '@/lib/types';
import { StatusIcon, PillarGlyph } from './icons';

const RAG_WORD: Record<Pillar['status'], string> = {
  green: 'On track',
  amber: 'Attention',
  red: 'Over',
};

function Tile({ p }: { p: Pillar }) {
  return (
    <div className={`pillar ${p.status}`}>
      <div className="p-top">
        <PillarGlyph pillar={p.pillar} className="p-ic" />
        <span className="p-name">{p.pillar}</span>
      </div>
      <div className="p-state">
        <StatusIcon name={p.icon} className="p-ic" aria-hidden />
        <span>{RAG_WORD[p.status]}</span>
      </div>
      <div className="p-sub">{p.label}</div>
    </div>
  );
}

export function PillarPanel({ pillars }: { pillars: Pillars }) {
  // Order matches the mockup: Scope · Time · Cost · Quality.
  return (
    <div className="pillars" role="group" aria-label="Four-pillar project status">
      <Tile p={pillars.scope} />
      <Tile p={pillars.time} />
      <Tile p={pillars.cost} />
      <Tile p={pillars.quality} />
    </div>
  );
}
