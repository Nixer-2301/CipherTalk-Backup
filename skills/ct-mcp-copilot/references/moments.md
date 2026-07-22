# CipherTalk MCP Moments Playbook

## When to switch to moments

Use `get_moments_timeline` when the user asks about:

- 朋友圈
- 动态
- 点赞
- 评论
- 分享卡片
- 某个人最近发过什么
- 某段时间发过什么

Do not default to chat tools when the user is clearly asking about Moments content.

## Query patterns

### 1. Poster is known

Use:

1. If the user gave a person name / remark / nickname, run `list_contacts(q=<clue>)` first
2. Use the matched `items[].contactId` in `get_moments_timeline(usernames=[...])`
3. Treat `limit=N` as “latest N posts”
4. Add `startTime/endTime` if the request implies a period
5. Add `keyword` only if the user also remembers caption fragments

### 2. Poster is unknown, topic is known

Use:

1. `get_moments_timeline(keyword=<clue>)`
2. Read matching `nickname/username`
3. Lock the target `username`
4. Re-run `get_moments_timeline(usernames=[...], limit=<N>)`
5. Narrow by time range if needed

### 3. User asks about interactions

Check in each item:

- `likes`
- `comments`
- `shareInfo`

### 4. Structured fields are insufficient

Only then:

- retry with `includeRaw=true`
- inspect `rawXml` as a string fallback

## Answering

- Read post text from `items[*].contentDesc`
- If `contentDesc` is empty, fall back to share/title clues before saying there is no text
- Do not tell the user “the MCP only returned Loaded N ...” when `items[]` already contains rows

## Example

- user asks “找找体育组张老师儿的最新三条朋友圈内容”
- run `list_contacts(q="体育组张老师儿")`
- use `contactId=zhangjunbai`
- run `get_moments_timeline(usernames=["zhangjunbai"], limit=3)`
- answer with the three `contentDesc` values directly

## Battle report

- “战报：先按发帖人拉朋友圈时间线。”
- “战报：正文线索不够，准备补时间范围。”
- “战报：结构化字段不够，最后才开 rawXml。”
