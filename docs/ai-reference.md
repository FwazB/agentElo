# Public AI reference

Default flow: choose a username → copy the complete prompt into an assistant →
answer any missing-context questions → paste its final result → preview and
publish → share the card. The copied prompt includes the rubric, so opening a
link, installing a scoring kit, or connecting MCP is not required. Matchups are
optional.

- Public guide: https://computer-elo.vercel.app/rate.md
- Setup and evidence help: https://computer-elo.vercel.app/connect
- Optional remote MCP: https://computer-elo.vercel.app/mcp
- Agent discovery text: https://computer-elo.vercel.app/llms.txt

The guide, self-contained prompt, follow-up prompt, and MCP tools use
`packages/public-api/scoring-guide.ts`. The completed UTC week comes from the
same helper as the API. Guide version: `computer-elo.assessment-guide.v3`.

## Evidence before scoring

The assistant first reviews relevant dated evidence already shared or explicitly
authorized for the assessment. It should not ask again for context it already
has. One concrete recap can support all five dimensions; multiple tools or
conversations are not required. A recap remains self-attested evidence.
The public guide and MCP connection grant no access to that activity. Every
dimension needs a basis: output, focus, leverage, verification, and hygiene.
Unobserved behavior is unknown; it must not be assigned a default score.

When evidence is missing, the assistant asks up to three concrete questions in
normal language, waits for the user, then resumes. With no usable context, it
asks for a short dated recap covering the five dimensions. It must not return
result JSON while gathering evidence or demand evidence already available.

Only when the user asks to finish without enough evidence, declines the follow-up,
or cannot provide the remaining context after a follow-up does the assistant
return `status`, `weekId`, and a bounded `missing` list. There is no numerical
score. If that result is pasted into the site, the browser shows the missing
areas and a **Copy follow-up** action to resume the conversation with targeted
questions and the complete rubric. It offers no Publish button. A new or edited
result clears any previously valid preview. Private recaps stay with the user's
assistant; the website accepts only the final bounded JSON.

A grounded result contains only `weekId`, `formScore`, `coveragePpm`, and
`certaintyPpm`. Zero coverage or zero certainty is rejected by the browser and
API for new submissions, including canonical receipt imports. This is a minimum
admission check, not proof that an assessment is truthful. Positive confidence
below 50% stays publishable and exhibition-only. Existing deterministic Elo
math and archived receipts are unchanged.

More personal evidence can support an assessment. More players create meaningful
match opportunities; they do not repair unsupported personal scores. Elo starts
at 1200 and remains unrated until eligible matches occur.

## MCP boundary

The remote endpoint uses the official TypeScript SDK with stateless HTTP and
legacy-client compatibility. Both tools accept an empty object:

- `get_scoring_guide`: returns the public rubric, current completed week,
  evidence requirements, and prompt.
- `get_assessment_prompt`: returns that week's assessment prompt.

No authentication or recovery key is needed. There are no history, account,
assessment-upload, arbitrary URL, file-read, or publishing tools. The MCP handler
has no database or Railway connection. Client cookies and authorization headers
are not passed to the protocol handler. Errors use fixed public text.

Requests have a 16 KB body limit and five-second upload deadline. Exact host and
origin checks reject foreign origins; native clients may omit Origin. Batches,
subscriptions, unknown methods, nonempty tool arguments, and non-POST transport
requests are rejected. The application rate-limit map is bounded and per instance.
Provider-level rate limiting must be configured separately for a deployment;
the repository does not provision a firewall or change a hosting plan. Native
MCP clients should receive HTTP 429 rather than browser challenges.

See [security](../SECURITY.md) and [testing](testing.md). Platform
request metadata still exists; this is not a claim that third-party hosting or
the user's assistant stores no data. Never put private evidence in a tool call.

References: [official MCP HTTP transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md),
[legacy clients](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md),
[Vercel WAF limits and pricing](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
