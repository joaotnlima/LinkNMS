#!/usr/bin/env node
// Build a Paperclip create-agent POST body from an AGENTS.md file.
// Usage: node .claude/helpers/pc-build-agent.mjs <agentsMdFile> <outFile>
import { readFile, writeFile } from 'node:fs/promises';
const [, , mdFile, outFile] = process.argv;
const instructions = await readFile(mdFile, 'utf8');
const payload = {
  name: 'Product Designer',
  role: 'designer',
  title: 'Product Designer',
  icon: 'wand',
  reportsTo: process.env.PAPERCLIP_AGENT_ID,
  capabilities:
    'Owns how LinkNMS looks and feels: designs end-to-end flows for the shared record (capture a decision, file a change order, see budget impact, reconstruct history), produces wireframes/mockups/prototypes, owns and evolves the LinkNMS design system and brand-consistent UI (House Record mark, "Trust built-in." tagline), runs usability validation with real personas (esp. low-tech on-site users), and hands developers build-ready specs. Reports to the Chief of Staff (CEO). No agent-creation or release-authorization rights.',
  adapterType: 'claude_local',
  adapterConfig: {
    cwd: process.env.PAPERCLIP_WORKSPACE_CWD || '/Users/joaocosta/projects/linkNMS',
  },
  permissions: { canCreateAgents: false, canCreateSkills: false },
  desiredSkills: [
    'paperclipai/paperclip/paperclip',
    'chiroro-jr/skills/pencil-design',
    'paperclipai/bundled/product/wireframe',
    'paperclipai/optional/product/design-critique',
    'vercel-labs/agent-skills/web-design-guidelines',
  ],
  instructionsBundle: { files: { 'AGENTS.md': instructions } },
  runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
  sourceIssueId: process.env.PAPERCLIP_TASK_ID,
};
await writeFile(outFile, JSON.stringify(payload));
console.log('wrote', outFile, 'bytes', JSON.stringify(payload).length);
