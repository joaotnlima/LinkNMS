// Download Rev 2 artifacts from LINA-20 and re-upload to LINA-12.
let base = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
const KEY = process.env.PAPERCLIP_API_KEY;
const RUN = process.env.PAPERCLIP_RUN_ID;
const CO = process.env.PAPERCLIP_COMPANY_ID;
const L12 = 'e3bc98ad-1764-4023-8c72-945825b22f30';
const auth = { Authorization: `Bearer ${KEY}` };

const artifacts = [
  { att: '7db04c4a-c12d-47b0-924f-7d371c3e2d6f', name: 'r0-shared-record-flow.png', type: 'image/png' },
  { att: '2db55e54-5300-4347-b95f-7e0a304e68c2', name: 'r0-shared-record-flow.html', type: 'text/html' },
];

for (const a of artifacts) {
  const dl = await fetch(`${base}/api/attachments/${a.att}/content`, { headers: auth });
  const buf = Buffer.from(await dl.arrayBuffer());
  console.log(`downloaded ${a.name}: ${dl.status} ${buf.length} bytes`);
  if (!dl.ok) { console.log('  download failed, skipping'); continue; }

  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: a.type }), a.name);
  const headers = { ...auth };
  if (RUN) headers['X-Paperclip-Run-Id'] = RUN;
  const up = await fetch(`${base}/api/companies/${CO}/issues/${L12}/attachments`, {
    method: 'POST', headers, body: fd,
  });
  const t = await up.text();
  console.log(`  uploaded to L12: ${up.status} ${t.slice(0, 300)}`);
}
