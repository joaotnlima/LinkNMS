export default {
  title: "Components/Procurement",
  parameters: {
    docs: {
      description: {
        component:
          "The procurement section of `/projects/:id/plan` — the RFP that goes out and the proposals that come back (ADR-0023 §6). It is an accordion BODY, not a page: the disclosure, the heading and the phase badge belong to the accordion shell. Four promises shape every state here. (1) THE SEND IS A DOOR AND IS DRAWN AS ONE — sending mints a live token per recipient and emails strangers on the owner's behalf, so it confirms in place and says how many people it is about to write to. (2) A DRAFT IS PRIVATE UNTIL SENT, said in as many words, the same promise the plan draft makes. (3) NOTHING IS THROWN AWAY — every proposal stays in the inbox after a constructor is chosen, because the losing bids are the evidence behind the choice. (4) THE NUMBERS ARE QUOTED, NEVER COMPUTED — a range and a timeline print as submitted, with no total, no average and no 'best value' ranking. Disabled controls carry their own reason rather than sitting greyed out with no account of themselves. Implemented at app/src/components/ProcurementSection.tsx (LINA-283; APIs LINA-279/LINA-280).",
      },
    },
  },
};

const css = `
  .prc{max-width:720px;display:flex;flex-direction:column;gap:var(--s4);font-size:14px}
  .prc h3{margin:0;font-size:15px;font-weight:700}
  .prc .quiet{margin:0;color:var(--muted);font-size:12px;line-height:1.5;max-width:64ch}
  .prc .label{font-size:13px;font-weight:600;color:var(--fg)}
  .prc .field{display:flex;flex-direction:column;gap:var(--s2)}
  .prc .row{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap}
  .prc .hd{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap}
  .prc textarea{min-height:88px;font:inherit;line-height:1.5;color:var(--fg);border:1px solid var(--outline);
       background:var(--paper);border-radius:8px;padding:8px 10px;width:100%;box-sizing:border-box}
  .prc textarea[readonly]{background:var(--sunken);color:var(--muted)}
  .prc input[type=text]{flex:1 1 220px;font:inherit;border:1px solid var(--outline);background:var(--paper);
       border-radius:8px;padding:6px 10px}

  .prc .badge{display:inline-flex;align-items:center;font-size:11px;font-weight:650;line-height:1;
       padding:4px 8px;border-radius:999px;border:1px solid var(--outline);background:var(--sunken);color:var(--muted)}
  .prc .badge.live{color:var(--owner-fg);background:var(--owner-muted);border-color:var(--plan-baseline-line)}
  .prc .badge.good{color:var(--ok-fg);background:var(--ok-bg);border-color:var(--ok-bd)}
  .prc .badge.off{color:var(--bad-fg);background:var(--bad-bg);border-color:var(--bad-bd)}

  .prc .skip{display:flex;align-items:center;justify-content:space-between;gap:var(--s3);flex-wrap:wrap;
       border:1px solid var(--outline);border-radius:8px;background:var(--sunken);padding:var(--s3)}
  .prc .skip-t{margin:0;font-size:13px;font-weight:650}

  .prc .confirm{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap;border:1px solid var(--warn-bd);
       background:var(--warn-bg);border-radius:8px;padding:var(--s2) var(--s3)}
  .prc .confirm .quiet{flex:1 1 260px;color:var(--warn-fg)}

  .prc .tags{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
  .prc .tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:4px 8px;
       border-radius:999px;border:1px solid var(--plan-baseline-line);background:var(--plan-baseline-muted);
       color:var(--plan-baseline-fg)}

  .prc .files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
  .prc .file{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s2);
       border:1px solid var(--outline);border-radius:8px;background:var(--sunken);padding:6px 10px}
  .prc .fname{font-size:13px;font-weight:600}
  .prc .fmeta{color:var(--muted);font-size:11px}

  .prc .rcps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
  .prc .rcp{display:flex;align-items:center;gap:var(--s2);padding:6px 0;border-bottom:1px solid var(--line)}
  .prc .rcp:last-child{border-bottom:0}
  .prc .email{flex:1 1 auto;font-size:13px}
  .prc .remove{border:0;background:none;padding:0;font:inherit;font-size:12px;color:var(--muted);
       text-decoration:underline;cursor:pointer}

  .prc .props{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
  .prc .prop{border:1px solid var(--outline);border-radius:8px;background:var(--raised);padding:var(--s2) var(--s3)}
  .prc .prop.sel{border-color:var(--plan-baseline-line);background:var(--plan-baseline-muted)}
  .prc .prop-hd{display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap}
  .prc .disclose{flex:1 1 200px;display:flex;align-items:center;gap:6px;border:0;background:none;padding:0;
       font:inherit;text-align:left;cursor:pointer;color:var(--fg)}
  .prc .caret{color:var(--muted);font-size:11px}
  .prc .company{font-size:14px;font-weight:650}
  .prc .fig{font-size:13px;font-weight:650;font-variant-numeric:tabular-nums}
  .prc .fig.q{color:var(--muted);font-weight:500}
  .prc .prop-body{display:flex;flex-direction:column;gap:var(--s2);margin-top:var(--s2);padding-top:var(--s2);
       border-top:1px solid var(--line)}
  .prc .comment{margin:0;font-size:13px;line-height:1.5;max-width:64ch}
  .prc .portfolio{list-style:none;margin:0;padding:0;display:flex;gap:var(--s2);flex-wrap:wrap}
  .prc .shot{width:132px;height:96px;border:1px solid var(--outline);border-radius:8px;background:var(--sunken);
       display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:11px}
`;

