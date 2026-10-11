'use client';

// The Basics-step form body (M2/D2, step 1 of 3).
//
// A client component only because it lives inside ActionForm, which owns the
// `footer` render-prop (LINA-219) that puts the Back / Continue nav BELOW the
// card while keeping the button the form's real submit with the live `pending`
// flag. A render-prop is a function, and a function cannot cross the
// server→client boundary as a prop — so the ActionForm caller must itself be a
// client component (LINA-231). This mirrors InvitePanel and OperatingModelPicker;
// Basics was the lone step inlining ActionForm in its server page, which is what
// crashed `/projects/new/basics` with the RSC "Functions cannot be passed
// directly to Client Components" error.
//
// The server page still owns everything server-only (auth gate, the role choice,
// and the request-time month list) and hands it here as serializable props.
import { WizardNav, ArrowRight } from '@/components/WizardNav';
import { ActionForm } from '@/components/ActionForm';
import { createBuildAction } from '@/app/actions';
import { BUILD_TYPES, BASICS_LEDE, type CreatorRole } from '@/lib/build-creation';

export function BasicsForm({ creatorRole }: { creatorRole: CreatorRole }) {
  return (
    <ActionForm
      action={createBuildAction}
      submitLabel="Continue"
      pendingLabel="Creating…"
      footer={({ pending }) => (
        <WizardNav back={{ href: '/projects/new' }}>
          <button type="submit" className="btn primary" disabled={pending} aria-busy={pending}>
            {pending ? 'Creating…' : 'Continue'}
            <ArrowRight />
          </button>
        </WizardNav>
      )}
    >
      {/* The creator role chosen on the "Your role" screen. The server action
          validates it and the service defaults/validates again — this field is
          a carrier, never trusted as a membership claim. */}
      <input type="hidden" name="creatorRole" value={creatorRole} />

      <section className="bwx-card">
        <h1 className="bwx-card-title">What are we building?</h1>
        <p className="bwx-card-sub">{BASICS_LEDE[creatorRole]}</p>

        <label className="field">
          <span className="metric-lbl">Build name</span>
          <input
            name="name"
            type="text"
            required
            maxLength={200}
            autoComplete="off"
            placeholder="Casa da Encosta — Sintra"
          />
        </label>

        <label className="field">
          <span className="metric-lbl">Address</span>
          <input
            name="siteAddress"
            type="text"
            maxLength={300}
            autoComplete="off"
            placeholder="Rua da Encosta 14, 2710 Sintra"
          />
        </label>

        {/* Municipality code (GAP-1, LINA-365). REQUIRED by the v2 project brief
            (`municipality_code`) — the build's filing jurisdiction. The v1 wizard
            never collected it; v2 refuses a blank rather than store a placeholder,
            so the field is `required` here and the server action validates again. */}
        <label className="field">
          <span className="metric-lbl">Municipality code</span>
          <input
            name="municipalityCode"
            type="text"
            required
            maxLength={20}
            autoComplete="off"
            placeholder="1111"
          />
        </label>

        {/* PRD-03 R-3: where exactly — optional. With a point, "find companies
            near this build" measures distances; without it the municipality is
            used. Decimal degrees, both or neither (validated by the action). */}
        <div className="bwx-row2">
          <label className="field">
            <span className="metric-lbl">Latitude (optional)</span>
            <input name="locationLat" type="text" inputMode="decimal" maxLength={12} autoComplete="off" placeholder="38.8029" />
          </label>
          <label className="field">
            <span className="metric-lbl">Longitude (optional)</span>
            <input name="locationLng" type="text" inputMode="decimal" maxLength={12} autoComplete="off" placeholder="-9.3817" />
          </label>
        </div>

        <label className="field">
          <span className="metric-lbl">Build type</span>
          <select name="buildType" defaultValue="">
            <option value="">Choose a type…</option>
            {BUILD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {/* PRD-09 O-13: a GC creates the build FOR its owner — the owner's email
            is persisted (on_behalf_of_owner_email, doc 14 Q4) and they claim
            the build by signing in with it. The owner path asks nothing more. */}
        {creatorRole === 'counterparty' && (
          <label className="field">
            <span className="metric-lbl">Owner&rsquo;s email</span>
            <input name="ownerEmail" type="email" required maxLength={254} autoComplete="off" placeholder="owner@example.com" />
          </label>
        )}
      </section>
    </ActionForm>
  );
}
