# Testing

Use Node 24 and install the root and frontend lockfiles. `npm test` covers the rating engine, API, proxy, MCP reference, evidence contract, private LAN app, and public modal flows. Typechecks and an optimized production build are separate checks.

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix apps/public
npm run typecheck
npm run public:typecheck
npm test
npm run public:build
node --import tsx scripts/check-production-flows.ts
```

The build requires `zip`. Production integration uses `openssl`, ephemeral loopback ports, temporary certificates, random test credentials and disposable SQLite files. It starts the compiled Next.js app and a real HTTPS API, then tests signup, publish, matching, replay, cards, recovery, outage, logout and database restart. It never writes to the production league.

API tests include four independent SQLite processes contending for names, imports and match slots; SQL-trigger failure injection; corruption rejection; key-rotation races; and body upload limits. Engine tests replay fixed fingerprints and SVGs, compare rounding to a BigInt oracle, and check seeded symmetry, conservation and confidence boundaries. Fixture IDs and scores are synthetic.

The DOM suite mounts React with actual events, state and effects. HTTP is mocked and missing dialog methods are minimally polyfilled. It covers deferred responses, recovery-key protection, score previews, queue polling, cleanup, focus restoration and route changes. It does not establish hydration, visual layout, browser clipboard permissions, native focus trapping or cookie enforcement. The compiled integration transports cookies manually and checks their security attributes.

For a local rendered social-card check, run `node --import tsx scripts/check-public-render.ts` after building. Optional offline engine PNG commands additionally need `rsvg-convert` from librsvg. Test reports and generated images belong in ignored `artifacts/`.

CI also scans Git history with Gitleaks, checks the tracked-file boundary, and audits dependency locks. Container scans, live-provider configuration, capacity testing, native-browser QA, and production backup restoration remain distinct evidence.
