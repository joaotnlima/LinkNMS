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

  // `services/ledger/db.mjs` does `import pg from 'pg'`, and webpack resolves a
  // bare specifier from the IMPORTING file's directory — <repo>/services/…,
  // which has no node_modules of its own and never will: Vercel's Root Directory
  // is `app`, so the install only ever happens there. Without this alias the
  // production build dies with "Can't resolve 'pg'" even though `pg` is a
  // dependency of app/package.json and sitting in app/node_modules.
  //
  // Aliasing (rather than widening resolve.modules) is deliberate: it pins the
  // driver to the one copy the app declares, so the services can never be built
  // against a second, differently-versioned `pg` that happens to be hoisted
  // somewhere above the repo.
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      pg: path.join(appDir, 'node_modules', 'pg'),
    };
    return config;
  },
};

export default nextConfig;
