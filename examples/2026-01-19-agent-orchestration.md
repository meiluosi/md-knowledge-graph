---
title: Agent 编排与工具调用
date: 2026-01-19
tags:
  - Agent
  - 推理
---

# Agent 编排

注意这个文件**没有 category**，用于验证图谱不依赖分类字段也能成立。

Agent 的奖励信号通常来自 [RLHF 奖励建模](./2026-01-12-rlhf-reward.md)。

## ReAct

Reason + Act 的循环：思考 → 选取工具 → 观察结果 → 再思考。
