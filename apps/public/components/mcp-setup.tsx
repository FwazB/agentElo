"use client";

import { useState } from "react";
import { PUBLIC_SITE_URL } from "../../../packages/public-api/scoring-guide";
import { CopyButton } from "./shared";

const MCP_URL = `${PUBLIC_SITE_URL}/mcp`;
const CLAUDE_CODE_COMMAND = `claude mcp add --transport http computer-elo ${MCP_URL}`;
const CURSOR_CONFIG = JSON.stringify({ mcpServers: { "computer-elo": { url: MCP_URL } } }, null, 2);
const VSCODE_CONFIG = JSON.stringify({ servers: { "computer-elo": { type: "http", url: MCP_URL } } }, null, 2);
const WEEK_STARTER = "Use Computer Elo’s get_assessment_prompt tool, then assess my last completed UTC week using the context I have authorized. Keep the result here for me to review before publishing it myself.";
const ENTRY_STARTER = "Use Computer Elo’s get_entry_prompt tool to help prepare an AntiSlop evidence entry from work I choose to share. Keep a draft here for me to review; do not submit or publish it.";

type Client = "claude" | "claude-code" | "cursor" | "vscode" | "other";

function CopyText({ id, label, value, button, rows = 3 }: { id: string; label: string; value: string; button: string; rows?: number }) {
  return <>
    <label className="field-label" htmlFor={id}>{label}</label>
    <textarea id={id} className="prompt-text" readOnly value={value} rows={rows} spellCheck={false}/>
    <CopyButton value={value}>{button}</CopyButton>
  </>;
}

export function McpSetup() {
  const [client, setClient] = useState<Client>("claude");
  return <details className="connect-option">
    <summary>Optional: connect Claude or another MCP client</summary>
    <p>One connection gives your AI the instructions for weekly Computer Form and AntiSlop entry preparation. It does not read your activity or publish anything.</p>
    <label className="field-label" htmlFor="mcp-url">MCP server URL</label>
    <input id="mcp-url" className="text-input endpoint-input" readOnly value={MCP_URL}/>
    <CopyButton value={MCP_URL}>Copy MCP URL</CopyButton>
    <p className="caption">Transport: Streamable HTTP. Authentication: none. No API key, OAuth credentials, or recovery key needed.</p>

    <label className="field-label" htmlFor="mcp-client">Your AI app</label>
    <select id="mcp-client" className="text-input" value={client} onChange={event => setClient(event.target.value as Client)}>
      <option value="claude">Claude web or Desktop</option>
      <option value="claude-code">Claude Code</option>
      <option value="cursor">Cursor</option>
      <option value="vscode">VS Code</option>
      <option value="other">Another MCP client</option>
    </select>
    <section key={client} aria-label="Client setup instructions">
      {client === "claude" && <>
        <p>Open <strong>Customize → Connectors → + → Add custom connector</strong>. Name it Computer Elo, paste the MCP URL, leave OAuth settings empty, and add it. Enable the connector in your conversation.</p>
        <p className="caption">A Team or Enterprise owner may need to add it first. <a className="text-link" href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noopener noreferrer">Claude connector instructions</a></p>
      </>}
      {client === "claude-code" && <>
        <p>Run this in your terminal from the project where you want to use it. Then use <code>/mcp</code> in Claude Code to check the connection.</p>
        <CopyText id="claude-code-command" label="Claude Code command" value={CLAUDE_CODE_COMMAND} button="Copy Claude Code command"/>
        <p className="caption"><a className="text-link" href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noopener noreferrer">Claude Code MCP instructions</a></p>
      </>}
      {client === "cursor" && <>
        <p>Add this server to <code>.cursor/mcp.json</code> in your project, or <code>~/.cursor/mcp.json</code> for all projects. Keep any servers you already have.</p>
        <CopyText id="cursor-config" label="Cursor MCP configuration" value={CURSOR_CONFIG} button="Copy Cursor config" rows={7}/>
        <p className="caption"><a className="text-link" href="https://cursor.com/help/customization/mcp" target="_blank" rel="noopener noreferrer">Cursor MCP instructions</a></p>
      </>}
      {client === "vscode" && <>
        <p>Add this server to <code>.vscode/mcp.json</code> in your project. Keep any servers you already have, then review and trust the server when VS Code prompts you.</p>
        <CopyText id="vscode-config" label="VS Code MCP configuration" value={VSCODE_CONFIG} button="Copy VS Code config" rows={8}/>
        <p className="caption"><a className="text-link" href="https://code.visualstudio.com/docs/agent-customization/mcp-servers" target="_blank" rel="noopener noreferrer">VS Code MCP instructions</a></p>
      </>}
      {client === "other" && <p>Add the URL above as a remote server using Streamable HTTP (sometimes called HTTP). Select no authentication and enable its tools. If your app only supports local servers, use the public prompt links below instead.</p>}
    </section>

    <section className="connect-option">
      <h3>Start with your week.</h3>
      <p>Get a Computer Form estimate from the context your AI already has. Bring the small result back to “Rate my week” to preview and choose whether to publish.</p>
      <CopyText id="mcp-week-starter" label="Ask your connected AI" value={WEEK_STARTER} button="Copy weekly request"/>
      <p className="caption">Native MCP prompt: <code>assess_week</code>. <a className="text-link" href="/rate.md">Read the weekly guide</a></p>
    </section>
    <section className="connect-option">
      <h3>Prepare an AntiSlop entry.</h3>
      <p>Turn work you choose to share into an evidence draft for review. Paste the draft into “Start a duel” on AntiSlop, review every excerpt, and approve submission there.</p>
      <CopyText id="mcp-entry-starter" label="Ask your connected AI" value={ENTRY_STARTER} button="Copy entry request"/>
      <p className="caption">Native MCP prompt: <code>prepare_antislop_entry</code>. <a className="text-link" href="/entry.md">Read the entry preparation prompt</a></p>
    </section>
    <p className="caption">The MCP serves public instructions only. Private evidence stays with your AI, and you review every result or draft before sharing it.</p>
  </details>;
}
