import Link from "next/link";
import { REPO_URL } from "@/components/SiteFooter";

export const metadata = { title: "Getting started", description: "Install Nomad, find your agents and run your first previewed migration." };

export default function Docs() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Getting started</h1>
      <p>
        Nomad runs on your own machine. It needs Node.js 22 or newer and reads agents from the folders their platforms already use, such as <code>~/.openclaw</code>, <code>~/.claude</code>, <code>~/.codex</code> and <code>~/.hermes</code>.
      </p>

      <h2>Install</h2>
      <pre className="code">
        {`git clone ${REPO_URL}
cd nomad
pnpm install
pnpm --filter @nomad/cli build
pnpm --filter @nomad/web build
alias nomad="node $PWD/apps/cli/dist/nomad.js"`}
      </pre>
      <p>Nomad keeps its library, backups and receipts in <code>~/.nomad</code>. Set <code>NOMAD_HOME</code> to use another folder.</p>

      <h2>Open the app</h2>
      <pre className="code">nomad ui</pre>
      <p>
        This starts the web interface on <code>127.0.0.1</code> with a one time session token and opens it in your browser. Only your machine can reach it. Everything the CLI does is available there, including the migration wizard.
      </p>

      <h2>Your first migration</h2>
      <ol>
        <li>
          Find agents: <code>nomad scan</code>
        </li>
        <li>
          Look inside one: <code>nomad inspect openclaw --against claude-code</code>
        </li>
        <li>
          Preview the move: <code>nomad migrate --from openclaw --to claude-code --dry-run</code>
        </li>
        <li>
          Apply it: run the same command without <code>--dry-run</code>. Nomad asks before writing, or pass <code>--yes</code> in scripts.
        </li>
        <li>
          Undo it if needed: <code>nomad restore &lt;backup-id&gt;</code> (the id is printed after every migration).
        </li>
      </ol>

      <h2>Sources and destinations</h2>
      <p>Wherever a command takes a source you can pass:</p>
      <ul>
        <li>
          a platform at its default location: <code>openclaw</code>, <code>hermes</code>
        </li>
        <li>
          a platform folder and agent: <code>claude-code:~/work/app#subagent:reviewer</code>, <code>hermes:~/.hermes#profile:research</code>
        </li>
        <li>
          a package: <code>./kestrel.agentpack</code>
        </li>
        <li>
          an agent in your library by name or id, optionally a version: <code>Kestrel@3</code>
        </li>
      </ul>
      <p>
        Destinations are a platform id plus <code>--dest-dir</code> when the platform has no default location (project based tools such as Cursor, or a folder for a guided kit).
      </p>

      <h2>Conflict modes</h2>
      <ul>
        <li>
          <strong>merge</strong> (default) keeps everything already at the destination and adds what is missing. Differences are reported, never overwritten.
        </li>
        <li>
          <strong>copy</strong> creates a separate agent: a new OpenClaw agent, a Claude Code subagent, a Hermes profile.
        </li>
        <li>
          <strong>replace</strong> overwrites the agent&apos;s configuration. Content Nomad did not write, or that you edited afterwards, needs an explicit approval flag.
        </li>
      </ul>

      <h2>Command reference</h2>
      <pre className="code">
        {`nomad scan                      find platforms and agents
nomad adapters [--platform id]  capabilities per platform
nomad list                      agents in your library
nomad inspect <source>          what an agent contains
nomad export <source> -o dir    write a .agentpack
nomad import <pack> [--to id]   import, optionally into a platform
nomad migrate --from --to       preview and apply a migration
nomad validate <pack>           check a package
nomad versions <agent>          version history
nomad compare <agent> 1 3       compare versions
nomad compare --left --right    compare two locations
nomad backup <agent>            snapshot an agent's files
nomad backups | restore <id>    list and restore backups
nomad duplicate <agent>         copy under a new identity
nomad sync <agent>              push primary to other locations
nomad history | receipt <op>    past operations
nomad mcp [--allow-writes]      MCP server for assistants
nomad ui                        local web app`}
      </pre>
      <p>
        Global flags: <code>--json</code>, <code>--quiet</code>, <code>--verbose</code>, <code>--home</code>. Exit codes: 0 success, 1 error, 2 usage, 3 approval needed, 4 invalid package, 5 verification failed, 6 rolled back.
      </p>

      <h2>Use it from an assistant</h2>
      <p>
        <code>nomad mcp</code> exposes listing, inspection, compatibility checks, previews and exports to any MCP client. It is read only unless started with <code>--allow-writes</code>, and even then an assistant can only apply a preview by quoting its token. Replace mode, edited files and broader permissions also need <code>--allow-replace</code>.
      </p>
      <p>
        Plugins for Claude Code, OpenClaw and Hermes live in the <code>plugins/</code> folder of the repository. Continue with <Link href="/docs/format">the agent format</Link> or <Link href="/docs/adapters">the platform matrix</Link>.
      </p>
    </>
  );
}