const wrap = (inner) => `<style>${css}</style><div class="prc">${inner}</div>`;

const recipient = (email, tone, label, removable = false) =>
  `<li class="rcp">
     <span class="email">${email}</span>
     <span class="badge ${tone}">${label}</span>
     ${removable ? '<button class="remove">Remove</button>' : ""}
   </li>`;

export const CreateEntryPoint = {
  name: "1 · No RFP yet",
  parameters: {
    docs: { description: { story: "The entry point. It describes what the contractor's side looks like (a link, no account) and closes on the promise that nothing leaves until the owner says so — the send is the only irreversible step in this section, so the copy starts managing it here." } },
  },
  render: () =>
    wrap(`
      <section class="skip">
        <div>
          <p class="skip-t">Already have a contractor?</p>
          <p class="quiet">Skip the tender and go straight to the build plan. Procurement closes and this section stays here, read-only, as part of the record.</p>
        </div>
        <button class="btn">Skip to execution</button>
      </section>
      <section style="display:flex;flex-direction:column;gap:var(--s3);align-items:flex-start">
        <h3>Ask contractors to bid</h3>
        <p class="quiet">Describe the work, attach the drawings, and send it to as many contractors as you like. They reply with a price, a timeline and their portfolio — from a link, with no account to create. Nothing is sent until you say so.</p>
        <button class="btn primary">Create RFP</button>
      </section>
    `),
};

export const Composer = {
  name: "2 · Draft composer",
  parameters: {
    docs: { description: { story: "The draft. It says it is private in as many words, and the Send button is OFF with its reason beside it rather than greyed out in silence. Addresses arrive one at a time or as a pasted spreadsheet column — the parser lowercases and de-duplicates so one contractor never gets two tokens for one bid, and a typo stays in the box to be fixed instead of being swallowed." } },
  },
  render: () =>
    wrap(`
      <section style="display:flex;flex-direction:column;gap:var(--s3)">
        <div class="hd"><h3>Request for proposals</h3><span class="badge">Draft — not sent</span></div>
        <p class="quiet">Private until you send it. No contractor can see this — the invitation links do not exist yet.</p>

        <div class="field">
          <label class="label">The work</label>
          <textarea>New-build house, 210 m², Maple Street. Ground-up: groundworks, frame, roof, first fix. Priced to the drawings attached; exclusions stated please.</textarea>
        </div>

        <div class="field">
          <span class="label">Trades wanted</span>
          <ul class="tags">
            <li class="tag">groundworks <span aria-hidden="true">×</span></li>
            <li class="tag">roofing <span aria-hidden="true">×</span></li>
            <li class="tag">electrical <span aria-hidden="true">×</span></li>
          </ul>
          <div class="row">
            <input type="text" placeholder="groundworks, roofing, electrical…" />
            <button class="btn">Add trade</button>
          </div>
        </div>

        <div class="field">
          <div class="row" style="justify-content:space-between">
            <span class="label">Drawings &amp; documents</span>
            <button class="btn">Attach a file</button>
          </div>
          <ul class="files">
            <li class="file"><span class="fname">maple-street-plans-rev-C.pdf</span><span class="fmeta">4.2 MB</span></li>
            <li class="file"><span class="fname">site-survey.pdf</span><span class="fmeta">880 KB</span></li>
          </ul>
        </div>

        <div class="field">
          <span class="label">Send to (3)</span>
          <ul class="rcps">
            ${recipient("ana@obra.pt", "", "Invited", true)}
            ${recipient("joao@construcoes.pt", "", "Invited", true)}
            ${recipient("geral@edifica.pt", "", "Invited", true)}
          </ul>
          <textarea style="min-height:60px" placeholder="ana@obra.pt, joao@construcoes.pt — or paste a column from a spreadsheet"></textarea>
          <div class="row"><button class="btn">Add to list</button></div>
        </div>

        <div class="row">
          <button class="btn">Save draft</button>
          <button class="btn primary">Send to contractors</button>
        </div>
      </section>
    `),
};

