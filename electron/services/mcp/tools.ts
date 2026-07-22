import { z } from 'zod'
import { buildToolResultText, toolOutputSchemas } from './presentation'
import { createToolError, createToolSuccess } from './result'
import { getMcpConfigSnapshot } from './runtime'
import { McpReadService } from './service'
import { MCP_CONTACT_KINDS, MCP_MEMORY_SOURCE_TYPES, MCP_MESSAGE_KINDS } from './types'

const readService = new McpReadService()

export function registerCipherTalkMcpTools(server: any) {
  server.registerTool('health_check', {
    title: 'Health Check',
    description: 'Return CipherTalk MCP health information.'
  }, async () => {
    try {
      const payload = await readService.healthCheck()
      return createToolSuccess('CipherTalk MCP health is available.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_status', {
    title: 'Get Status',
    description: 'Return CipherTalk MCP runtime and configuration status.'
  }, async () => {
    try {
      const payload = await readService.getStatus()
      return createToolSuccess('CipherTalk MCP status loaded.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_moments_timeline', {
    title: 'Get Moments Timeline',
    description: 'Return structured Moments timeline posts with media, likes, comments, and share information. Post body text is in items[].contentDesc.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Pagination limit. Defaults to 20.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset. Defaults to 0.'),
      usernames: z.array(z.string().trim().min(1)).optional().describe('Optional username filters.'),
      keyword: z.string().optional().describe('Optional keyword filter.'),
      startTime: z.number().int().positive().optional().describe('Optional start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('Optional end timestamp in seconds or milliseconds.'),
      includeRaw: z.boolean().optional().describe('Include raw XML when true.')
    },
    outputSchema: toolOutputSchemas.get_moments_timeline
  }, async (args: unknown) => {
    try {
      const payload = await readService.getMomentsTimeline((args || {}) as any)
      return createToolSuccess(buildToolResultText('get_moments_timeline', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('resolve_session', {
    title: 'Resolve Session',
    description: 'Resolve a fuzzy person/session clue into the most likely chat session, returning candidates, confidence, and recommended next action.',
    inputSchema: {
      query: z.string().trim().min(1).describe('Fuzzy person or session clue. Can be a partial name, nickname, remark fragment, institution fragment, or sessionId.'),
      limit: z.number().int().positive().optional().describe('Maximum number of candidates to return.')
    },
    outputSchema: toolOutputSchemas.resolve_session
  }, async (args: unknown) => {
    try {
      const payload = await readService.resolveSession((args || {}) as any)
      return createToolSuccess(buildToolResultText('resolve_session', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('export_chat', {
    title: 'Export Chat',
    description: 'Validate and export chat history for one resolved session. This tool strictly checks target session, date range, export format, media selections, and output directory before exporting.',
    inputSchema: {
      sessionId: z.string().trim().min(1).optional().describe('Resolved sessionId when already known.'),
      query: z.string().trim().min(1).optional().describe('Fuzzy session clue when sessionId is not yet known.'),
      format: z.enum(['chatlab', 'chatlab-jsonl', 'json', 'excel', 'html']).optional().describe('Export format.'),
      dateRange: z.object({
        start: z.number().int().positive(),
        end: z.number().int().positive()
      }).optional().describe('Required export time range in seconds or milliseconds.'),
      mediaOptions: z.object({
        exportAvatars: z.boolean().optional(),
        exportImages: z.boolean().optional(),
        exportVideos: z.boolean().optional(),
        exportEmojis: z.boolean().optional(),
        exportVoices: z.boolean().optional()
      }).optional().describe('Required explicit media export selections.'),
      outputDir: z.string().trim().min(1).optional().describe('Optional output directory. If omitted, the configured default export path will be used when available.'),
      validateOnly: z.boolean().optional().describe('When true, only validate completeness and return missing fields without exporting.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.exportChat((args || {}) as any)
      return createToolSuccess(payload.message, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List chat sessions with search and pagination. Use as a fuzzy discovery entry point when the user only remembers part of a name, remark, institution, or recent clue. Recent message preview is in items[].lastMessagePreview.',
    inputSchema: {
      q: z.string().optional().describe('Optional search keyword.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      unreadOnly: z.boolean().optional().describe('Only return sessions with unread messages.')
    },
    outputSchema: toolOutputSchemas.list_sessions
  }, async (args: unknown) => {
    try {
      const payload = await readService.listSessions((args || {}) as any)
      return createToolSuccess(buildToolResultText('list_sessions', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_messages', {
    title: 'Get Messages',
    description: 'List messages from one chat session with filters and pagination. Message text body is in items[].text.',
    inputSchema: {
      sessionId: z.string().trim().min(1).describe('Required session identifier. Accepts sessionId, contactId, display name, remark, or nickname when uniquely resolvable.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      order: z.enum(['asc', 'desc']).optional().describe('Message sort order by time.'),
      keyword: z.string().optional().describe('Optional content keyword filter.'),
      startTime: z.number().int().positive().optional().describe('Start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('End timestamp in seconds or milliseconds.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    },
    outputSchema: toolOutputSchemas.get_messages
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getMessages((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(buildToolResultText('get_messages', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('list_contacts', {
    title: 'List Contacts',
    description: 'List contacts, groups, and official accounts for agent-side resolution. Use as a broad fuzzy lookup entry point before guessing a specific sessionId. Real contact username is in items[].contactId and can be reused as get_moments_timeline.usernames[].',
    inputSchema: {
      q: z.string().optional().describe('Optional search keyword.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      types: z.array(z.enum(MCP_CONTACT_KINDS)).optional().describe('Optional contact kinds to include.')
    },
    outputSchema: toolOutputSchemas.list_contacts
  }, async (args: unknown) => {
    try {
      const payload = await readService.listContacts((args || {}) as any)
      return createToolSuccess(buildToolResultText('list_contacts', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('search_messages', {
    title: 'Search Messages',
    description: 'Search messages across one or more sessions and return agent-friendly hits. Use for broad clue hunting when the target session or keyword is still uncertain. Hit text is in hits[].message.text and hits[].excerpt.',
    inputSchema: {
      query: z.string().trim().min(1).describe('Required full-text query.'),
      sessionId: z.string().trim().min(1).optional().describe('Single session identifier to search. Accepts sessionId, contactId, display name, remark, or nickname when uniquely resolvable.'),
      sessionIds: z.array(z.string().trim().min(1)).max(20).optional().describe('Multiple session identifiers to search. Each item accepts sessionId, contactId, display name, remark, or nickname when uniquely resolvable.'),
      startTime: z.number().int().positive().optional().describe('Start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('End timestamp in seconds or milliseconds.'),
      kinds: z.array(z.enum(MCP_MESSAGE_KINDS)).optional().describe('Optional message kinds to include.'),
      direction: z.enum(['in', 'out']).optional().describe('Optional direction filter.'),
      senderUsername: z.string().trim().min(1).optional().describe('Optional sender username filter.'),
      matchMode: z.enum(['substring', 'exact']).optional().describe('Search match mode.'),
      limit: z.number().int().positive().optional().describe('Maximum number of hits to return.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    },
    outputSchema: toolOutputSchemas.search_messages
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.searchMessages((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(buildToolResultText('search_messages', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('search_memory', {
    title: 'Search Memory',
    description: 'Search structured memory_items with keyword recall and optional evidence expansion. Returns message, conversation_block, fact, timeline_summary, profile, and other memory hits.',
    inputSchema: {
      query: z.string().trim().min(1).describe('Required memory search query.'),
      keywordQueries: z.array(z.string().trim().min(1)).max(12).optional().describe('Optional extra keyword queries for FTS recall.'),
      sessionId: z.string().trim().min(1).optional().describe('Optional session identifier. Accepts sessionId, contactId, display name, remark, or nickname when uniquely resolvable.'),
      sourceTypes: z.array(z.enum(MCP_MEMORY_SOURCE_TYPES)).optional().describe('Optional memory source type filters.'),
      startTime: z.number().int().positive().optional().describe('Optional start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('Optional end timestamp in seconds or milliseconds.'),
      direction: z.enum(['in', 'out']).optional().describe('Optional direction filter.'),
      senderUsername: z.string().trim().min(1).optional().describe('Optional sender username filter.'),
      limit: z.number().int().positive().optional().describe('Maximum number of memory hits to return.'),
      expandEvidence: z.boolean().optional().describe('When true, expand memory source refs into surrounding chat context. Defaults to true.'),
      includeRaw: z.boolean().optional().describe('Include raw message content in expanded evidence when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths in expanded evidence when true.')
    },
    outputSchema: toolOutputSchemas.search_memory
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.searchMemory((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(buildToolResultText('search_memory', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('transcribe_voice_message', {
    title: 'Transcribe Voice Message',
    description: 'Transcribe one WeChat voice message into text using the current CipherTalk STT settings. Use get_messages or search_messages first to get the voice message cursor fields.',
    inputSchema: {
      sessionId: z.string().trim().min(1).describe('Required chat sessionId containing the voice message.'),
      localId: z.number().int().positive().describe('Voice message localId from message.cursor.localId.'),
      createTime: z.number().int().positive().describe('Voice message createTime from message.cursor.createTime.'),
      force: z.boolean().optional().describe('When true, ignore cached transcript and transcribe again.')
    },
    outputSchema: toolOutputSchemas.transcribe_voice_message
  }, async (args: unknown) => {
    try {
      const payload = await readService.transcribeVoiceMessage((args || {}) as any)
      return createToolSuccess(buildToolResultText('transcribe_voice_message', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('transcribe_audio_file', {
    title: 'Transcribe Audio File',
    description: 'Transcribe a local audio file such as mp3, wav, m4a, flac, ogg, opus, aac, or amr into text using the current CipherTalk STT settings.',
    inputSchema: {
      filePath: z.string().trim().min(1).describe('Absolute local path to the audio file.')
    },
    outputSchema: toolOutputSchemas.transcribe_audio_file
  }, async (args: unknown) => {
    try {
      const payload = await readService.transcribeAudioFile((args || {}) as any)
      return createToolSuccess(buildToolResultText('transcribe_audio_file', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_session_context', {
    title: 'Get Session Context',
    description: 'Return the latest session context or messages around a cursor anchor. Use mode=latest for recent chat, and read message text from items[].text.',
    inputSchema: {
      sessionId: z.string().trim().min(1).describe('Required session identifier. Accepts sessionId, contactId, display name, remark, or nickname when uniquely resolvable.'),
      mode: z.enum(['latest', 'around']).describe('Context mode.'),
      anchorCursor: z.object({
        sortSeq: z.number().int(),
        createTime: z.number().int().positive(),
        localId: z.number().int()
      }).optional().describe('Required cursor when mode=around.'),
      beforeLimit: z.number().int().positive().optional().describe('Latest count or before-context count.'),
      afterLimit: z.number().int().positive().optional().describe('After-context count when mode=around.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    },
    outputSchema: toolOutputSchemas.get_session_context
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getSessionContext((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(buildToolResultText('get_session_context', payload), payload)
    } catch (error) {
      return createToolError(error)
    }
  })

}
