// Minimal server-side PostHog capture (EU cloud) for the waitlist funnel events.
// No SDK — a single fetch to the capture endpoint, guarded by env so it's a
// no-op when PostHog isn't configured.
export async function capture(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com';
  try {
    await fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: distinctId,
        properties: { ...properties, $lib: 'linknms-site-server' }
      })
    });
  } catch {
    // analytics must never break the request
  }
}
