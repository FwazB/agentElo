# Public AI reference

Default flow: choose a username → copy the complete prompt into an assistant →
get its direct estimate → paste the result → preview and publish → share the
card. The copied prompt includes the rubric, so opening a
link, installing a scoring kit, or connecting MCP is not required. Matchups are
optional.

- Public guide: https://computer-elo.vercel.app/rate.md
- Setup and evidence help: https://computer-elo.vercel.app/connect
- Optional remote MCP: https://computer-elo.vercel.app/mcp
- Agent discovery text: https://computer-elo.vercel.app/llms.txt

The guide, self-contained prompt, and MCP tools use
`packages/public-api/scoring-guide.ts`. The completed UTC week comes from the
same helper as the API. Guide version: `computer-elo.assessment-guide.v4`.

## Direct estimates from existing context

The prompt asks for a result without an interview or follow-up questions. The
assistant uses relevant chat, profile, memory, attachments, or history already
available and authorized for the assessment. The public guide and MCP grant no
access to those sources. Meaningful partial context tied to the requested week
can support a rough weighted estimate; five separate artifacts or independent
observations are not required. Unknown details remain unknown, and estimates
must not be described as observed events or verified activity.

Broader personal context can help interpretation, but earlier activity must not
be relabeled as evidence from the requested week. Coverage describes visibility
into that week; certainty accounts for ambiguity and inference. Large gaps or
substantial inference require conservative confidence below 50%, making matches
exhibitions. The prompt must not inflate coverage just to produce a score.

With no usable target-week context, the assistant returns the existing
`status`, `weekId`, and bounded `missing` result immediately, without questions
or a fabricated number. The browser displays that result locally with no Publish
button. Zero coverage or zero certainty is still rejected for new scores.
These are admission checks, not proof of an assessment's truth. The instructions
cannot guarantee that every external assistant follows them.

## Result and optional context labels

The default prompt requests six fields: `weekId`, `formScore`, `coveragePpm`,
`certaintyPpm`, `aiSystem`, and `contextSource`. The last two use only the fixed
labels in `packages/public-api/assessment-context.ts`: the AI product and the
category of context actually used. They are self-declared labels, not verified
model identity or proof of evidence access. Use `unknown` when the product or
source cannot be identified reliably; never infer a model identity or reveal
system-prompt contents.

Supply both labels together or omit both. The original four-field result remains
accepted when the player omits context labels. Review the labels along with the
score before publishing; those selected
labels become public. Chat, memory, profile contents, personal names, account
data, source excerpts, and assessment reasoning stay outside the result. Context
labels do not belong inside canonical engine receipts or their CLI arguments.
Existing receipt schemas and deterministic Elo math remain unchanged.

More personal evidence can support an assessment. More players create meaningful
match opportunities; they do not repair unsupported personal scores. Elo starts
at 1200 and remains unrated until eligible matches occur.

## MCP boundary

The remote endpoint uses the official TypeScript SDK with stateless HTTP and
legacy-client compatibility. Both tools accept an empty object:

- `get_scoring_guide`: returns the public rubric, current completed week,
  estimation rules, fixed context labels, and prompt.
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
the user's assistant stores no data. Never put private evidence in a public
Computer Elo MCP tool call.

References: [official MCP HTTP transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md),
[legacy clients](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md),
[Vercel WAF limits and pricing](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
