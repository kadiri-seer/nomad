import Link from "next/link";

export const metadata = {
  title: "Your Nomad",
  description: "One home for every agent you have, reachable from inside the app you are working in: show, borrow, bring and send back."
};

const ACTIONS = [
  ["Show", "“Nomad, show my agents”", "nomad home", "Nothing"],
  ["Gather", "“Add my agents to Nomad”", "nomad home gather", "Nomad's own library only; your apps are only read"],
  ["Borrow", "“Use my research agent”", "nomad home borrow <agent>", "Nothing"],
  ["Bring", "“Bring my research agent here”", "nomad home bring <agent> <app>", "The app's files, after a preview you approve, with a backup"],
  ["Send back", "“Save this to my research agent”", "nomad home send-back <agent>", "A new version in the home, after a preview you approve"]
] as const;

const APPS = ["Claude Code", "Codex CLI", "OpenClaw", "Hermes Agent", "Gemini CLI", "Cursor", "Claude desktop app"];

export default function YourNomadDocs() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Your Nomad</h1>
      <p>
        Your Nomad keeps every agent you have in one home, and lets you reach that home from inside the app you are working in. Ask &ldquo;Nomad, show my agents&rdquo;, pick one, and carry on: use it in this chat, install it here for good, or save what it learned back to the home for its other copies.
      </p>
      <p>It runs on your computer, like the rest of Nomad. There is no account and nothing is uploaded.</p>

      <h2>Set it up once</h2>
      <ol>
        <li>
          <Link href="/docs">Install Nomad</Link> with one line.
        </li>
        <li>
          Run <code>nomad connect</code>. It adds Nomad to each app it finds on this computer ({APPS.join(", ")}), after a preview, with every file backed up.
        </li>
        <li>Start a new session in each app. Then ask for your agents in plain words.</li>
      </ol>
      <p>
        <code>nomad connect --status</code> shows which apps have Nomad, and <code>nomad connect --remove</code> takes it out again. Only Nomad&apos;s own entry is ever touched.
      </p>

      <h2>What you can do</h2>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Action</th>
              <th>In an app, say</th>
              <th>In a terminal</th>
              <th>What it writes</th>
            </tr>
          </thead>
          <tbody>
            {ACTIONS.map(([a, say, cmd, writes]) => (
              <tr key={a}>
                <td style={{ fontWeight: 600 }}>{a}</td>
                <td>{say}</td>
                <td>
                  <code>{cmd}</code>
                </td>
                <td className="why">{writes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        The dashboard (<code>nomad ui</code>) has a Your Nomad page for the same things, with a Copy button for borrowed text.
      </p>

      <h2>Show and gather</h2>
      <p>
        Show lists every agent in the home: what it does, the apps it lives in, and any copy that is behind the home. Gather reads the agents found on this computer into the home; doing it again updates what changed and never makes duplicates. Secrets are removed on the way in.
      </p>

      <h2>Borrow</h2>
      <p>
        Borrow gives the chat you are in the agent&apos;s persona, rules, memory and skills as text, and the model works as that agent for the rest of the chat. Nothing is written anywhere. Its tools come with bring, not borrow. To use an agent on Claude or ChatGPT on the web, run <code>nomad home borrow &lt;agent&gt;</code> and paste what it prints.
      </p>

      <h2>Bring</h2>
      <p>
        Bring installs the agent in an app for good, with its tools and skills. It is the same careful move as <code>nomad move</code>: a preview first, approval for anything sensitive, a backup of every file, and a check afterwards. The app loads the new tools in its next session.
      </p>

      <h2>Send back</h2>
      <p>
        Send back saves what an agent learned, from a chat or from its copy in an app, to the home as a new version after you approve a preview. New entries are added, unchanged ones skipped, and when an entry changed in both places you choose which to keep. Send back never deletes. Afterwards the agent&apos;s other copies are marked behind, ready for you to bring the new version when you want.
      </p>

      <h2>Safety</h2>
      <ul>
        <li>Show and borrow write nothing and need no approval.</li>
        <li>
          Bring, send back and connect wait for your approval. An assistant can apply one only when Nomad was connected with <code>--allow-writes</code>, and only with the token of the preview it showed you.
        </li>
        <li>Secrets never travel, and wallet keys are never read.</li>
        <li>Borrowed text describes how to work. It never approves file changes, moves, payments or trades.</li>
        <li>An agent that came from someone else is marked &ldquo;from others&rdquo;, and its borrowed text says to check with you before acting on its rules.</li>
      </ul>

      <h2>Limits</h2>
      <ul>
        <li>Apps without MCP (Windsurf, Cline, Roo Code, Continue, Aider) cannot call Nomad, but still get agents with bring from a terminal or the dashboard.</li>
        <li>Claude and ChatGPT on the web cannot reach your computer: paste borrowed text there instead.</li>
        <li>
          Each app has its own limits; bring moves only what the destination supports, and the preview lists the rest. See <Link href="/docs/adapters">the platform matrix</Link>.
        </li>
      </ul>
    </>
  );
}
