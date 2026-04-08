# Experience Distillation

Phase 4 · E 阶段。把 ExperienceStore 里累积的高质量经验**蒸馏**成更通用的"lessons",存回**同一个**
ExperienceStore。Lessons 是普通 `Experience` 对象,只是带 `tags: ['lesson', ...]` 标记。

---

## 为什么不用单独的 Knowledge store?

E 阶段最初设计是 "Experience → Knowledge 自动生成",对应一个独立的 `KnowledgeStore`。
对齐时用户提了一个尖锐问题:"如果用户是我自己一个人,个人的使用经验跟 Knowledge 有什么区别?"

实测 `data/knowledge/` 不存在,而 `data/memory/experiences/` 才有真实数据。在单 operator 场景下,
两个 store 不分家。所以方案改成:

- **砍掉整个 Knowledge 子系统**(E0,commit `634116d`,删 19 文件 / -702)
- Lessons 复用 ExperienceStore,通过 `tags: ['lesson']` 约定区分
- 现有的 retriever / health / pool / cap / archive 机制全部自动生效,不加新 store、不改 schema

如果将来需要客观数据(API 返回、文档、知识库),再单独引入新 store。现在不超前设计。

---

## 数据流

```
ExperienceStore.active
        │
        ▼
 ┌─────────────────┐
 │ pickInputs()    │  剔除 tag 含 'lesson' 的、剔除 admissionScore < threshold 的
 │                 │  按 admissionScore desc 排序、截断到 maxInputs
 └────────┬────────┘
          │
          ▼  Experience[]
 ┌─────────────────┐
 │  DistillFn      │  默认 createLLMDistiller({llm}),也可注入自定义实现
 │  (LLM call)     │  meta system prompt 要求 ≥2 supporting ids、JSON 数组输出
 └────────┬────────┘
          │
          ▼  DistillProposal[]
 ┌─────────────────┐
 │ validate +      │  • supportingExperienceIds 必须 ≥2 且都在输入集合内
 │  dedup          │  • 截断到 maxLessons
 │                 │  • 用 embedder 算 cosine vs 现有 lessons,>= duplicateThreshold 标 isDuplicate
 └────────┬────────┘
          │
          ▼  DistillCandidate[]   (status: 'pending')
 ┌─────────────────┐
 │  DistillRun     │  存在 SessionManager 内存里(LRU 32),不持久化
 └────────┬────────┘
          │
          ▼  user review (UI / API)
 ┌─────────────────┐
 │  accept         │  materializeCandidate() → 新 Experience(task=lesson,
 │                 │  tags=[LESSON_TAG, ...candidate.tags], steps=[],
 │                 │  admissionScore=1.0)→ ExperienceStore.save()
 └────────┬────────┘
          │
          ▼
 ExperienceStore.active   (现在多了一条 lesson)
```

---

## 配置默认值

`DistillerOptions`(`packages/core/src/experience-distill/types.ts`):

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxInputs` | 50 | 一次喂给 LLM 的上限,防止上下文炸 |
| `maxLessons` | 5 | 一次最多产出的 lesson 数 |
| `minAdmissionScore` | 0.6 | 输入实验的最低 admissionScore 门槛 |
| `duplicateThreshold` | 0.85 | cosine 相似度 ≥ 此值 → 标 `isDuplicate=true`(不剔,只 flag) |

调用方传部分字段时,缺省的从 `DEFAULT_DISTILLER_OPTIONS` 合并。

---

## API 端点

挂在 `/api/memory/distill`(在 server 路由树里**故意**放在 `/api/memory` 之前,
让 Hono 先匹配更具体的前缀)。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/memory/distill` | body = 可选 `DistillerOptions`,**同步**返回完整 `DistillRun` |
| `GET`  | `/api/memory/distill/runs` | `{ runs: DistillRun[] }`(LRU 32,newest first) |
| `GET`  | `/api/memory/distill/runs/:id` | 单个 run |
| `POST` | `/api/memory/distill/runs/:runId/candidates/:id/accept` | `{ success, experienceId, run }` |
| `POST` | `/api/memory/distill/runs/:runId/candidates/:id/reject` | `{ success, run }` |

错误形态:
- 404 — run 或 candidate 不存在,或 candidate 不是 `pending` 状态
- 500 — distill / accept 内部抛异常(LLM 失败或 store 写盘失败)

---

## UI

`MemoryPage` 现在有两个 tab:**Experiences** | **Distillation**。

