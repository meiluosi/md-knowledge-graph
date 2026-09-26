---
title: Agent 编排与工具调用
date: 2026-01-19
tags:
  - Agent
  - 推理
---

# Agent 编排

注意这个文件**没有 category**，用于验证图谱不依赖分类字段也能成立。

Agent 的奖励信号通常来自 [RLHF 奖励建模](./2026-01-12-rlhf-reward.md)，
而工具调用的显存开销可以参考
[PagedAttention 那节](./2026-01-15-inference-kvcache.md#pagedattention)。

## ReAct

Reason + Act 的循环：思考 → 选取工具 → 观察结果 → 再思考。

## 本文内的锚点

同文件引用用起来是这样：[回到 ReAct](#react) —— 这个锚点是有效的。

代码块里的假锚点不应被识别：

```
见 [假锚点](#not-real)
```
