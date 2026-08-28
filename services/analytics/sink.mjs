// Analytics sinks — where shaped events actually go (LINA-55).
//
// A sink is the ONE seam that touches an SDK/network. The domain services and
// the analytics facade never import a sink directly; they receive one, so the
// same instrumentation runs against an in-memory array in tests and against
// PostHog in prod without a line of domain code changing.
//
// Sink contract (all methods best-effort, MUST NOT throw to the caller):
//   capture({ event, distinctId, properties, groups }) -> void
//   identify({ distinctId, properties }) -> void
//   groupIdentify({ groupType, groupKey, properties }) -> void
//   flush() -> Promise<void>   (drain buffered events; for serverless shutdown)

// ── Memory sink — deterministic, network-free, for tests + local audit ───────
export function createMemorySink() {
  const captures = [];
  const identifies = [];
  const groups = [];
  return {
    captures,
    identifies,
    groups,
    capture(e) { captures.push(e); },
    identify(e) { identifies.push(e); },
    groupIdentify(e) { groups.push(e); },
    async flush() {},
    // convenience for assertions
    byEvent(name) { return captures.filter((c) => c.event === name); },
    reset() { captures.length = 0; identifies.length = 0; groups.length = 0; },
  };
}

// ── Noop sink — the safe default when analytics isn't configured ─────────────
// Wiring is always present in the services; with no PostHog key we simply drop
// events. This keeps `analytics` a non-optional dependency of the domain code
// (so it's always exercised) while making a missing key a no-op, never a crash.
export function createNoopSink() {
  return {
    capture() {},
    identify() {},
    groupIdentify() {},
    async flush() {},
  };
}

// ── PostHog sink — zero-dependency HTTP capture (server-side, §2.1 group A) ───
// Uses the public PostHog capture API over `fetch` so we add no dependency to a
// codebase that is otherwise `pg`-only. Events are buffered and flushed in a
// single `/batch/` request. All I/O is best-effort: a PostHog outage or a slow
// network can never fail or slow a domain write (§ reliability). The caller is
// expected to `await flush()` at the end of a request/invocation.
//
// distinct_id is the authenticated party_id — the caller (server) supplies it;
// the client actor-switcher can never reach this sink (§2.1 actor caveat).
export function createPosthogSink({
  apiKey,
  host = 'https://us.i.posthog.com',
  fetchImpl = globalThis.fetch,
  flushAt = 20,
  onError = () => {},
} = {}) {
  if (!apiKey) throw new Error('createPosthogSink requires an apiKey (PostHog project API key)');
  const endpoint = `${host.replace(/\/$/, '')}/batch/`;
  let buffer = [];

  function enqueue(payload) {
    buffer.push(payload);
    if (buffer.length >= flushAt) {
      // Fire and forget; errors are swallowed via flush()'s own catch.
      void flush();
    }
  }

  // Map our sink contract onto PostHog's batch payload shape.
  function capture({ event, distinctId, properties, groups }) {
    enqueue({
      event,
      distinct_id: distinctId,
      properties: { ...properties, ...(groups ? { $groups: groups } : {}) },
    });
  }

  function identify({ distinctId, properties }) {
    enqueue({ event: '$identify', distinct_id: distinctId, properties: { $set: properties } });
  }

  function groupIdentify({ groupType, groupKey, properties }) {
    enqueue({
      event: '$groupidentify',
      // PostHog convention: group-identify is keyed on the group itself.
      distinct_id: `${groupType}_${groupKey}`,
      properties: { $group_type: groupType, $group_key: groupKey, $group_set: properties },
    });
  }

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, batch }),
      });
    } catch (err) {
      // Never propagate: analytics is best-effort. Surface for logs only.
      onError(err);
    }
  }

  return { capture, identify, groupIdentify, flush };
}
