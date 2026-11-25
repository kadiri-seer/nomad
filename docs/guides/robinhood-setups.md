# Robinhood setups

Robinhood lets people connect their own AI agents to two hosted MCP servers. The Trading MCP, `https://agent.robinhood.com/mcp/trading`, works with a Robinhood Agentic account: a separate investing account that the agent trades in, with the money put into it. The Banking MCP, `https://banking-agent.robinhood.com/mcp/banking`, works with an agentic virtual card on a Robinhood Gold Card. Nomad moves these entries between agents and apps, along with the rest of the agent.

Robinhood has not reviewed this guide or Nomad's handling of its servers. It follows Robinhood's support articles on Agentic Trading, onboarding an external agent and the Agentic Credit Card, read Nov 25, 2026.

## What moves

- The two server addresses, in each destination's own format, exactly as written.
- The agent's instructions, including any rule about asking before it trades or buys.

## What does not move

- **The sign-in.** Each app signs in to Robinhood itself and keeps that sign-in in its own storage. Nomad never reads or copies it. After a move, sign in again in the new app: open its list of MCP servers (`/mcp` in Claude Code or Codex, Connectors in Claude Desktop, Tools & MCPs in Cursor), choose the server and authenticate. If Robinhood asks you to finish setting up, do it in a desktop browser.
- **Your Robinhood accounts, card and settings.** They stay with Robinhood.

## Worth a look

- **What the Trading MCP can see and do.** It can read all your Robinhood accounts, including account numbers, positions, balances and order history. It places real trades only in your Agentic account, with the money in it. It trades without asking if its instructions tell it to, so check the agent's instructions in the new app before you sign in.
- **What the Banking MCP can see.** It gets the full number of each agentic card you authorized, so it can pay at checkout, plus that card's spending history and settings. Keep purchase approvals on, or monthly limits set, in the Robinhood Banking app.
- **Look-alikes.** Only Robinhood's own addresses count: exactly the two above, over https on the standard port, with no user name in them. Anything else moves as an ordinary server, without these notes.

## Checked

See [STATUS](../STATUS.md) for what was tested and what was checked with the real apps.
