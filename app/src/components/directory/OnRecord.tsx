// "On the record" (PRD-03 R-11, R-12): counted by the directory's read model
// from contract, task and change-order events — never from what the company
// states. Builds show state and dates; a build's name only where its owner
// consented; amounts never.
import {
  buildStateLabel, formatDay, type V2DirectoryBuild, type V2OnRecord,
} from '@/lib/v2/directory-view';

export function OnRecord({ record, builds }: { record: V2OnRecord; builds: V2DirectoryBuild[] }) {
  return (
    <section className="sec2" aria-labelledby="on-record">
      <h2 id="on-record">On the record</h2>
      <p className="cap">Counted from builds on LinkNMS that both sides can see. Not reviews — facts from the shared record.</p>
      {!record.ranked ? <p className="cap"><b>No verified clients yet.</b> No client has signed a contract with this company on LinkNMS.</p> : null}
      <div className="stats">
        <div className="stat"><b>{record.verified_clients}</b><span>verified clients (signed a contract here)</span></div>
        <div className="stat"><b>{record.builds}</b><span>builds with a signed contract</span></div>
        <div className="stat"><b>{record.tasks_on_time} of {record.tasks_finished}</b><span>tasks finished on the planned date</span></div>
        <div className="stat"><b>{record.change_orders_raised}</b><span>change orders raised · {record.change_orders_approved} approved</span></div>
      </div>
      {builds.length ? (
        <div className="card">
          {builds.map((b, i) => {
            const st = buildStateLabel(b.state);
            return (
              <div key={i} className="lrow">
                <div className="l1"><span>{b.name ?? 'A build on LinkNMS'}</span><span className={`badge ${st.tone}`}>{st.text}</span></div>
                <div className="l2">
                  Contract signed {formatDay(b.signed_on)}
                  {b.finished_on ? ` · finished ${formatDay(b.finished_on)}` : ''}
                  {b.tasks_finished ? ` · ${b.tasks_on_time} of ${b.tasks_finished} tasks on the planned date` : ''}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      <p className="cap">Build names show only when the owner allows it. Amounts are never shown here.</p>
    </section>
  );
}
