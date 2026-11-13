import { sha256 } from "@nomad/core";
import { BIP39_ENGLISH } from "./bip39-words";

export interface SecretRule {
  id: string;
  name: string;
  pattern: RegExp;
  /** Capture group holding the secret. 0 means the whole match. */
  group?: number;
  /** Minimum Shannon entropy for the captured value. */
  minEntropy?: number;
  /** Extra check on the captured value; the match is ignored when it returns false. */
  validate?: (value: string) => boolean;
}

/** A recovery phrase: 12 to 24 words, all from the BIP-39 English list. */
export function isMnemonic(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => BIP39_ENGLISH.has(w));
}

const EVM_KEY = /\b0x[0-9a-fA-F]{64}\b/g;

export const SECRET_RULES: SecretRule[] = [
  // A 0x-prefixed 32-byte hex value is a wallet key when the text around it says so.
  // Without that context it is usually a transaction or block hash, so it is left alone
  // here; launch arguments, URLs and headers of MCP servers are checked without context
  // (scanMcpLaunchFields).
  {
    id: "evm-private-key",
    name: "Wallet private key",
    pattern: /(?:private|secret|signer|wallet|\bkey\b|_key\b|-key\b)[^\n]{0,40}?\b(0x[0-9a-fA-F]{64})\b/gi,
    group: 1
  },
  {
    id: "bip39-mnemonic",
    name: "Wallet recovery phrase",
    pattern: /(?<![a-z] ?)\b([a-z]{3,8}(?:[ \t]+[a-z]{3,8}){11,23})\b(?! ?[a-z])/g,
    group: 1,
    validate: isMnemonic
  },
  { id: "private-key", name: "Private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[^-]*-----|$)/g },
  { id: "anthropic-key", name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openrouter-key", name: "OpenRouter API key", pattern: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { id: "openai-key", name: "OpenAI API key", pattern: /\bsk-(?!ant-|or-v1-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: "aws-access-key", name: "AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "aws-secret-key", name: "AWS secret access key", pattern: /aws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})/gi, group: 1 },
  { id: "github-token", name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: "gitlab-token", name: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: "google-api-key", name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", name: "Stripe key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: "huggingface-token", name: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{34,}/g },
  { id: "telegram-bot-token", name: "Telegram bot token", pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { id: "jwt", name: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "url-credentials", name: "Password in connection string", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{6,})@/gi, group: 1 },
  {
    id: "generic-assignment",
    name: "Credential assignment",
    pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|bearer|private[_-]?key|mnemonic|seed[_ -]?phrase)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 1,
    minEntropy: 3.2
  }
];

const PLACEHOLDER = /^(?:\$\{?[A-Z0-9_]+\}?|<[^>]+>|\[REDACTED[^\]]*\]|x{4,}|\*{4,}|your[-_].*|changeme|example.*|placeholder|redacted|null|none|true|false|\.\.\.)$/i;

export const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|\/)auth(-profiles)?\.json$/i,
  /(^|\/)\.git-credentials$/,
  // Wallet files kept by agent tools.
  /(^|\/)\.agent001\/wallet\.(json|enc)$/i,
  /(^|\/)\.config\/priors\/.+/i
];

const SENSITIVE_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PRIVATE|COOKIE|SESSION|BEARER|MNEMONIC|SEED|WALLET|PASSPHRASE|KEYSTORE)/i;

/** Public RPC endpoints that carry no credentials. Any other RPC URL may embed a provider key. */
const PUBLIC_RPC_HOSTS = new Set([
  "rpc.mainnet.chain.robinhood.com",
  "rpc.testnet.chain.robinhood.com",
  "robinhood-rpc.publicnode.com",
  "rpc.ordofi.network",
  "mainnet.base.org"
]);

