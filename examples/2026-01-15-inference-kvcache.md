---
title: "推理优化：KV Cache 与 PagedAttention"
date: 2026-01-15
category: 推理
tags:
  - 推理
  - 量化
---

# 推理优化

标题里带冒号，用于验证 frontmatter 解析不会被冒号切断。

## KV Cache

显存占用随序列长度线性增长，是长上下文推理的主要瓶颈。

## PagedAttention

把 KV cache 切成固定大小的块，用页表管理，消除显存碎片。
