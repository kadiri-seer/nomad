"use client";

import { useState } from "react";

export const TOKEN_TICKER = "$NOMAD";
export const TOKEN_CA = "0x14c0a77e792f6c9818888630e95c50cf3b48c979";
export const TOKEN_CHAIN = "Robinhood Chain";
export const TOKEN_EXPLORER_URL = `https://robinhoodchain.blockscout.com/token/${TOKEN_CA}`;
export const TOKEN_CHART_URL = `https://dexscreener.com/robinhood/${TOKEN_CA}`;

/** The token ticker and contract address, with copy, explorer and chart links. */
export function TokenCA() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(TOKEN_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="token-ca">
      <div className="token-ca-head">
        <span className="token-ca-ticker">{TOKEN_TICKER}</span>
        <span className="token-ca-chain">{TOKEN_CHAIN}</span>
      </div>
      <div className="token-ca-row">
        <code className="token-ca-addr" title="Contract address">
          {TOKEN_CA}
        </code>
        <button type="button" className="token-ca-copy" onClick={copy} aria-label="Copy contract address">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="token-ca-links">
        <a href={TOKEN_EXPLORER_URL} target="_blank" rel="noopener noreferrer">
          Explorer
        </a>
        <a href={TOKEN_CHART_URL} target="_blank" rel="noopener noreferrer">
          Chart
        </a>
      </div>
      <span className="sr-only" aria-live="polite">
        {copied ? "Contract address copied" : ""}
      </span>
    </div>
  );
}
