import { PostHog } from 'posthog-node';

export async function capture(
  event: string,
  distinctId: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

  if (!key || !host) {
    if (process.env.NODE_ENV === 'development') {
      const missingVariable = !key
        ? 'NEXT_PUBLIC_POSTHOG_KEY'
        : 'NEXT_PUBLIC_POSTHOG_HOST';
      throw new Error(
        `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`
      );
    }
    return;
  }

  const posthog = new PostHog(key, {
    host,
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true
  });

  try {
    posthog.capture({ distinctId, event, properties });
    await posthog.shutdown();
  } catch {}
}
