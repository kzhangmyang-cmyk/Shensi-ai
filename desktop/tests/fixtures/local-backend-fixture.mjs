import { createServer } from 'node:http';

const mode = process.env.FIXTURE_MODE;
if (mode === 'exit') process.exit(2);
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, store: mode === 'memory' ? 'memory' : 'mysql',
      reference: { mode: process.env.SHENSI_REFERENCE_MODE ?? null, path: process.env.SHENSI_REFERENCE_PACK ?? null,
        sha256: process.env.SHENSI_REFERENCE_PACK_SHA256 ?? null },
      inheritedSecret: process.env.SHENSI_TEST_PARENT_SECRET ?? null }));
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => {
    console.log(`GoodJob CRM API listening on http://127.0.0.1:${process.env.PORT}`);
    if (mode === 'crash') setTimeout(() => process.exit(2), 100);
  });
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
