# DeepSight research kit

A DeepSight deep-research kit for [DeepSeek Harness](https://github.com/deepseek-ai): one agent preset, the DeepSight methodology skill bundled in this package, and three deterministic tools.

DeepSight 本身是一套 **AI 驱动的结构化深度研究方法论**（[deeparchi-ai/deepsight](https://github.com/deeparchi-ai/deepsight)，MIT）。这个包把它装进 DeepSeek Harness：知识层是 skill，纪律层是 preset，算力层是三个工具加一道出口闸门。

## 装什么

| 层 | 内容 |
|---|---|
| Agent preset | `deepsight` —— 把 Phase 0.0 / 0.1 / 0.2 / 1 / 2 / 3 的强制顺序写进 persona |
| Skill | `deepsight` —— 八套框架、七套对抗模板、约束链、Council 协议；随包分发，装完即用 |
| 工具 | `deepsight_contract` / `deepsight_audit` / `deepsight_trend` |
| 闸门 | `verdict = block` 时拒绝 `present`，阻止违规结论直接交付 |

## 三个工具

**`deepsight_contract`** —— 开跑前锁定验收契约：按决策落点选框架（八选一）、定轻量/深度、定证据阈值、判定是否必须先做反方论证。返回 `runId`。

**`deepsight_audit`** —— 提交结论账本，返回确定性判定：`[A]/[B]/[C]` 占比、`[B]` 超限退回、独立模型族 `D` 与证据级封顶、未闭环冲突、**行动依据的来源链检查**（沿 `basisClaimIds` 做传递闭包，出现 `[C]` 或未声明来源即拦）。

**`deepsight_trend`** —— 只读账本，汇总跨报告趋势；`write: true` 会覆盖写一份 Markdown 笔记。

占比、封顶、来源链追溯都由工具计算，不交给模型心算——这是它存在的理由。

## 这道刹车管什么，不管什么

**它保证**：行动依据没有从 `[C]` 级结论派生而来，且每条行动依据都声明了来源。

**它不保证**：标签本身正确。模型可以把一条经验估计声明成「一级观察」（`basisClaimIds: []`）并标 `[B]`，为任意决策接一根干净来源——这是一处**有意接受的边界**，原因写在 `docs/DETAIL.md` 里：`[B]` 与 `[C]` 的边界在方法论本体中并未操作化，加字段只是把自报往前推一层。

因此：**`pass` 不表示证据充分。** 它只表示来源链干净。交付物抬头应当照实写出这句话。

## 这套机制是怎么来的

不是设计出来的，是三次实测逼出来的：

| 版本 | 测试 | 结果 | 学到什么 |
|---|---|---|---|
| 0.3 | 无证据 + 强要建议 | 未触发 | 模型用「拒绝」守住，测试没测到刹车 |
| 0.3 | 禁检索 + 强制给市场规模 | **被绕过** | 把 `f([C])` 派生值标成 `[B]` 直引，闸门看不见派生 |
| 0.4 | 同一道题 | **合法放行** | 主动隔离 8 条 `[C]`、声明来源，闭包干净 |

细节与残留边界见 [`docs/DETAIL.md`](docs/DETAIL.md)。

## 边界

- `verdict` 是**概率性约束**，不是硬保证。没有机制能拦截最终散文；模型仍可绕过工具直接下结论，或用 `write` 代替 `present`。它的作用是让「跳过」留痕，不是让跳过不可能。
- `D` 值来自调用方自报（`council.modelFamilies`）。工具算得准，前提是如实填报。
- Phase 3 报告交付层未实现，由 Harness 的既有能力承担。
- skill 正文取自上游方法论，其中提到的部分搜索工具在本 Harness 中不存在；这些段落保留原样，模型会按实际可用工具降级。

## 安装

在 DeepSeek Harness 的 **Plugins** 页面添加本地目录或安装本包，然后新建会话时把 Agent 模式选为 **DeepSight 深度推理研究法**。

## License

MIT。方法论内容来自 [`deeparchi-ai/deepsight`](https://github.com/deeparchi-ai/deepsight)，© 2026 DeepArchi (Kuang Mi)，按 MIT 原样分发。
