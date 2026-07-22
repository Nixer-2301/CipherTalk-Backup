# CipherTalk MCP Query Playbook

## Quick playbooks

### 1. User gives a vague person clue

Example:

- “帮我查那个昵称像英文名的人最近聊了什么”
- “那个带组织备注的人”

Use this order:

1. `list_contacts(q=<clue>)`
2. `list_sessions(q=<clue>)`
3. If the clue is weak, run `resolve_session(query=<clue>)`
4. Read `recommended`, `confidence`, and `evidence`
5. Compare candidates
6. `get_session_context` on the best candidate
7. If still uncertain, `search_messages` with a related keyword

Battle report:

- “战报：联系人和会话都已起底，先核对最近上下文。”

### 2. User may remember the name wrong

Example:

- “名字可能记错了，只记得一半”

Use this order:

1. Search multiple variants in contacts and sessions
2. Run `resolve_session` on the variants if needed
3. Prefer overlap between results
4. If multiple hits remain, inspect latest context for top candidates
5. Tell the user which one looks most plausible and why

Battle report:

- “战报：记忆有偏差，先用别名和片段交叉排嫌疑人。”

### 3. User wants more data, not just one answer

Example:

- “你自己多查点”
- “再深挖一点”

Use this order:

1. Resolve the most likely session
2. Read `resolve_session.recommended.evidence`
3. Pull latest context
4. Search related keywords globally or across nearby candidates
5. Use `search_messages.sessionSummaries` to see which session owns most of the evidence
6. Add timing clues, active hours, or contact rankings if useful

Battle report:

- “战报：主目标已确认，开始扩线索，不只看单条聊天。”

### 4. Keyword is weak or typo-prone

Example:

- user only remembers half a phrase
- user remembers a nickname that might be wrong

Use this order:

1. Fuzzy person lookup first
2. Global `search_messages`
3. Read `sessionSummaries` before digging into raw hits
4. Narrow back to candidate sessions
5. Re-run `search_messages` inside the best session(s)

Battle report:

- “战报：关键词不稳，先撒网再回收。”

### 5. Tool readiness is uncertain

Example:

- “怎么什么都查不到”
- “MCP 是不是没连上”

Use this order:

1. `health_check`
2. `get_status`
3. Read `config.dbReady`
4. Read `warnings`
5. Only then decide whether to continue with session/message tools

Battle report:

- “战报：先查活性和就绪状态，避免盲查空库。” 

### 6. User actually means朋友圈，不是聊天消息

Example:

- “查下他朋友圈最近发了什么”
- “看下谁给这条朋友圈点过赞”
- “找找体育组张老师儿的最新三条朋友圈内容”

Use this order:

1. If the clue is a person identity, run `list_contacts(q=<clue>)`
2. Read the best hit’s `items[].contactId`
3. Call `get_moments_timeline(usernames=[contactId], limit=<N>)`
4. Add `startTime/endTime` when period clue exists
5. Use `keyword` first only when the clue is about post body text rather than the poster identity
6. Keep `includeRaw=false` unless debugging parser gaps

When answering:

- read `items[*].contentDesc`
- if `keyword` search surfaced multiple posters, lock the target `username` and re-run the query by `usernames=[...]`
- do not stop at “Loaded N moments posts” when rows are present

Battle report:

- “战报：目标是朋友圈，不走聊天消息链路，直接拉时间线。”

## Candidate comparison checklist

When choosing among multiple sessions, compare:

- contact remark
- nickname
- display name
- recent message preview
- last active timestamp
- session kind

## Answer style

When the evidence is strong:

- state the likely target directly
- mention the evidence briefly
- prefer quoting `resolve_session.evidence` or `sessionSummaries` over hand-wavy justification
- when content rows are already present, answer from `items[*].text` / `items[*].contentDesc` instead of summarizing tool counts

When the evidence is mixed:

- name the top candidate
- mention 1-2 backup candidates
- say what you checked to distinguish them
- mention which evidence is still missing

When evidence is still weak:

- say it is not fully locked yet
- continue querying instead of stopping early
- say which next tool call is most likely to break the tie

## Status reading checklist

When reading `get_status`, pay attention to:

- `config.dbReady`
- `config.mcpEnabled`
- `warnings`
- `capabilities.tools`

If `dbReady=false`:

- stop escalating to content-heavy tools
- explain that DB-backed tools may return nothing or fail