export function isPublicRpcUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return (u.protocol === "https:" || u.protocol === "wss:") && !u.username && !u.password && !u.search && (u.pathname === "/" || u.pathname === "") && PUBLIC_RPC_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Env names that hold an RPC endpoint: RPC_URL, PRIORS_RPC, BASE_RPC_URL and similar. */
export function isRpcEnvKey(key: string): boolean {
  return /(^|_)RPC(_URL)?$/i.test(key);
}

/**
 * MCP launch fields are checked without context: a wallet key in a command-line
 * argument, a URL or a header is never legitimate configuration to copy.
 */
export function scanMcpLaunchFields(tool: string, fields: { args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }): SecretFinding[] {
  const out: SecretFinding[] = [];
  const check = (where: string, text: string) => {
    out.push(...scanText(text, where));
    EVM_KEY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EVM_KEY.exec(text))) {
      if (out.some((f) => f.file === where && f.fingerprint === sha256(m![0]).slice(0, 12))) continue;
      out.push({ ruleId: "evm-private-key", ruleName: "Wallet private key", file: where, line: 1, column: m.index + 1, fingerprint: sha256(m[0]).slice(0, 12), preview: `${m[0].length} characters` });
    }
  };
  (fields.args ?? []).forEach((a, i) => check(`tools/${tool}/args[${i}]`, a));
  for (const [k, v] of Object.entries(fields.env ?? {})) check(`tools/${tool}/env/${k}`, v);
  if (fields.url) check(`tools/${tool}/url`, fields.url);
  for (const [k, v] of Object.entries(fields.headers ?? {})) check(`tools/${tool}/headers/${k}`, v);
  return out;
}

/** Remove wallet keys from a launch field, with or without surrounding context. */
export function redactLaunchField(text: string): { text: string; count: number } {
  const r = redactText(text);
  let count = r.count;
  const out = r.text.replace(EVM_KEY, () => {
    count++;
    return "[REDACTED:evm-private-key]";
  });
  return { text: out, count };
}

export interface SecretFinding {
  ruleId: string;
  ruleName: string;
  file: string;
  line: number;
  column: number;
  /** Short hash that identifies the secret without revealing it. */
  fingerprint: string;
  /** Masked description such as "40 characters". Never the value. */
  preview: string;
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function isSensitiveFile(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(p));
}

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY.test(key);
}

export function looksLikeSecretValue(value: string): boolean {
  if (!value || PLACEHOLDER.test(value.trim())) return false;
  return scanText(value, "(value)").length > 0;
}

interface RawMatch {
  rule: SecretRule;
  start: number;
  end: number;
  value: string;
}

function rawMatches(text: string): RawMatch[] {
  const found: RawMatch[] = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text))) {
      const g = rule.group ?? 0;
      const value = m[g];
      if (!value) continue;
      if (PLACEHOLDER.test(value)) continue;
      if (rule.minEntropy && shannonEntropy(value) < rule.minEntropy) continue;
      if (rule.validate && !rule.validate(value)) continue;
      const start = m.index + (g === 0 ? 0 : m[0].indexOf(value));
      const end = start + value.length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({ rule, start, end, value });
      if (m[0].length === 0) rule.pattern.lastIndex++;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function position(text: string, index: number) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, column: index - last };
}

export function scanText(text: string, file: string): SecretFinding[] {
  return rawMatches(text).map((m) => {
    const pos = position(text, m.start);
    return {
      ruleId: m.rule.id,
      ruleName: m.rule.name,
      file,
      line: pos.line,
      column: pos.column,
      fingerprint: sha256(m.value).slice(0, 12),
      preview: `${m.value.length} characters`
    };
  });
}

/** Replace detected secrets with redaction markers. */
export function redactText(text: string): { text: string; count: number } {
  const matches = rawMatches(text);
  if (!matches.length) return { text, count: 0 };
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + `[REDACTED:${m.rule.id}]`;
    last = m.end;
  }
  out += text.slice(last);
  return { text: out, count: matches.length };
}
