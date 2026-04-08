# Feishu (Lark) Bot Channel

Phase 4 / A stage. The Feishu channel turns the running web server into a
chat bot you can talk to from inside Feishu, reusing the same Agent,
session memory, experiences, and skills as the web dashboard.

This doc covers: what you need, how to configure it, how it works
end-to-end, and how to debug it when something is wrong.

## What you get

- 1:1 (P2P) chat with the bot — every message is answered.
- Group chat — bot only answers messages where it is `@`-mentioned (off by
  default until you provide its open_id; see below).
- One Feishu conversation = one persistent SessionManager session, so the
  bot remembers context within that chat.
- All Agent capabilities (skills, tools, MCP servers, experiences,
  prompts) are available exactly as in the web UI.

## What you do NOT get (yet)

- Streaming responses inside Feishu (Feishu's streaming-card surface is
  cut from A1; the bot replies with a single text message).
- Image / file / audio inputs.
- Multi-account or multi-tenant fan-out.
- Interactive cards / buttons (markdown is sent verbatim as text).

These are deliberately deferred — the goal of A is the smallest
end-to-end loop, not feature parity with the openclaw plugin.

## Prerequisites

1. A Feishu / Lark workspace with developer access.
2. A self-built ("企业自建") app in
   [Feishu Open Platform](https://open.feishu.cn/app). You'll need its
   `App ID` and `App Secret`.
3. Bot capability enabled on the app.
4. A way to expose your local web server to the public internet so Feishu
   can POST webhook events to it. Options:
   - **frp** — point a frps you own at `http://localhost:3721`.
   - **cloudflare tunnel** — `cloudflared tunnel --url http://localhost:3721`.
   - **ngrok** — `ngrok http 3721`.
   - A real reverse proxy (nginx / caddy) on a server you control.

## Configure secrets

Add the following keys to `data/config/secrets.json` (the same flat
key-value file used by MCP). Only the first two are mandatory.

```json
{
  "FEISHU_APP_ID": "cli_xxxxxxxxxxxxxxx",
  "FEISHU_APP_SECRET": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "FEISHU_VERIFICATION_TOKEN": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "FEISHU_ENCRYPT_KEY": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "FEISHU_BOT_OPEN_ID": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

You can also set any of these as environment variables — env wins over
the file, which is convenient for container deploys.

| Key | Required | Purpose |
| --- | --- | --- |
| `FEISHU_APP_ID` | yes | App identifier from the Feishu console. |
| `FEISHU_APP_SECRET` | yes | App secret. Used by the SDK to fetch tenant_access_token. |
| `FEISHU_VERIFICATION_TOKEN` | optional | URL-verification handshake string from the Event Subscriptions page. |
| `FEISHU_ENCRYPT_KEY` | optional | When set, the webhook enforces signature verification + AES decryption. **Strongly recommended** for any deployment touching real users. |
| `FEISHU_BOT_OPEN_ID` | optional | Bot's own open_id. Required for `@`-mention detection in group chats — without it, the channel will silently ignore every group message. P2P chats don't need it. |

> **Where to find `FEISHU_BOT_OPEN_ID`**: in the Feishu console, open
> your app → "应用功能 → 机器人", then call the
> [GetBotInfo](https://open.feishu.cn/document/server-docs/im-v1/bot/get) API
> with a tenant_access_token. The `open_id` field of the response is what
> you want.

## Configure the webhook in Feishu

1. In the Feishu console, open your app → **事件与回调 → 事件订阅**.
2. Set the **Request URL** to:
   ```
   https://<your-public-host>/api/channels/feishu/webhook
   ```
3. (Optional) Set **Verification Token** and **Encrypt Key** to match the
   values you put in `secrets.json`. If you set them here, you MUST set
   them in `secrets.json` too — otherwise verification will fail and the
   bot will receive nothing.
4. Subscribe to the event: **接收消息 v2.0** (`im.message.receive_v1`).
5. Save. Feishu will immediately POST a `url_verification` challenge to
   your endpoint; the bot answers automatically. If you see "已通过" in
   the console, you're good.
6. Add the bot to a group OR start a 1:1 chat with it from your Feishu
   client and send a message.

## How it works end-to-end

```
Feishu user types in chat
        │
        ▼
Feishu Open Platform POST → /api/channels/feishu/webhook
        │
        ▼
packages/web/src/server/routes/feishu.ts
   reads RAW body + X-Lark-* headers
   calls feishuChannel.handleInboundPayload(...)
        │
        ▼
packages/core/src/channels/feishu/feishu-channel.ts
   1. verify HMAC signature (if encryptKey set)
   2. decrypt AES-256-CBC payload (if encryptKey set)
   3. handle url_verification challenge → 200 { challenge }
   4. parseFeishuMessageEvent — drop non-text / unknown shapes
   5. enforce mention gating in group chats
   6. dedup by message_id (5 min TTL)
   7. emit user.message event to handlers
        │
        ▼
packages/web/src/server/services/feishu-handler.ts
   1. SessionManager.getOrLoad(conversationId)  ←  feishu:p2p:<openId>
                                                   feishu:group:<chatId>
      (creates on first sight)
   2. void session.sendMessage(text)            ←  fire-and-forget so the
                                                   webhook acks within
                                                   Feishu's 3s budget
        │
        ▼ background
   3. Agent runs (LLM + tools + skills + memory)
   4. channel.send({ type: 'agent.message', target, text })
        │
        ▼
packages/core/src/channels/feishu/feishu-client.ts
   client.im.message.reply({ message_id, content: { text } })
        │
        ▼
Feishu user sees the reply
```

## Conversation isolation

- **P2P chats** key on `feishu:p2p:<senderOpenId>`. The same Feishu user
  always lands on the same session, even if Feishu rotates the underlying
  p2p chat id.
- **Group chats** key on `feishu:group:<chatId>`. All members of the
  group share one session, so the bot has shared context for everyone.
  This is intentional — the alternative (per-member sessions inside one
  group) felt weirder to the user.

## Verifying it works

Once secrets are set and the public URL is reachable:

```bash
# 1. Start the server
pnpm --filter @evolving-agent/web dev

# 2. Check the bootstrap line
#    [feishu] channel enabled (id='feishu', encrypted, bot=ou_xxx…)

# 3. Hit the status endpoint
curl http://localhost:3721/api/channels/feishu/status
# {"enabled":true,"id":"feishu","name":"Feishu","capabilities":[...]}

# 4. Send the bot a 1:1 message in Feishu and wait for the reply.
```

If the channel is disabled, `/status` returns `{ enabled: false, reason }`
and the server log will print exactly which key was missing.

## Troubleshooting

### `webhook rejected` / 400 from /webhook
- The signature didn't match. Most common cause: `FEISHU_ENCRYPT_KEY` in
  `secrets.json` doesn't match what's in the Feishu console. Re-copy
  both values and restart the server.

### Bot is silent in groups but works in 1:1
- Almost certainly `FEISHU_BOT_OPEN_ID` is missing or wrong. Without it
  the channel can't tell whether you `@`-mentioned the bot, so it
  defaults to safe-fail (drop all group messages). The server log will
  show `ignored: 'group message without bot mention'` for each one.

### Bot replies once then never again to the same message
- That's the dedup working. Feishu retries on slow acks; the dedup
  catches the retry and drops it. If you genuinely want the bot to
  re-process the same message, send a new message (different message_id).

### Replies are slow
- The Agent run happens in the background after the webhook acks. If
  replies take >5s, check the regular agent metrics — it's an Agent /
  LLM problem, not a webhook problem. The MetricsPage in the web UI is
  your best diagnostic.

### `[feishu handler] agent run failed`
- Background error from `session.sendMessage`. The user will receive a
  short error message. Check the server log for the stack trace; same
  classes of failure as the web `/api/chat` endpoint.

### Switching between encrypted and plaintext mode
- Setting/clearing `FEISHU_ENCRYPT_KEY` requires a server restart and a
  matching change in the Feishu console. The two MUST agree — otherwise
  every webhook will fail signature verification.

## File map

| File | What it does |
| --- | --- |
| `packages/core/src/channels/feishu/types.ts` | Public types (credentials, options, parsed message). |
| `packages/core/src/channels/feishu/webhook-verify.ts` | Pure signature + AES decryption. |
| `packages/core/src/channels/feishu/message-parse.ts` | Pure event-shape parsing + conversation id builder. |
| `packages/core/src/channels/feishu/dedup.ts` | In-memory TTL dedup. |
| `packages/core/src/channels/feishu/feishu-client.ts` | Thin SDK Client wrapper (`replyText`, `sendText`). |
| `packages/core/src/channels/feishu/feishu-channel.ts` | `Channel` interface implementation + `handleInboundPayload`. |
| `packages/web/src/server/routes/feishu.ts` | Hono webhook + status route. |
| `packages/web/src/server/services/feishu-bootstrap.ts` | Reads secrets, instantiates channel, registers in SessionManager. |
| `packages/web/src/server/services/feishu-handler.ts` | Inbound `user.message` → SessionManager → Agent → reply. |

## Open knobs (intentionally fixed in A)

- Mention gating: hard-coded `requireMentionInGroup = true`. Edit
  `feishu-bootstrap.ts` and pass `requireMentionInGroup: false` if you
  want a noisy bot.
- Dedup TTL: 5 minutes. Override with `dedupTtlMs` in the same place.
- Channel id: `'feishu'`. If you ever run two bots, change this — the
  ChannelRegistry is keyed on it.
