# Deployment and configuration

The public frontend runs on Vercel; the API runs on Railway with one persistent SQLite volume. Hosting account links and production-specific infrastructure configuration remain local and are excluded from Git.

## Environment

The API needs:

```text
NODE_ENV=production
PORT=8787
DATABASE_PATH=/data/elo.sqlite
SERVICE_KEY=<private random service key, at least 32 characters>
```

The Next.js server needs:

```text
ELO_API_URL=https://<your-api-host>
ELO_SERVICE_KEY=<the same private service key>
```

Generate the key locally and enter it in each hosting provider's server environment settings. Never use a `NEXT_PUBLIC_` name, commit the value, or add it to GitHub pull-request workflows. Production requires HTTPS to the API. For local development, the template uses `http://127.0.0.1:8787`; the API creates its local database directory outside production. Neither app automatically loads a repository-root env file: export the variables into the process environment or use Node's `--env-file` option.

For example, after filling an ignored `.env.local`, start the API with `node --env-file=.env.local --import tsx apps/api/server.ts` and the frontend in another terminal with `node --env-file=.env.local apps/public/node_modules/next/dist/bin/next dev apps/public`. Use `http://localhost:3000` in development.

## Railway

Use the root `Dockerfile` and Node 24. Mount a persistent volume at `/data`, set the absolute `DATABASE_PATH`, and use `/health` for the health check. Keep one replica: the service uses SQLite WAL and immediate transactions; multiple independent replicas would require a coordinated database design. Keep the existing volume when redeploying.

The container entrypoint validates the database directory and sidecars, refuses unsafe links, and switches to uid/gid 1000 before loading the API. Application development dependencies are absent from the bundled runtime. Public `/v1` calls require service authentication; only `/health` is unauthenticated.

Select the intended project, environment and service with the Railway CLI before deploying. Recheck `railway status`; never reuse another operator's local directory links.

## Vercel

Set the root directory to `apps/public`, Node version to 24, and enable source files outside the root. `vercel.json` installs the root and frontend dependencies; `npm run build` generates the scoring kit and builds Next.js. Configure the two server environment variables above. Wire preview deployments to a separate test backend if needed; do not expose production credentials to untrusted previews.

The public brand/reference URLs currently target `computer-elo.vercel.app`. A fork using another domain must update `packages/public-api/scoring-guide.ts`, public profile metadata and reference links before publishing.

## Release checks

From the root, with Node 24:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix apps/public
npm run typecheck
npm run public:typecheck
npm test
npm run public:build
node --import tsx scripts/check-production-flows.ts
```

Deploy with each provider's CLI only after checking its selected account and project. GitHub CI runs local verification without provider credentials and does not deploy. Review the actual hosted result separately: `/health`, the public overview, the current completed UTC week, nonce-bearing HTML, share metadata/image, and modern/legacy MCP reference clients. A successful build does not prove that the live database or proxy is connected.

## Operations and limits

- Preserve the existing database and competition identity. Configure volume backups and rehearse restoration; persistence alone is not a backup.
- Changed scores are capped at five per account/week; identical aggregates are idempotent. Entering either queue locks the week's Form, even after cancellation. A player may match once per mode per week.
- The server owns Elo state and ignores uploaded ratings. Low-confidence matches cannot change ratings. Receipts and match state are written atomically and can be replayed.
- Browser sessions are long-lived bearer credentials. Recovery-key rotation revokes the old key; sign-out only clears one browser. Losing both the session and recovery key loses account access.
- API/MCP application rate limits are bounded but local to the serving process. Configure provider-level rate limiting for public traffic. Limits are not proof of unique people or truthful scores.
- Run container vulnerability scanning and browser-native QA separately from unit/integration checks. Keep production state snapshots, scan output and deployment receipts in ignored `artifacts/`.

See [SECURITY.md](../SECURITY.md), [API behavior](../apps/api/README.md), [test coverage](testing.md), and [the AI reference contract](ai-reference.md).
