export const metadata = { title: "Agent format", description: "The Universal Agent Format and the .agentpack package layout." };

export default function Format() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>The Universal Agent Format</h1>
      <p>
        Every adapter reads its platform into the same document and writes the same document back out. The document is JSON validated with a published JSON Schema (run <code>nomad schema</code> to write it), with Markdown for long form content such as instructions, persona and memory.
      </p>

      <h2>Package layout</h2>
      <p>
        An <code>.agentpack</code> is a ZIP archive. It contains a manifest and only the files the agent needs; empty folders are never created.
      </p>
      <pre className="code">
        {`manifest.json                format, schema version, id, references, integrity hashes
identity/identity.json       name, description, tone, extensions
identity/persona.md
instructions/01-agents-md.md one file per instruction section
memory/memory-index.json     kind, scope, title, date, tags, provenance per entry
memory/facts/memory-1.md     one file per entry, grouped by kind
skills/<name>/skill.json     metadata, dependencies, allowed tools
skills/<name>/instructions.md
skills/<name>/files/...      scripts and references
tools/<name>/tool.json       MCP transport, command, url, env references
integrations/integrations.json
workflows/<id>.json          trigger, timezone, actions, enabled state
policies/permissions.json    mode and allow / ask / deny rules
knowledge/knowledge-index.json
files/...
metadata/source.json
metadata/migration-history.json
README.md`}
      </pre>

      <h2>Interchange archives</h2>
      <p>
        Nomad also reads and writes <code>.jetpack</code> archives, the flat layout used by other agent portability tools: <code>jetpack.json</code>, <code>AGENTS.md</code>, <code>SOUL.md</code>, <code>MEMORY.md</code>, <code>memory/</code>, <code>routines/</code>, <code>skills/</code> and <code>files/</code>. Import them anywhere a package is accepted, or export with <code>nomad export &lt;agent&gt; --format jetpack</code>. Parts the layout cannot hold, such as MCP tools, travel in an <code>x-nomad</code> manifest key that other readers ignore. These archives carry no integrity hashes, so Nomad says so when it reads one.
      </p>

      <h2>Identity</h2>
      <p>
        Every agent has a permanent ULID. Nomad writes it into the destination as a hidden marker (for example <code>&lt;!-- nomad:begin agent=01J... --&gt;</code>) and also keeps a local mapping of every location it has written to, so reading the agent back on any platform recognises it instead of creating a duplicate. <code>nomad duplicate</code> creates a copy with a new identity on purpose.
      </p>

      <h2>Memory</h2>
      <p>
        Memory is a list of entries, never one blob. Each entry has a kind (profile, preference, fact, project, instruction, note, summary, daily log, document), a scope (user, agent, project), optional title, date and tags, and where it came from. Nomad never invents memory and never merges unrelated entries. When a destination stores memory differently it writes the closest form and the report says what changed, for example Hermes keeps entries in <code>MEMORY.md</code> separated by <code>§</code> and drops titles.
      </p>
      <p>A static export cannot reproduce a platform&apos;s internal retrieval or ranking. Nomad moves the content, not the search index.</p>

      <h2>Skills, tools and integrations</h2>
      <p>
        Skills follow the Agent Skills layout (<code>SKILL.md</code> with frontmatter, plus files). Claude Code slash commands and Codex custom prompts are kept as manually invoked skills and converted into each other. Tools are MCP server definitions. A tool definition does not mean the destination can run it, so the report lists the setup steps. Secret values are never packaged by default; they become references such as <code>{`{ "secretRef": "GITHUB_TOKEN" }`}</code>.
      </p>

      <h2>Workflows</h2>
      <p>
        Routines keep their trigger (cron expression, interval, one time or event), timezone, prompt and attached skills. <code>sourceEnabled</code> records whether the routine was active where it came from. Imported routines always have <code>enabled: false</code>; you switch them on at the destination after reviewing them.
      </p>

      <h2>Permissions</h2>
      <p>
        A policy has a mode (<code>ask</code>, <code>auto</code>, <code>read-only</code>) and rules with a capability (read, write, file, shell, network, browser, computer, schedule, tool, integration), an effect (allow, ask, deny) and an optional pattern. Adapters translate rules into the native system when there is one, and Nomad compares the destination policy before and after every migration. Anything broader needs explicit approval, and restrictions the destination cannot enforce are listed.
      </p>

      <h2>Extensions and versions</h2>
      <p>
        Platform specific data goes into namespaced extension fields such as <code>x-openclaw</code> or <code>x-claude-code</code>. Unknown extensions never make a valid package fail. The current schema version is 1.0; newer readers upgrade older documents, and a package from a newer version is refused with a clear message instead of being half read.
      </p>
    </>
  );
}
