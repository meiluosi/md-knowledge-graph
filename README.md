# md-knowledge-graph

指一个 markdown 目录给它，它产出三样东西：**知识图谱**、**知识库检查报告**、**相关文章数据**。

与框架无关——读的是 markdown 源文件，不需要先 build。

[![CI](https://github.com/meiluosi/md-knowledge-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/meiluosi/md-knowledge-graph/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18.3-3c873a)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/dependencies-2-blue)

> 它守的是**那种不会喊叫的失效**：链接指向的章节被改名了、标签写法前后不一致、
> 文章被删了但引用还在。这些都不会让任何东西崩，只会让知识库慢慢烂掉。
> `--check` 把它们变成一条非零退出码。

---

## 它做什么

```bash
mdkg --posts ./content --out graph.json            # 图
mdkg --posts ./content --check                     # 检查（退出码可进 CI）
mdkg --posts ./content -f related -o related.json  # 相关文章
```

图里有三种边：文章→标签、文章→分类，以及**文章→文章**（正文里写的链接，含 `[[wikilink]]`）。

检查的重点是**那些不会喊叫的失效**：

| 检查项 | 级别 | 典型场景 |
|---|---|---|
| **失效锚点** | 错误 | `[契约](design.md#api-contract)` —— 章节改名了，文件还在，链接已经死了 |
| **正文断链** | 错误 | 引用的文件被删或路径写错 |
| frontmatter 解析失败 | 错误 | YAML 语法错误 |
| 无标签文章 / 只出现一次的标签 | 警告 | 长尾标签，靠分类或引用才连得上 |
| 标签写法不一致 | 警告 | `PEFT` 与 `peft` 会被合并，确认不是笔误 |
| 孤立节点 / 自引用 | 警告 | 图里的孤岛 |

锚点校验按 GitHub 的 slug 规则（用 `github-slugger`，参考实现）。渲染器规则不同的站点用 `--no-anchor-check` 关掉。

## Quickstart

```bash
git clone https://github.com/meiluosi/md-knowledge-graph.git
cd md-knowledge-graph && npm install
npm run example        # → examples/graph.json
```

自带 `examples/` 语料，所以上面这条不依赖任何私有数据。

## 用法

| 选项 | 说明 | 默认 |
|---|---|---|
| `-p, --posts <dir>` | 语料目录，递归读取 `.md` / `.mdx` | `examples` |
| `-o, --out <file>` | 输出文件；省略则写 stdout | — |
| `-f, --format <fmt>` | `json` \| `mermaid` \| `html` \| `related` | `json` |
| `--min-tag-count <n>` | 标签出现次数低于 n 不入图 | `2` |
| `--max-nodes <n>` | 节点数上限 | `200` |
| `--no-link-edges` | 不生成正文引用边 | — |
| `--no-anchor-check` | 不校验 `#锚点` 是否存在 | — |
| `--post-url` / `--tag-url` / `--category-url` | URL 模板，如 `/posts/{id}/` | — |
| `--check` / `--strict` | 只跑检查；`--strict` 让警告也算失败 | — |
| `--related-top` / `--related-min-score` | 相关文章数量与阈值 | `5` / `1` |

**退出码**：`0` 正常或检查无错误；`1` 参数/语料错误，或检查发现错误。

## 输出

<details>
<summary><b>图</b>（点击展开 —— 实线是归属，虚线是引用）</summary>

```mermaid
graph LR
  cat:微调{{"微调"}}
  cat:对齐{{"对齐"}}
  cat:推理{{"推理"}}
  cat:杂记{{"杂记"}}
  tag:lora("LoRA")
  tag:微调("微调")
  tag:peft("PEFT")
  tag:qlora("QLoRA")
  tag:量化("量化")
  tag:rlhf("RLHF")
  tag:推理("推理")
  tag:agent("Agent")
  tag:冷门标签("冷门标签")
  post:2026-01-05-lora-rank["LoRA 低秩微调：秩的选取与实测"]
  post:2026-01-08-qlora-4bit["QLoRA：4-bit 量化下的微调"]
  post:2026-01-12-rlhf-reward["RLHF 奖励建模"]
  post:2026-01-15-inference-kvcache["推理优化：KV Cache 与 PagedAttention"]
  post:2026-01-19-agent-orchestration["Agent 编排与工具调用"]
  post:2026-01-22-rare-note["一次只出现一次的冷门笔记"]
  post:2026-01-05-lora-rank --> cat:微调
  post:2026-01-05-lora-rank --> tag:lora
  post:2026-01-05-lora-rank --> tag:微调
  post:2026-01-05-lora-rank --> tag:peft
  post:2026-01-08-qlora-4bit --> cat:微调
  post:2026-01-08-qlora-4bit --> tag:qlora
  post:2026-01-08-qlora-4bit --> tag:量化
  post:2026-01-08-qlora-4bit --> tag:微调
  post:2026-01-08-qlora-4bit --> tag:peft
  post:2026-01-12-rlhf-reward --> cat:对齐
  post:2026-01-12-rlhf-reward --> tag:rlhf
  post:2026-01-15-inference-kvcache --> cat:推理
  post:2026-01-15-inference-kvcache --> tag:推理
  post:2026-01-15-inference-kvcache --> tag:量化
  post:2026-01-19-agent-orchestration --> tag:agent
  post:2026-01-19-agent-orchestration --> tag:推理
  post:2026-01-22-rare-note --> cat:杂记
  post:2026-01-22-rare-note --> tag:冷门标签
  post:2026-01-05-lora-rank -.-> post:2026-01-08-qlora-4bit
  post:2026-01-08-qlora-4bit -.-> post:2026-01-05-lora-rank
  post:2026-01-12-rlhf-reward -.-> post:2026-01-08-qlora-4bit
  post:2026-01-15-inference-kvcache -.-> post:2026-01-08-qlora-4bit
  post:2026-01-19-agent-orchestration -.-> post:2026-01-12-rlhf-reward
```

</details>

**检查报告** —— 示例语料故意留了缺陷，所以这段是真实可复现的：

```
$ mdkg --posts examples --check
✗ 正文断链（目标文件不存在） —— 1 项
    2026-01-08-qlora-4bit  →  ./2026-01-01-deleted-draft.md
✗ 失效锚点（文件存在，但章节不存在） —— 2 项
    2026-01-08-qlora-4bit  →  2026-01-15-inference-kvcache  #flash-attention
    2026-01-08-qlora-4bit  →  （本文）  #不存在的小节
⚠ 只出现一次的标签 —— 5 项
⚠ 写法不一致的标签 —— 1 项     PEFT / peft  →  合并为「peft」，共 2 篇
错误 3 · 警告 6  →  退出码 1
```

同样的语料里还有**有效**的锚点（`#kv-cache`、`#pagedattention`、`#react`）和代码块里的**假**锚点——两者都不会被报出来。这是刻意的：误报会让门禁被关掉。

**相关文章** —— 带 `schemaVersion`，可直接给博客的「相关阅读」消费：

```json
{ "schemaVersion": 1, "posts": [
  { "id": "2026-01-19-agent-orchestration",
    "related": [ { "id": "2026-01-12-rlhf-reward", "score": 3, "reasons": ["link"] } ] } ] }
```

打分：正文引用 +3 / 被引用 +3 / 每个共享标签 +2 / 同分类 +1。同分按 id 升序，**保证顺序确定**——否则每次跑出来的"相关阅读"都在变，没法对比。

`--format html` 另有一个自包含、离线可用的力导向图（单文件、无 CDN、可拖拽），适合当调试预览。

## 与现有工具的差别

这个领域分项都有强手，但交集是空的：

| 工具 | 形态 | 它做了哪部分 | 局限 |
|---|---|---|---|
| Obsidian / Logseq / Dendron | 桌面应用 | 图谱、wikilink | 笔记要迁进它的 vault；不给你数据 |
| [Foam](https://github.com/foambubble/foam) | VS Code 扩展 | 同上 | 绑定编辑器 |
| [Quartz](https://quartz.jzhao.xyz/) | 静态站点生成器 | 图谱页面 | 得把站点迁到它上面 |
| [lychee](https://github.com/lycheeverse/lychee) / linkinator | CLI | 断链 | 只查链接，不产出图与相关文章 |
| Hugo `.Related` / Jekyll 插件 | 框架内建 | 相关文章 | 只在那个框架里 |
| [remark-wiki-link](https://www.npmjs.com/package/remark-wiki-link) | 库 | 解析 wikilink | 只解析 |

**mdkg 的差异是：框架无关 + 读到锚点一级 + 一次产出三种数据。**

"读到锚点一级"是它跟链接检查工具真正分开的地方——lychee 那一类验的是**链接能不能打开**，而这里验的是**引用还在不在**：文件在、章节改名了，它照样报错。规格文档最常见的失效正是这一类。

它不跟 Obsidian 抢可视化，也不跟 lychee 抢全站链接爬取。

## 在 CI 里用它

```yaml
- run: npx md-knowledge-graph --posts content --check
```

断链会让这一步失败。只想加警告门禁时用 `--strict`。

## What didn't work

开发中真正踩过的坑，完整版见 [`docs/what-didnt-work.md`](./docs/what-didnt-work.md)。最值得记的三条：

- **手写 frontmatter 解析器静默丢数据**：`tags: [A, B]` 和 `tags: A` 都会变成 `[]`，且不报错。这就是引入 `gray-matter` 的原因。
- **同概念两种写法产出畸形图**：`PEFT` 与 `peft` 曾经生成两个 **id 相同**的节点，破坏图的完整性，而不是"多一个点"。修复后又发现检查器用了另一套口径——**它一边警告"会合并"，一边按两种拼写各报一次**。
- **我把测试断言写错过两次**，两次都差点去改一个本来正确的实现。所以：测试失败时，先怀疑测试。

## 已知取舍

- 不做 `tag ↔ tag` 共现边（数量是标签数的平方级，语料一大图就糊）
- 链接目标同名时**宁可判为断链**，也不猜一个
- 锚点按 **GitHub 的 slug 规则**（`github-slugger`）；渲染器规则不同的站点请用 `--no-anchor-check`
- 锚点不覆盖 HTML 里手写的 `<h2 id="...">`；Setext 标题（下划线式）支持
- Mermaid 输出不适合超过约 100 个节点，那个规模用 `--format html`
- 不提取正文里的实体或关键词；相关文章不做全局图算法（PageRank、社区发现）
- 只检查本地语料内的引用，不发起网络请求验证外部链接
- **依赖说清楚**：2 个直接依赖，安装后共 **11 个依赖包**。`github-slugger` 零传递依赖；`gray-matter` 带进 9 个传递依赖。选它是因为自研 frontmatter 解析会**静默丢数据**——见 [`docs/what-didnt-work.md`](./docs/what-didnt-work.md)

## License

[MIT](./LICENSE)
