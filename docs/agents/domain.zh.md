# 领域文档

[English](domain.md) | 中文

工程类技能在探索本代码库时应如何消费其领域文档。

## 探索前先读

- 仓库根部的 **`CONTEXT.md`**，或
- 根部的 **`CONTEXT-MAP.md`**（如存在）——它指向每个 context 一份 `CONTEXT.md`；只读与主题相关的那几份。
- **`docs/adr/`** ——阅读与你要改动的领域相关的 ADR。多 context 仓库还要检查 `src/<context>/docs/adr/` 中 context 级决策。

这些文件不存在时**静默继续**：不要指出缺失，也不要建议预先创建。`/domain-modeling` 技能（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 触达）会在术语或决策实际敲定时惰性创建它们。

## 文件结构

单 context 仓库（多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多 context 仓库（根部存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用词汇表的词汇

产出命名领域概念时（issue 标题、重构提案、假设、测试名），使用 `CONTEXT.md` 定义的术语；不要漂移到词汇表明确回避的同义词。

需要的概念尚未入词汇表，是一个信号——要么你在发明项目不用的语言（重新考虑），要么存在真实缺口（记给 `/domain-modeling`）。

## 标记 ADR 冲突

产出与现有 ADR 矛盾时，显式指出而不是默默覆盖：

> _与 ADR-0007（事件溯源订单）矛盾——但值得重开，因为…_
