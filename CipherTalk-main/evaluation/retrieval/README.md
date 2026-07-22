# 检索评测（L1）

量化**语义向量检索的召回质量**——不跑 agent、不调 LLM 对话，只测"该召回的消息片段有没有被召回"。
是 agent 端到端评测（L2）的地基：检索召不回，agent 再聪明也答不对。

## 怎么跑

```bash
npm run eval:retrieval -- --cases evaluation/retrieval/baseline.local.jsonl --k 10
# 或
node scripts/run-retrieval-evaluator.cjs --cases evaluation/retrieval/baseline.local.jsonl --k 10
```

> 脚本会自动用 Electron 的 node 重启自己（better-sqlite3 按 Electron ABI 编译，普通 node 加载不了），无需手动设环境变量。

参数：
- `--cases <file>`：用例 JSONL，默认 `evaluation/retrieval/baseline.local.jsonl`。
- `--k <n>`：recall@k 的 k，默认 10。

## 前置条件

1. **配好嵌入模型**（设置 → 嵌入）——查询要用它算向量。
2. **已在 app 里对相关会话做过语义检索**——向量是懒构建的，没建过的会话脚本里会显示"跳过"（脚本不连原微信库，不会现场建）。

## 用例格式

每行一个 JSON（见 [`baseline.example.jsonl`](./baseline.example.jsonl)）。真实用例存 **`baseline.local.jsonl`**（已 gitignore 思路：别提交真实 `sessionId`/`localId`/`createTime`/`sortSeq`）。

```json
{
  "id": "case_001",
  "sessionId": "wxid_xxx 或 xxx@chatroom",
  "question": "他上次答应我什么事情？",
  "semanticQuery": "对方曾经承诺要完成某件事情",
  "expectedEvidence": [{ "localId": 123, "createTime": 1710000000, "sortSeq": 456 }],
  "expectedKeywords": ["答应", "周末", "帮你"]
}
```

字段：
- `sessionId`：限定检索的会话（必填，向量按会话存）。
- `question` / `semanticQuery`：检索用 `semanticQuery`（没有则用 `question`）作为查询文本。
- `expectedEvidence[]`：期望命中的消息，**`sortSeq` 用于判定命中**（片段是多条消息合并，证据的 sortSeq 落在某命中片段的 `[startSortSeq, endSortSeq]` 区间即算"覆盖"）。`localId` 作回退匹配。
- `expectedKeywords`：留给关键词/混合模式用，当前向量模式未使用。

## 出题建议

- 从自己真实聊过的事出题，每题 1~3 条 `expectedEvidence`（在 app 里搜到那条消息，记下它的 localId/sortSeq/createTime）。
- 覆盖几类：具体承诺/约定、某话题的讨论、模糊指代（"那个事"）、时间相关。
- 20~50 题起步即可看出趋势。改了片段切分/嵌入模型后重跑对比 `meanRecall` / `MRR`。

## 指标

- **recall@k**：top-k 片段覆盖了多少比例的期望证据。
- **MRR**：首个命中片段名次的倒数均值（越高=相关片段越靠前）。
- **fullyCovered**：完全覆盖（recall=1）的题数。

## 范围 / 未做

- 当前只评**向量**检索。关键词 / 混合（RRF）模式待补——需把 `semantic_search` 的融合逻辑抽成可复用函数，或脚本内直接查 `message_index`（FTS）。
- 打分逻辑在 [`score.cjs`](./score.cjs)（纯函数，已单测）。
- **L2 agent 端到端评测**（工具路径 / 必含事实 / 红队）需在 app 内加 dev 入口跑（复用运行时的库+key），另立。
