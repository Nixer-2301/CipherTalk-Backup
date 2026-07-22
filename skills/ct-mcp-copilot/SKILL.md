---
name: ct-mcp-copilot
version: '1.2.0'
description: Use CipherTalk MCP as an AI copilot for health/status checks, contact lookup, session resolution, message search, memory search, context retrieval, moments timeline exploration, and chat export. Trigger when the user provides partial, fuzzy, mistaken, or incomplete clues, or wants the AI to proactively dig for more local data instead of stopping after one failed query.
---

# ct-mcp-copilot

Use CipherTalk MCP like a patient investigator, not like a rigid database client.

## Core behavior

0. Start with `health_check` or `get_status` whenever tool availability, DB readiness, or setup state is uncertain.
1. Start broad, then narrow.
2. Treat `list_contacts` and `list_sessions` as fuzzy entry points.
3. Assume the user may remember only part of the truth.
4. Do not stop after the first miss.
5. When multiple candidates exist, compare them and keep shrinking the set.
6. Always answer from structured fields first. Only mention “the host may have shown only a summary” when fields like `items[].text`, `hits[].message.text`, or `items[].contentDesc` are truly absent.

## Tool coverage

This skill is expected to use all currently exposed CipherTalk MCP tools when relevant:

- `health_check`
- `get_status`
- `get_moments_timeline`
- `resolve_session`
- `export_chat`
- `list_sessions`
- `get_messages`
- `list_contacts`
- `search_messages`
- `search_memory`
- `get_session_context`
- `transcribe_voice_message`
- `transcribe_audio_file`

## Default routing

1. If readiness is unclear, start with `health_check`, then `get_status`.
2. If the user describes a person or chat loosely, start with `list_contacts` and `list_sessions`.
3. When the clue is especially fuzzy or typo-prone, prefer `resolve_session` first to get candidates, confidence, and the recommended next action.
4. If the target is still unclear, compare remark, nickname, display name, recent timestamp, and session kind.
5. For “latest chat” or “recent messages”, prefer `get_session_context(mode="latest")`. Use `get_messages` only when the user clearly needs explicit pagination, sort order, or keyword/time filtering.
6. If the user wants more clues or the session is still uncertain, use `search_messages` across multiple sessions or globally.
7. If the user is asking about朋友圈/动态/点赞/评论/某段时间的分享内容 and the clue is a person name / remark / nickname, resolve the poster first with `list_contacts(q=<clue>)`, then pass `items[].contactId` into `get_moments_timeline.usernames[]`.
8. Use `get_moments_timeline(keyword=<clue>)` first only when the clue is about the post body or topic, not the poster identity.
9. If the user asks what a voice message says, first use `get_messages`, `get_session_context`, or `search_messages` to locate the `kind="voice"` message, then call `transcribe_voice_message` with that message's `sessionId`, `cursor.localId`, and `cursor.createTime`.
10. If the user provides a local mp3/wav/m4a/flac/ogg/opus/aac/amr path and asks for a transcript, call `transcribe_audio_file(filePath=...)`.

## Voice transcription workflow

When a message item has `kind="voice"`:

- If `message.media.transcript` is already present, answer from that cached transcript.
- If the user asks to transcribe or inspect the voice content, call `transcribe_voice_message`.
- Use `force=true` only when the user asks to retry or refresh the transcript.
- Do not claim voice content from `[语音消息]` placeholders; transcribe first.

When the user gives a local audio file path:

- Use `transcribe_audio_file` directly.
- If the tool returns `STT_NOT_READY`, tell the user to download a local STT model or complete online STT settings in CipherTalk.

## Health and status routing

Use `health_check` when:

- the user asks whether CipherTalk MCP is alive
- the host just connected
- you only need a lightweight liveness check

Use `get_status` when:

- the user says “为什么查不到”
- DB readiness is uncertain
- MCP may be disabled or misconfigured
- you need to inspect warnings or capability list

When `get_status.config.dbReady === false`:

- warn that data tools may fail
- do not keep retrying content tools blindly
- suggest finishing local DB setup before deeper queries

When `get_status.warnings` is non-empty:

- surface the warning briefly
- adapt the next route instead of ignoring it

## Fuzzy clue strategy

When the user gives weak clues such as a nickname fragment, an organization fragment, a possibly mistyped name, or a half-remembered phrase:

- Search contacts and sessions in parallel.
- Use fragment matches, nickname matches, remark matches, and organization-name matches.
- Prefer candidates with recent activity when the user implies recency.
- If a keyword is uncertain, search globally before concluding there is no evidence.
- If one query misses, reformulate the clue and try another route.

## Candidate handling

When there are multiple plausible candidates:

- Do not pretend the result is unique.
- Read `resolve_session.candidates[*].evidence` before choosing.
- Compare the top candidates using recent message preview, session kind, and contact aliases.
- Explain which candidate is currently strongest and why.
- If needed, inspect each candidate’s latest context before answering.

When `resolve_session` returns a recommendation:

