# Public AI reference

Default flow: choose a username → copy the complete prompt into an assistant →
get its direct estimate → paste the result → preview and publish → share the
card. The copied prompt includes the rubric, so opening a
link, installing a scoring kit, or connecting MCP is not required. Matchups are
optional.

- Public guide: https://antislop.org/rate.md
- AntiSlop entry preparation: https://antislop.org/entry.md
- Setup and evidence help: https://antislop.org/connect
- Optional remote MCP: https://antislop.org/mcp
- Agent discovery text: https://antislop.org/llms.txt

The guide, self-contained prompt, and MCP tools use
`packages/public-api/scoring-guide.ts`. The completed UTC week comes from the
same helper as the API. Guide version: `computer-elo.assessment-guide.v4`.

## Choose a workflow

The same remote MCP connection supports two workflows in Claude and other
compatible AI clients:

- **Weekly Computer Form:** use `get_assessment_prompt` or the native MCP prompt
  `assess_week`. The assistant assesses the completed UTC week using context the
  user has authorized. The user brings the result to the site to preview and
  choose whether to publish.
- **AntiSlop entry preparation:** use `get_entry_prompt` or the native MCP prompt
  `prepare_antislop_entry`. The assistant prepares an evidence draft from work
  the user chooses to share. Preparation does not submit an entry, verify its
  evidence, assign a rating, or publish anything. The user reviews the draft
  before any separate submission flow.

No MCP client is required: open `/rate.md` or `/entry.md` and use the instructions
with an assistant. The MCP serves instructions; it does not transfer the user's
history between AI products or give a new assistant context from another one.

## Connect a client

- Server URL: `https://antislop.org/mcp`
- Transport: **Streamable HTTP** (called **HTTP** in some clients)
- Authentication: **none**. Leave API keys, headers, and OAuth credentials empty.

Never use a Computer Elo recovery key for a connector.

### Claude web or Desktop

Open **Customize → Connectors → + → Add custom connector**, name it Computer Elo,
and paste the server URL. Leave OAuth settings empty and add the connector, then
enable it in the conversation. A Team or Enterprise owner may need to add it to
the organization first. See [Claude's connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### Claude Code

Run this from the project where you want the connector:

```sh
claude mcp add --transport http computer-elo https://antislop.org/mcp
```

Use `/mcp` in Claude Code to inspect the connection. See
[Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Cursor

Add the server to `.cursor/mcp.json` in a project or `~/.cursor/mcp.json` for all
projects. Merge it with existing servers instead of replacing them:

```json
{
  "mcpServers": {
    "computer-elo": {
      "url": "https://antislop.org/mcp"
    }
  }
}
```

See [Cursor's MCP documentation](https://cursor.com/help/customization/mcp).

### VS Code

Add the server to `.vscode/mcp.json`, preserving existing servers, then review and
trust it when prompted:

```json
{
  "servers": {
    "computer-elo": {
      "type": "http",
      "url": "https://antislop.org/mcp"
    }
  }
}
```

See [VS Code's MCP documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

### Other clients and connection checks

Use the remote server URL with Streamable HTTP and no authentication. A client
that supports tools can call `get_assessment_prompt` or `get_entry_prompt` with
`{}` even if it has no native prompts interface. After connecting, confirm these
tools appear and return the requested public instructions. Do not send evidence
as arguments. If a client supports local servers only, use the Markdown prompts
directly. Product-specific setup above follows the linked vendor documentation;
protocol tests do not establish that every vendor client has been tested live.

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
legacy-client compatibility. All tools accept an empty object:

- `get_scoring_guide`: returns the public rubric, current completed week,
  estimation rules, fixed context labels, and prompt.
- `get_assessment_prompt`: returns that week's assessment prompt.
- `get_entry_prompt`: returns the AntiSlop entry preparation prompt.

Native prompts `assess_week` and `prepare_antislop_entry` return the same
instructions as their corresponding tools and take no arguments.

No authentication or recovery key is needed. There are no history, account,
assessment-upload, entry-submission, arbitrary URL, file-read, or publishing tools. The MCP handler
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
