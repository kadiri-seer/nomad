export const metadata = { title: "Security", description: "How Nomad protects credentials, permissions and your files during a migration." };

export default function Security() {
  return (
    <>
      <p className="label">Documentation</p>
      <h1>Security model</h1>
      <p>Nomad touches the most sensitive parts of an agent: its credentials, its permissions and files you have tuned by hand. These are the rules it follows.</p>

      <h2>Local first</h2>
      <p>
        All reading, writing, packaging, backups and history happen on your machine. There is no account and no server. The web interface runs on <code>127.0.0.1</code>, requires a session token issued by <code>nomad ui</code>, rejects requests whose Host or Origin is not local (which blocks DNS rebinding and cross site requests), and is not reachable from other machines. The public website exposes no file access at all; its inspector reads packages inside your browser.
      </p>

      <h2>Secrets</h2>
      <ul>
        <li>Before export, import and migration, Nomad scans every text field for API keys (OpenAI, Anthropic, OpenRouter, GitHub, GitLab, Google, AWS, Slack, Stripe, Hugging Face, Telegram), private keys, JSON web tokens, passwords in connection strings and credential assignments.</li>
        <li>Findings show the rule, file and line, never the value.</li>
        <li>Detected secrets are replaced with markers such as <code>[REDACTED:openai-key]</code>. MCP environment variables and headers that hold credentials become references you reconnect at the destination.</li>
        <li>Credential files (<code>.env</code>, keys, <code>auth.json</code> and similar) are left out. Platform secret stores such as <code>~/.hermes/.env</code> or <code>~/.openclaw/credentials</code> are never read.</li>
        <li>Keeping secrets requires <code>--include-secrets</code>, prints a warning and is recorded in the package manifest.</li>
      </ul>

      <h2>Permissions never widen silently</h2>
      <p>
        Nomad reads the destination&apos;s permission policy before a migration and computes what it would be afterwards. If any capability becomes broader, a new allow rule appears, or a deny rule disappears, the migration stops until you approve that specific change. When a restriction cannot be represented at the destination (for example a browser deny rule in Claude Code) it is listed as not enforced. When a mapping is inexact Nomad picks the stricter option: a source that ran without prompts still gets approval prompts for shell commands in Claude Code and Codex.
      </p>

      <h2>Files</h2>
      <ul>
        <li>The source agent is only read.</li>
        <li>Every change is shown as a preview first, with a diff per file.</li>
        <li>Shared files are merged at the key or section level. Content outside Nomad&apos;s marked sections is never removed.</li>
        <li>Nomad records a hash of everything it writes. A file you edit afterwards is detected and not overwritten without approval.</li>
        <li>All affected files are backed up before writing. Writes are atomic (temporary file and rename). If any write fails, the files already written are restored.</li>
        <li>If the destination changes between preview and execution, the run stops.</li>
        <li>Writes never follow symbolic links below the destination folder.</li>
        <li>Imported routines are always paused.</li>
      </ul>

      <h2>Packages</h2>
      <p>
        A package is never trusted, even one Nomad created. Before anything is extracted, the archive directory is checked for path traversal, absolute paths, backslashes, control characters, symbolic links and special files, duplicate paths, encrypted entries, unexpected file types, size limits and compression ratios. Entries are then inflated with their declared size as a hard cap, and every file is checked against the SHA-256 recorded in the manifest. Scripts inside skills are stored and reported but never executed.
      </p>

      <h2>Assistants</h2>
      <p>
        The MCP server is read only by default. With <code>--allow-writes</code> an assistant can apply a migration only by quoting the token of a preview, so it cannot write anything that was not previewed. Replace mode, overwriting edited files and broader permissions additionally require <code>--allow-replace</code>.
      </p>

      <h2>Remote migration</h2>
      <p>
        The experimental <code>nomad remote push</code> command uses your system <code>ssh</code> and <code>scp</code> with strict host key checking. An unknown host fails with instructions to verify its fingerprint; Nomad never turns the check off and never reads your private keys.
      </p>

      <h2>Reporting a problem</h2>
      <p>
        Please report security issues privately to <a href="mailto:kadiriseer@gmail.com">kadiriseer@gmail.com</a>.
      </p>
    </>
  );
}
