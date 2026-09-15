# Security

Report vulnerabilities privately to the repository owner. Use GitHub private vulnerability reporting when enabled; otherwise contact the maintainer before sending sensitive details. Do not put recovery keys, service credentials, private assessments, or production database contents in public issues.

## Repository boundary

Only application source, dependency locks, synthetic protocol fixtures, font assets with their licenses, and public documentation belong in Git. Environment files, hosting links, production-specific infrastructure state, SQLite files, activity exports, local reports/screenshots, and generated kit archives stay local. `.env.example` contains empty credential placeholders only.

Install [Gitleaks](https://github.com/gitleaks/gitleaks) and enable this repository's checks:

```sh
git config --local core.hooksPath .githooks
npm run repo:check
npm run security:secrets
```

The commit hook scans staged changes; the push hook scans secrets and forbidden paths throughout reachable history, including files later deleted. Hooks can be bypassed, so CI independently repeats both checks. CI has read-only permissions, uses pinned action commits and a checksum-verified secret scanner, and receives no deployment credentials. Dependency updates are proposed through Dependabot and require review.

After creating the GitHub repository, enable secret scanning/push protection and private vulnerability reporting where available, protect `main` with the Checks job, and require owner review. These remote settings must be verified separately; repository files do not enable them. Follow [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## Application boundary

Accepted assessment payloads contain weekly aggregates and optional fixed AI product/context-source labels, never the underlying chat, profile, memory or activity. The server derives ownership from a hashed recovery credential, uses parameterized SQL and atomic match transactions, and controls rating changes. Same-origin checks protect cookie-authenticated writes. The public MCP provides two reference tools with no account, evidence-upload, file, or arbitrary-URL access. Keep service credentials in server environment variables, never `NEXT_PUBLIC_*` variables.

Recovery keys are long-lived bearer credentials. Rotation revokes the old key; browser sign-out only clears that browser. Scores are self-attested and free accounts are not proof of a unique person. Content fingerprints are integrity checks, not signatures or anti-cheat guarantees.

Dependency and secret scans identify known patterns, not all vulnerabilities. Container scanning, browser-native checks, load testing and production backup restoration are separate operator responsibilities. See [testing](docs/testing.md) and [deployment](docs/public-deployment.md).
