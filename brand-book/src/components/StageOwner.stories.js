export default {
  title: "Components/Stage owner & trade",
  parameters: {
    docs: {
      description: {
        component:
          "Who owns a plan stage, and which specialty it is. The avatar is the `.av` initials circle from Party invite at two sizes (md in an editor control, sm inline on a plan row); the tint follows the side of the table (owner blue / builder orange) and the role is ALWAYS spelled out beside it, so colour is never the only signal. Unassigned is drawn as an absence — a dashed ring and an em dash — not as a grey person: a stage with no owner has nobody on it, and a placeholder face would read as somebody. The trade chip is free text from the plan (or the imported spreadsheet) rendered verbatim; it is deliberately quieter than a status badge, because a trade labels the work rather than stating its state. Assignment is attribution, never permission: naming a party on a stage grants no read or write their membership role did not already allow. Implemented at app/src/components/PartyAvatar.tsx (LINA-246, ADR-0017 annex 3).",
      },
    },
  },
};

const css = `
  .sav{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
       border-radius:50%;font-weight:700;line-height:1;letter-spacing:.02em}
  .sav.md{width:28px;height:28px;font-size:11px}
  .sav.sm{width:22px;height:22px;font-size:10px}
  .sav.owner{background:var(--owner-muted);color:var(--owner-fg)}
  .sav.builder{background:var(--builder-muted);color:var(--builder-fg)}
  .sav.none{background:transparent;color:var(--muted);border:1px dashed var(--outline);font-weight:600}
  .strade{display:inline-flex;align-items:center;height:20px;padding:0 8px;border:1px solid var(--outline);
          border-radius:999px;background:var(--sunken);color:var(--muted);font-size:11px;font-weight:650;white-space:nowrap}
  .sowner{display:inline-flex;align-items:center;gap:6px}
  .sowner .nm{font-size:12px;font-weight:650}
  .sowner .rl{font-size:11px;color:var(--muted)}
  .srow{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:10px 0;
        border-bottom:1px solid var(--outline)}
  .srow .stage{font-size:13.5px;font-weight:600}
`;

const owner = (initials, name, role, tone, size = "sm") =>
  `<span class="sowner">
     <span class="sav ${size} ${tone}" title="${name} · ${role}">${initials}</span>
     <span class="nm">${name}</span><span class="rl">${role}</span>
   </span>`;

export const Avatars = {
  name: "Avatars",
  render: () =>
    `<style>${css}</style>
     <div class="row" style="gap:18px;align-items:center">
       <span class="sav md owner" title="Marta Almeida · Owner">MA</span>
       <span class="sav md builder" title="Nuno Ferreira · General contractor">NF</span>
       <span class="sav md none" title="Unassigned">—</span>
       <span class="sav sm owner">MA</span>
       <span class="sav sm builder">NF</span>
       <span class="sav sm none">—</span>
     </div>`,
};

export const TradeChip = {
  name: "Trade chip",
  render: () =>
    `<style>${css}</style>
     <div class="row" style="gap:8px">
       <span class="strade">Electrical</span>
       <span class="strade">Plumbing</span>
       <span class="strade">Roofing</span>
       <span class="strade">Masonry / Enclosure</span>
     </div>`,
};

export const PlanRows = {
  name: "On a plan row",
  render: () =>
    `<style>${css}</style>
     <div style="max-width:640px">
       <div class="srow">
         <span class="stage">2.7 Electrical</span>
         ${owner("NF", "Nuno Ferreira", "General contractor", "builder")}
         <span class="strade">Electrical</span>
       </div>
       <div class="srow">
         <span class="stage">2.5 Roofing</span>
         ${owner("JS", "Joana Silva", "Trade", "builder")}
         <span class="strade">Roofing</span>
       </div>
       <div class="srow">
         <span class="stage">1.3 Permitting &amp; Approval</span>
         ${owner("MA", "Marta Almeida", "Owner", "owner")}
       </div>
       <div class="srow">
         <span class="stage">3.2 Warranty &amp; Maintenance</span>
       </div>
     </div>
     <p style="margin-top:12px;font-size:12px;color:var(--muted);max-width:640px">
       The last row is unassigned and untagged — it renders as the stage name alone.
       No avatar, no chip, no placeholder: the plan says nothing about an owner
       because nobody has been named.
     </p>`,
};

export const EditorControl = {
  name: "Editor — owner picker",
  render: () =>
    `<style>${css}</style>
     <div class="row" style="gap:18px;align-items:center;max-width:640px">
       <span class="sowner">
         <span class="sav md builder">NF</span>
         <select style="font:inherit;font-size:12px;font-weight:600;border:1px solid var(--outline);
                        border-radius:6px;padding:2px 4px;background:transparent;color:var(--fg)">
           <option>Nuno Ferreira · General contractor</option>
           <option>Marta Almeida · Owner</option>
           <option>Unassigned</option>
         </select>
       </span>
       <label style="display:inline-flex;align-items:center;gap:6px">
         <span style="font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)">Trade</span>
         <input value="Electrical" style="font:inherit;font-size:12px;width:130px;padding:2px 4px;
                background:transparent;color:var(--fg);border:1px solid transparent;border-bottom-color:var(--outline)">
       </label>
     </div>
     <p style="margin-top:12px;font-size:12px;color:var(--muted);max-width:640px">
       The picker offers the build's MEMBERS and nothing else. There is no free-text
       party field and no invite-from-here: a party the project does not hold is
       refused by the server, and a control that could produce one would be an
       invitation to hit that refusal.
     </p>`,
};
