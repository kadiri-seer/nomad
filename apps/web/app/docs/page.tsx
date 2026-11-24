import Link from "next/link";
import { InstallNomad } from "@/components/InstallNomad";

export const metadata = { title: "Getting started", description: "Install Nomad with one line, find your agents and run your first previewed move." };

export default function Docs() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Getting started</h1>
      <p>
        Nomad runs on your own computer and reads agents from the folders their platforms already use, such as <code>~/.openclaw</code>, <code>~/.claude</code>, <code>~/.codex</code> and <code>~/.hermes</code>.
      </p>

      <h2>Install in one line</h2>
      <p>No Node.js, no admin rights and nothing else to set up first. Pick your system, paste the line, and Nomad installs like any other app.</p>
      <InstallNomad />
      <p>
        The installer checks the download against its published fingerprint, adds the <code>nomad</code> command and a Nomad app to your Start menu, Applications or apps menu, and leaves your agents untouched. Remove it any time with <code>nomad uninstall</code>. Nomad keeps its library, backups and receipts in <code>~/.nomad</code>; set <code>NOMAD_HOME</code> to use another folder.
      </p>

      <h2>Open Nomad</h2>
      <p>
        Open Nomad from your apps, or type <code>nomad ui</code>. The dashboard runs in your browser from <code>127.0.0.1</code> with a one-time session token, so only your computer can reach it. Everything the command line does is there too, including the move wizard.
      </p>

      <h2>For developers</h2>
      <p>
        With Node.js 22 or newer you can skip the installer: <code>npx thenomad</code> runs it once, and <code>npm install -g thenomad</code> keeps the <code>nomad</code> command.
      </p>

      <h2>Your first move</h2>
      <p>
        Run <code>nomad</code> with nothing after it. It finds the agents on this computer, asks which one and where it should go, shows a short summary of what will move and asks once. That is the whole flow.
      </p>
      <p>The same thing in one line:</p>
      <pre className="code">
        {`nomad move openclaw claude-code      move, with a summary and one question
nomad move openclaw ./kestrel.nomad  save to a file you can share or keep
nomad move ./kestrel.nomad codex     open that file somewhere else
nomad restore <backup-id>            undo (the command is printed after every move)`}
      </pre>
      <p>
        Add <code>--dry-run</code> to only see the summary, <code>--details</code> for every file and diff, and <code>--yes</code> in scripts. A backup is always taken before anything is written.
      </p>

      <h2>Signed packages</h2>
      <p>
        <code>nomad move openclaw ./kestrel.nomad --sign</code> signs the file with a key Nomad creates for you. Anyone opening it sees who signed it: you, someone they trust, or an unknown key. If a single byte changed after signing, Nomad reports a broken signature. <code>nomad keys</code> shows your fingerprint, and <code>nomad trust kestrel.nomad --name Ada</code> trusts the key that signed a file you received.
      </p>

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
          a package: <code>./kestrel.nomad</code> (older <code>.agentpack</code> and <code>.jetpack</code> files work too)
        </li>
        <li>
          an agent in your library by name or id, optionally a version: <code>Kestrel@3</code>
        </li>
      </ul>
      <p>
        Destinations for <code>nomad move</code> are a platform (<code>codex</code>), a platform with a folder (<code>claude-code:~/work/app</code>) or a file ending in <code>.nomad</code>. Platforms without a default location, such as Cursor, use the current folder.
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
nomad                           guided move
nomad move <from> <to>          move to a platform or a .nomad file
nomad export <source> [--sign]  write a .nomad file
nomad import <pack> [--to id]   import, optionally into a platform
nomad migrate --from --to       the long form of move, every option
nomad keys | trust | untrust    signing keys
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
        <code>nomad mcp</code> exposes listing, inspection, compatibility checks, previews and exports to any MCP client. It is read only unless started with <code>--allow-writes</code>, and even then an assistant can only apply a preview by quoting its token. Replace mode, edited files, broader permissions and commands from packages also need <code>--allow-replace</code>.
      </p>
      <p>
        Plugins for Claude Code, OpenClaw and Hermes live in the <code>plugins/</code> folder of the repository. Continue with <Link href="/docs/format">the agent format</Link> or <Link href="/docs/adapters">the platform matrix</Link>.
      </p>
    </>
  );
}