**Distillation tab**(`components/memory/DistillationPanel.tsx`):
- 顶部触发表单 — 4 个 NumberField 对应 `DistillerOptions`,Distill now 按钮
- 左侧 History sidebar — 列出最近 runs,显示状态 badge / 时间 / `inputs → candidates` 摘要
- 右侧 candidate 卡片:
  - lesson 文本 + rationale + tag chips
  - supporting experience ids(截短到 8 字符)
  - `isDuplicate` 时一条琥珀色警告,显示 closest lesson id + cosine 分
  - 状态为 `pending` 时显示 Accept / Reject 按钮
  - accept 后显示新 Experience id,状态变 `accepted`

UI 不轮询,触发 / accept / reject 都直接更新本地 state。

---

## 写一个自定义 DistillFn

`DistillFn` 是 `(input: { experiences, maxLessons }) => Promise<DistillProposal[]>`。
默认实现是 `createLLMDistiller({llm})`,但可以替换成任何实现 — 测试就用了一个 `fakeDistiller`
返回固定 proposals。

参考 `packages/core/src/experience-distill/propose-llm.ts`:
- 一段 `META_SYSTEM_PROMPT`,要求 LLM 返回 JSON 数组
- `parseProposals()` 容忍多种格式:raw JSON / ` ```json ` 块 / ` ``` ` 块 / 包在散文里的 `[...]`
- 失败时返回 `[]`,**不抛** — 让 distiller 的失败处理走通用路径

注入方式:在 SessionManager 里改 `getExperienceDistiller()`,把 `distill: createLLMDistiller(...)`
换成你的工厂。或者直接 `new ExperienceDistiller({ store, embedder, distill: yours })`。

---

## 故意不做的事

- **自动 accept**。所有 candidate 默认 `pending`,必须由用户(或上层流程)显式 accept 才落盘。
  防止 LLM 一次性污染 ExperienceStore。
- **跨 session 串扰**。Distillation 操作的是**全局** ExperienceStore,跟 session 无关 —
  这是有意的:lessons 是全局规则,不绑定单次对话。
- **dedup 直接剔重复**。重复只是**flag**(`isDuplicate=true`),用户可以选择仍然 accept
  (例如想要更精确的措辞)。
- **持久化 DistillRun**。Run 只存 SessionManager 内存里,LRU 32 cap。重启就丢。
  这是因为 run 是用户 review 流程的临时载体,接受后状态已经写到 Experience 上,run 本身没必要保存。
- **LLM judge 对 candidate 评分**。当下 dedup 用 cosine 已经够,加 LLM judge 等于多花一次 token
  解决一个并不存在的痛点。
- **fire-and-forget 异步执行**。distill 内只调一次 LLM,同步返回够用。如果未来 `maxLessons`
  拉得很大或 LLM 慢,再切换到类似 prompt optimizer 的 placeholder run id 模式。

---

## 为什么 lessons 复用 `Experience.task` 字段?

`Experience` schema 是 `{ task, steps, result, reflection, tags, ... }`。Lessons 不是任务执行,
没有 steps,也没有真正意义上的"reflection"。所以我们做了一个**有意的 schema hack**:

- `task` 字段存 lesson 的陈述句本体
- `steps = []`
- `result = 'success'`
- `reflection.lesson = task`(冗余,但让现有看 reflection 字段的代码自然适配)
- `admissionScore = 1.0`(用户已经 accept 了)
- `tags` 第一项永远是 `LESSON_TAG = 'lesson'`

这样做的理由:**避免给 schema 增加 union 类型或新 entity**。Lessons 走完全相同的 retriever
路径(被检索到时跟普通 experience 一样喂进 prompt)。Down side:看 task 字段时需要先看 tags 才知道
这是 lesson 还是真实任务。这个代价可以接受 — 有 lesson tag 就一目了然。

未来如果 lesson 数量 / 表达需求超过 `task` 字段能承载的(比如要存"适用条件" / "反例" 这些结构化字段),
再考虑给 Experience 加可选字段,或者引入独立的 `LessonStore`。

---

## 测试覆盖

`packages/core/src/experience-distill/`:
- `distiller.test.ts`(12 tests)— 输入过滤 / 短路 / supports 校验 / max 截断 / 空白过滤 /
  tags dedup / dedup flag(用 inline `fakeEmbedder`)/ 无 embedder 时跳过 dedup /
  materializeCandidate / 失败处理
- `propose-llm.test.ts`(13 tests)— JSON 解析变体(raw / ` ```json ` / ` ``` ` /
  prose-wrapped) / 异常输入 / LLM 桩调用

为什么用 inline `fakeEmbedder`:本地 bag-of-words `Embedder` 在只有 1-2 doc 的语料里 IDF 退化
为 0,无法测真实 cosine。生产环境跑 OpenAI / 兼容 API 时不会有这个问题。