- Treat `recommended.confidence` as a hint, not a blind verdict.
- Use `recommended.evidence` to explain why this candidate is strongest.
- If confidence is only `medium` or `low`, verify with `get_session_context` or `search_messages` before committing.

When `search_messages` returns global or multi-session hits:

- Read `sessionSummaries` first.
- Use `sessionSummaries` to see which session is accumulating the strongest evidence.
- Use `sampleExcerpts` to decide whether to keep narrowing, switch sessions, or confirm the lead.

When content tools already returned rows:

- read `get_messages.items[*].text`
- read `get_session_context.items[*].text`
- read `search_messages.hits[*].message.text`
- read `get_moments_timeline.items[*].contentDesc`
- answer with those fields directly instead of restating tool counts

## Battle report

After each meaningful exploration round, produce a very short battle report for yourself or the user:

- “战报：已锁定 3 个候选，下一步按备注和最近消息区分。”
- “战报：会话还不唯一，准备全局搜关键词补证据。”
- “战报：已确认目标会话，开始拉最近上下文。”

Keep it short. It should help trace the reasoning, not overshadow the answer.
Never let the battle report replace the actual answer once the content is already available.

## Export workflow

Export is a last resort, not a default detour.

When the user asks to export chat history:

1. Check whether the request already includes:
   - target session
   - time range
   - export format
   - media selections
2. If the target is fuzzy, resolve it first with `resolve_session`.
3. If the target is still ambiguous, keep narrowing and do not export yet.
4. Use `export_chat(validateOnly=true)` to audit whether the request is complete.
5. If `missingFields` is non-empty, prefer `followUpQuestions`; otherwise fall back to `nextQuestion`.
6. Ask follow-up questions until the missing fields are all resolved.
7. Prefer the configured default export directory when it exists and is writable.
8. If the default export directory is unavailable, ask the user for an output directory.
9. Only call `export_chat` without `validateOnly` after the request is complete.

When the user did not ask to export:

- do not jump to `export_chat` just because a host UI displayed a short text summary
- use export only if content tools truly returned empty arrays or the user explicitly requests an export artifact

When asking follow-up questions for export:

- ask only for missing fields
- do not ask again for fields the user already confirmed
- treat media selections as required and explicit
- do not silently assume a time range

After export finishes, summarize:

- which session was exported
- the time range
- the format
- which media were included
- where the files were written

## Moments workflow

When the user asks about朋友圈 / 动态 / 点赞 / 评论 / 某张图 / 某段时间谁发过什么:

1. If the clue is a person name / remark / nickname, start with `list_contacts(q=<clue>)`.
2. Use the matched `items[].contactId` as `get_moments_timeline.usernames[]`.
3. Treat `get_moments_timeline(limit=N)` as “latest N posts”.
4. Use `keyword` first only when the user remembers caption/topic text rather than the poster identity.
5. If `keyword` search returns multiple posters, read `nickname/username`, lock the poster, then re-run `get_moments_timeline(usernames=[...], limit=N)` before answering.
6. Add `startTime/endTime` when the user implies recency or a specific period.
7. Keep `includeRaw=false` by default.
8. Use `includeRaw=true` only when structured fields are insufficient or when debugging parser gaps.

Example:

- user asks “找找体育组张老师儿的最新三条朋友圈内容”
- first call `list_contacts(q="体育组张老师儿")`
- then call `get_moments_timeline(usernames=["zhangjunbai"], limit=3)`
- answer from `items[*].contentDesc`

For moments evidence:

- compare `contentDesc`
- compare `nickname` and `username`
- inspect `likes`
- inspect `comments`
- inspect `shareInfo`
- use `rawXml` only as a fallback, not the default reading surface

## Never do this

- Do not conclude “没有数据” after a single failed query.
- Do not skip `get_status` when readiness is obviously uncertain.
- Do not insist on exact `sessionId` when fuzzy resolution is possible.
- Do not ignore `hint` or candidate summaries returned by MCP.
- Do not ignore `evidence` on resolved candidates or `sessionSummaries` on search results.
- Do not lock onto a candidate while ambiguity is still obvious.
- Do not pass a human clue like “体育组张老师儿” directly into `get_moments_timeline.usernames[]`; resolve the real `contactId` first.
- Do not use `keyword` as the first moments filter when the user actually gave you a poster clue.
- Do not claim “the MCP only returned Loaded N ...” before checking the structured fields.
- Do not start exporting before target session, time range, format, and media selections are all confirmed.
- Do not quietly choose a time range or media mix on the user’s behalf.
- Do not default to `includeRaw=true` for moments.
- Do not use export as the default workaround when content tools already returned usable rows.

## References

- Read [references/queries.md](references/queries.md) when you need concrete fuzzy-query playbooks, fallback chains, or battle-report examples.
- Read [references/export.md](references/export.md) when the user asks to export chat history.
- Read [references/moments.md](references/moments.md) when the user asks about朋友圈、点赞、评论、转发内容或时间段动态。
