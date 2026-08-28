// Public surface of the R0 analytics module (LINA-55).
// Instruments the LINA-28 §2.3 Group-A server-side domain-write spine.
export { createAnalytics, createNoopAnalytics } from './analytics.mjs';
export { createMemorySink, createNoopSink, createPosthogSink } from './sink.mjs';
export { analyticsFromEnv } from './config.mjs';
export { EVENTS, SURFACE, ROLE, assertNoPii, hoursBetween, AnalyticsContractError } from './events.mjs';
