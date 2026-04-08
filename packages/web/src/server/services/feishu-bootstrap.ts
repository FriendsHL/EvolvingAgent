/**
 * Feishu channel bootstrap — Phase 4 / A2.
 *
 * Reads `data/<dataPath>/config/secrets.json`, looks for the four flat
 * keys we need, and (if present) instantiates a `FeishuChannel`. Wires it
 * into the SessionManager's ChannelRegistry. If credentials are missing,
 * returns null and logs a single "disabled" line — startup must NOT throw,
 * because most installs won't have a Feishu app configured.
 *
 * Required keys (in `data/config/secrets.json`):
 *   FEISHU_APP_ID
 *   FEISHU_APP_SECRET
 * Optional:
 *   FEISHU_VERIFICATION_TOKEN  — used for the URL-verification handshake
 *   FEISHU_ENCRYPT_KEY         — when set, webhook signature + AES decrypt
 *                                 are enforced; when unset, only plaintext
 *                                 callbacks work (and signature is skipped)
 *   FEISHU_BOT_OPEN_ID         — bot's own open_id, used for @-mention
 *                                 detection in group chats
 *
 * Why a separate file: keeps server/index.ts readable, and the same helper
 * can be reused by future CLI tooling that wants to ping the channel
 * without spinning up the full Hono server.
 */

import { FeishuChannel, loadSecrets, type SessionManager } from '@evolving-agent/core'

export interface FeishuBootstrapResult {
  channel: FeishuChannel | null
  reason?: string
}

export async function bootstrapFeishuChannel(args: {
  dataPath: string
  sessionManager: SessionManager
}): Promise<FeishuBootstrapResult> {
  const { dataPath, sessionManager } = args

  const { secrets } = await loadSecrets(dataPath)

  // Allow process.env to override secrets.json — useful for container
  // deploys that inject env vars at runtime instead of mounting a file.
  const appId = process.env.FEISHU_APP_ID ?? secrets.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET ?? secrets.FEISHU_APP_SECRET
  const verificationToken =
    process.env.FEISHU_VERIFICATION_TOKEN ?? secrets.FEISHU_VERIFICATION_TOKEN ?? ''
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY ?? secrets.FEISHU_ENCRYPT_KEY
  const botOpenId = process.env.FEISHU_BOT_OPEN_ID ?? secrets.FEISHU_BOT_OPEN_ID

  if (!appId || !appSecret) {
    const reason = 'missing FEISHU_APP_ID or FEISHU_APP_SECRET'
    // eslint-disable-next-line no-console
    console.log(`[feishu] channel disabled — ${reason}`)
    return { channel: null, reason }
  }

  const channel = new FeishuChannel({
    credentials: {
      appId,
      appSecret,
      verificationToken,
      encryptKey,
    },
  })

  if (botOpenId) channel.setBotOpenId(botOpenId)

  sessionManager.getChannels().register(channel)
  await channel.start()

  // eslint-disable-next-line no-console
  console.log(
    `[feishu] channel enabled (id='${channel.id}'${
      encryptKey ? ', encrypted' : ', plaintext'
    }${botOpenId ? `, bot=${botOpenId.slice(0, 12)}…` : ', no bot open_id — group mentions will be ignored'})`,
  )

  return { channel }
}
