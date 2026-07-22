# CipherTalk MCP Export Playbook

## Goal

Turn vague export requests into a complete, executable export plan.

Export is a fallback when the user explicitly wants files, or when content tools truly returned no usable rows. It is not the default workaround for short tool summaries.

## Required fields before exporting

Do not export until all of these are known:

- target session
- time range
- export format
- media selections

Output directory may be omitted only if the configured default export directory is available and writable.

## Export routing

### 1. User asks to export chat history with incomplete info

Example:

- “导出聊天记录”
- “把那个人的聊天导出来”

Use this order:

1. Resolve the session if needed with `resolve_session`
2. Call `export_chat(validateOnly=true)`
3. Read `missingFields`
4. Prefer `followUpQuestions`; use `nextQuestion` only as fallback
5. Ask only for the missing fields
6. Repeat `validateOnly` until `canExport=true`
7. Call `export_chat(validateOnly=false)`

Battle report:

- “战报：导出条件还没齐，先把缺项问全。”

### 2. User gives target and format but no time range

Example:

- “导出这个会话为 html”

Use this order:

1. Confirm the target session
2. Run `export_chat(validateOnly=true)`
3. Ask for time range
4. Ask for media selections if still missing
5. Export only after validation passes

### 3. User gives almost everything

Example:

- “导出最近三个月的聊天记录为 html，只要图片和视频”

Use this order:

1. Resolve the target session if needed
2. Run `export_chat(validateOnly=true)`
3. If only `outputDir` is missing, prefer the configured default export path
4. If validation passes, export directly

Battle report:

- “战报：导出参数基本齐了，只差最后确认落盘位置。”

## How to ask follow-up questions

Ask in this priority order:

1. target session
2. time range
3. format
4. media selections
5. output directory only if default path is unavailable

When asking about media selections, be explicit:

- avatars
- images
- videos
- emojis
- voices

Do not accept vague phrasing like “带媒体” without clarifying the exact set.

## Answer style after export

Keep the export completion summary short and operational:

- exported session
- time range
- format
- included media
- output path

## Local helper

If you want a local dry-run outside MCP, use `scripts/validate-export-request.cjs` to sanity-check a request payload before wiring it into tool calls.
