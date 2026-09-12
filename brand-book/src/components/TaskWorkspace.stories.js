export default {
  title: "Components/Task workspace",
  parameters: {
    docs: {
      description: {
        component:
          "The conversation and the files on one plan task — the drawer section behind every task's own URL (`/projects/:id/plan/tasks/:stageKey`). APPEND-ONLY, AND IT LOOKS IT: there is no edit pencil and no delete on a comment or a file, because there is neither in the API — the tables carry SELECT and INSERT grants and nothing else, so a correction is a new comment and the thread stays an honest record of what was said when. Authors are named from the project's members (the row stores a party id only), so a renamed party is renamed on every comment they ever left; the relative time is orientation and the exact timestamp is the `title`. A task that is not saved yet has no address to hang a thread off, so it says so rather than collecting comments locally that a reload would swallow — and the file rail states the server's limits (images, PDFs, office documents, 10 MB) rather than pre-judging a file the server will sniff anyway. Implemented at app/src/components/TaskWorkspace.tsx (LINA-250; API LINA-249, docs/architecture/slice-task-workspace-contract.md).",
      },
    },
  },
};

const css = `
  .tw{max-width:440px;display:flex;flex-direction:column;gap:var(--s3);
      border-top:1px solid var(--outline);padding-top:var(--s3)}
  .tw h3{margin:0;font-size:14px;font-weight:700}
  .tw h4{margin:0;font-size:13px;font-weight:650}
  .tw .quiet{margin:0;color:var(--muted);font-size:12px;line-height:1.5;max-width:52ch}
  .tw .thread{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s3)}
  .tw .cmt{display:flex;gap:var(--s2);align-items:flex-start}
  .tw .av{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
          width:22px;height:22px;border-radius:50%;font-size:10px;font-weight:700}
  .tw .av.owner{background:var(--owner-muted);color:var(--owner-fg)}
  .tw .av.builder{background:var(--builder-muted);color:var(--builder-fg)}
  .tw .hd{margin:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px}
  .tw .who{font-weight:650}
  .tw .role,.tw .when{color:var(--muted);font-size:11px}
  .tw .text{margin:0;font-size:13px;line-height:1.5;white-space:pre-wrap}
  .tw textarea{min-height:84px;font:inherit;line-height:1.5;color:var(--fg);border:1px solid var(--outline);
               background:var(--paper);border-radius:8px;padding:8px 10px;width:100%;box-sizing:border-box}
  .tw .foot{display:flex;align-items:center;justify-content:space-between;gap:var(--s2)}
  .tw .hint{color:var(--muted);font-size:11px;max-width:34ch}
  .tw .files{display:flex;flex-direction:column;gap:var(--s2)}
  .tw .fhd{display:flex;align-items:center;justify-content:space-between;gap:var(--s2)}
  .tw .flist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
  .tw .file{display:flex;flex-direction:column;gap:1px;border:1px solid var(--outline);
            border-radius:8px;background:var(--sunken);padding:6px 10px}
  .tw .fname{font-size:13px;font-weight:600;color:var(--fg)}
  .tw .fmeta{color:var(--muted);font-size:11px}
`;

const comment = (initials, tone, name, role, when, text) =>
  `<li class="cmt">
     <span class="av ${tone}" title="${name} · ${role}">${initials}</span>
     <div>
       <p class="hd"><span class="who">${name}</span><span class="role">${role}</span><span class="when">${when}</span></p>
       <p class="text">${text}</p>
     </div>
   </li>`;

export const Thread = {
  name: "Thread & composer",
  render: () =>
    `<style>${css}</style>
     <section class="tw">
       <h3>Conversation &amp; files</h3>
       <ol class="thread">
         ${comment("NF", "builder", "Nuno Ferreira", "General contractor", "3 h ago",
           "Groundworks start Monday — the survey is attached.")}
         ${comment("MA", "owner", "Marta Almeida", "Owner", "42 min ago",
           "Noted. Can we keep the old oak? I'd rather work around it than take it out.")}
       </ol>
       <div>
         <label class="hd" for="bb-c">Add a comment</label>
         <textarea id="bb-c" placeholder="Ask a question, note what changed on site, flag what you need."></textarea>
         <div class="foot" style="margin-top:8px">
           <span class="hint">Comments cannot be edited or deleted — a correction is a new comment.</span>
           <button class="btn primary">Comment</button>
         </div>
       </div>
     </section>`,
};

export const Files = {
  name: "Files",
  render: () =>
    `<style>${css}</style>
     <section class="tw">
       <div class="files">
         <div class="fhd"><h4>Files</h4><button class="btn">Attach a file</button></div>
         <ul class="flist">
           <li class="file">
             <a class="fname" href="#">site-survey-rev-b.pdf</a>
             <span class="fmeta">1.4 MB · Nuno Ferreira · yesterday</span>
           </li>
           <li class="file">
             <a class="fname" href="#">foundation-setout.png</a>
             <span class="fmeta">820 KB · Marta Almeida · 3 days ago</span>
           </li>
         </ul>
       </div>
     </section>`,
};

export const QuietStates = {
  name: "Empty & unsaved",
  render: () =>
    `<style>${css}</style>
     <div class="row" style="gap:24px;align-items:flex-start;flex-wrap:wrap">
       <section class="tw">
         <h3>Conversation &amp; files</h3>
         <p class="quiet">No comments yet. Anything written here is visible to everyone on the build.</p>
         <p class="quiet">No files yet. Images, PDFs and office documents up to 10 MB.</p>
       </section>
       <section class="tw">
         <h3>Conversation &amp; files</h3>
         <p class="quiet">
           Save the plan to start the conversation. Comments and files live on the task once it is
           saved — until then there is nothing for them to hang on.
         </p>
       </section>
     </div>`,
};