export const ConfirmSend = {
  name: "3 · The send confirms in place",
  parameters: {
    docs: { description: { story: "The one-way door. It confirms in place rather than in a modal, so the recipient list it is about stays on screen behind the sentence — and it states both consequences: the brief freezes, and the links stay live until a constructor is chosen." } },
  },
  render: () =>
    wrap(`
      <div class="confirm">
        <p class="quiet">This emails 3 contractors a link to bid. The brief is frozen once it goes, and the links stay live until you choose a constructor.</p>
        <button class="btn">Not yet</button>
        <button class="btn primary">Send it</button>
      </div>
    `),
};

export const Inbox = {
  name: "4 · Proposals inbox",
  parameters: {
    docs: { description: { story: "After the send. The recipient list becomes a status board — Invited / Viewed / Proposal in / Declined, four words for the four states the column can hold — and each bid is a row that expands into the detail. The figures are QUOTED: the range prints as submitted and there is no total, no average and no ranking, because the owner ranks bids and we do not." } },
  },
  render: () =>
    wrap(`
      <section style="display:flex;flex-direction:column;gap:var(--s3)">
        <div class="hd"><h3>Request for proposals</h3><span class="badge good">Sent</span></div>
        <p class="quiet">This RFP is out with 4 contractors. The brief is frozen now: everyone must be bidding on the same words.</p>
        <div class="field">
          <span class="label">Send to (4)</span>
          <ul class="rcps">
            ${recipient("ana@obra.pt", "good", "Proposal in")}
            ${recipient("joao@construcoes.pt", "good", "Proposal in")}
            ${recipient("geral@edifica.pt", "live", "Viewed")}
            ${recipient("orcamentos@bmconstroi.pt", "off", "Declined")}
          </ul>
        </div>
      </section>

      <section style="display:flex;flex-direction:column;gap:var(--s3)">
        <div class="hd"><h3>Proposals</h3><span class="quiet">2 of 4 invited</span></div>
        <ul class="props">
          <li class="prop">
            <div class="prop-hd">
              <button class="disclose"><span class="caret">▾</span><span class="company">Obra Nova, Lda.</span></button>
              <span class="fig">$186,000 – $204,000</span>
              <span class="fig q">about 7 months</span>
            </div>
            <div class="prop-body">
              <p class="quiet">Submitted by ana@obra.pt</p>
              <p class="quiet">Received 12 Sep 2026</p>
              <p class="comment">Price excludes landscaping and the solar array. We can start the groundworks the first week of November.</p>
              <ul class="portfolio"><li class="shot">portfolio</li><li class="shot">portfolio</li><li class="shot">portfolio</li></ul>
              <button class="btn primary" style="align-self:flex-start">Select this constructor</button>
            </div>
          </li>
          <li class="prop">
            <div class="prop-hd">
              <button class="disclose"><span class="caret">▸</span><span class="company">Construções Silva</span></button>
              <span class="fig">$215,000</span>
              <span class="fig q">about 5 months</span>
            </div>
          </li>
        </ul>
        <p class="quiet">Still waiting on 1 contractor. Choosing now closes the tender and their links stop working.</p>
      </section>
    `),
};

export const Selected = {
  name: "5 · Chosen, and the losers kept",
  parameters: {
    docs: { description: { story: "The end state, and the one that carries the product's reason to exist. The chosen bid wears the owner hue AND the word 'Selected' — never colour alone. Every other proposal stays exactly where it was: 'who else did you ask, and what did they quote?' is the lookup this record is for, so losing bids are not archived, collapsed away or deleted." } },
  },
  render: () =>
    wrap(`
      <section style="display:flex;flex-direction:column;gap:var(--s3)">
        <div class="hd"><h3>Proposals</h3><span class="quiet">2 of 4 invited</span></div>
        <ul class="props">
          <li class="prop sel">
            <div class="prop-hd">
              <button class="disclose"><span class="caret">▸</span><span class="company">Obra Nova, Lda.</span></button>
              <span class="fig">$186,000 – $204,000</span>
              <span class="fig q">about 7 months</span>
              <span class="badge good">Selected</span>
            </div>
          </li>
          <li class="prop">
            <div class="prop-hd">
              <button class="disclose"><span class="caret">▸</span><span class="company">Construções Silva</span></button>
              <span class="fig">$215,000</span>
              <span class="fig q">about 5 months</span>
            </div>
          </li>
        </ul>
        <p class="quiet">A constructor is selected and the build has moved to execution. Every proposal stays here — including the ones not chosen — as the record of what was asked and what came back.</p>
      </section>
    `),
};
