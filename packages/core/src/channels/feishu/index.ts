// Feishu Channel public surface — Phase 4 A.
//
// The pure pieces (verification, parsing, dedup) are exported for testing
// and reuse by the webhook route. FeishuChannel is the Channel-interface
// implementation; the webhook route in @evolving-agent/web will instantiate
// it and call handleInboundPayload().

export { FeishuChannel } from './feishu-channel.js'
export type { FeishuInboundOutcome } from './feishu-channel.js'
export {
  createFeishuClient,
  buildTextContent,
  replyText,
  sendText,
} from './feishu-client.js'
export { FeishuDedup } from './dedup.js'
export {
  parseFeishuMessageEvent,
  buildFeishuConversationId,
} from './message-parse.js'
export type { ParseOptions as FeishuParseOptions } from './message-parse.js'
export {
  verifyFeishuSignature,
  decryptFeishuPayload,
} from './webhook-verify.js'
export type {
  FeishuCredentials,
  FeishuChannelOptions,
  FeishuInboundMessage,
  FeishuWebhookHeaders,
  FeishuVerifyResult,
} from './types.js'
