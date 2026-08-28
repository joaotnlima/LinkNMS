export default {
  title: "Components/Import mapping",
  parameters: {
    docs: {
      description: {
        component:
          "The contractor confirms what every spreadsheet column means — the machine never guesses. Each detected column (with sample values) maps to a LinkNMS field: Action / Sub-action, Start, End, Trade, Dependency, or 'Not imported'. A set mapping reads blue; an unmapped column reads amber. Only a missing REQUIRED mapping (Action, Start, End) blocks Confirm; everything else is a non-blocking warning. This is the anti-guessing rule the whole product exists to enforce. See flows/01-bootstrap-project.md, screen 9.",
      },
    },
  },
};

const row = (col, sample, target, state) =>
  `<div class="rw">
     <div><div class="colname">${col}</div><div class="sample">${sample}</div></div>
     <div class="mapsel ${state}"><span>${target}</span><span>▾</span></div>
   </div>`;

export const MapColumns = {
  name: "Map columns",
  render: () =>
    `<div class="maptbl">
      <div class="hd"><span>Spreadsheet column</span><span>Maps to LinkNMS field</span></div>
      ${row("Tarefa", "&ldquo;Fundações&rdquo;, &ldquo;Escavação&rdquo;…", "Action / Sub-action", "set")}
      ${row("Início", "&ldquo;2026-09-01&rdquo;, &ldquo;2026-09-08&rdquo;…", "Start date", "set")}
      ${row("Fim", "&ldquo;2026-09-05&rdquo;, &ldquo;09/22/26&rdquo;…", "End date", "set")}
      ${row("Especialidade", "&ldquo;Estrutura&rdquo;, &ldquo;MEP&rdquo;…", "Trade", "set")}
      ${row("Depende de", "&ldquo;Fundações&rdquo;, &ldquo;Estrutura&rdquo;…", "Dependency", "set")}
      ${row("Notas", "free text", "Not imported", "unset")}
    </div>`,
};

export const MissingRequired = {
  name: "Blocked — required field unmapped",
  render: () =>
    `<div style="display:flex;flex-direction:column;gap:12px;max-width:560px">
      <div class="maptbl">
        <div class="hd"><span>Spreadsheet column</span><span>Maps to LinkNMS field</span></div>
        ${row("Tarefa", "&ldquo;Fundações&rdquo;, &ldquo;Escavação&rdquo;…", "Action / Sub-action", "set")}
        ${row("Início", "&ldquo;2026-09-01&rdquo;…", "Start date", "set")}
        ${row("Fim", "&ldquo;2026-09-05&rdquo;…", "Choose a field…", "unset")}
      </div>
      <div class="msg" style="color:var(--danger);font-size:12px">End date isn't mapped — map it to continue.</div>
    </div>`,
};
