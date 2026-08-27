import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(appDir, '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API route handlers import the domain services from `<repo>/services`,
  // which lives OUTSIDE this Next root (the services are framework-agnostic and
  // tested with `node --test`, so they deliberately do not live under app/).
  // Next must therefore trace and bundle files from the repo root, not just from
  // app/, or the serverless functions ship without their service code.
  //
  // ⚠️ DEPLOY: the Vercel project has Root Directory = `app`. This setting only
  // covers the build; the project ALSO needs "Include source files outside of
  // the Root Directory in the Build Step" enabled, or `../services` is not even
  // uploaded. That is an Architect-owned project setting — see the LINA-56 PR.
  outputFileTracingRoot: repoRoot,

  // `pg` is a Node driver with optional native/dynamic requires; leaving it
  // external keeps the bundler from trying to statically resolve them.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
