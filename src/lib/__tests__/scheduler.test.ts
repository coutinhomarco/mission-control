import { describe, expect, it } from 'vitest'

import { extractFinalAgentMessageFromAcpStream } from '@/lib/scheduler'

describe('extractFinalAgentMessageFromAcpStream', () => {
  it('returns the final completed assistant turn from an ACP stream', () => {
    const stream = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"primeira"}}}}',
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"segunda "}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"final"}}}}',
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
    ].join('\n')

    expect(extractFinalAgentMessageFromAcpStream(stream)).toBe('segunda final')
  })

  it('ignores malformed lines and returns null when no assistant text exists', () => {
    expect(extractFinalAgentMessageFromAcpStream('not-json\n{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}')).toBeNull()
  })
})
