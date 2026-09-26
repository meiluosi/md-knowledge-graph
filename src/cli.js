#!/usr/bin/env node
/**
 * mdkg —— markdown 知识图谱构建器 / 知识库检查器
 *
 * 三种用法：
 *   出图     mdkg --posts ./content --out graph.json
 *   检查     mdkg --posts ./content --check          （可进 CI，退出码非 0 即失败）
 *   相关文章 mdkg --posts ./content --format related --out related.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { formatReport, runChecks } from "./check.js";
import { buildGraph, readCorpus } from "./graph.js";
import { computeRelated } from "./related.js";
import { toHtml, toMermaid } from "./render.js";

const FORMATS = new Set(["json", "mermaid", "html", "related"]);

const USAGE = `
mdkg —— 从 markdown 构建知识图谱，并检查知识库

用法
  mdkg [选项]

语料与输出
  -p, --posts <dir>         语料目录（默认 examples）
  -o, --out <file>          输出文件（默认写到 stdout）
  -f, --format <fmt>        json | mermaid | html | related（默认 json）
      --compact             输出不缩进（json / related 格式）

图的范围
      --min-tag-count <n>   标签出现次数低于 n 则不入图（默认 2）
      --max-nodes <n>       节点数上限（默认 200）
      --no-link-edges       不生成正文引用边（post↔post）
      --no-anchor-check     不校验 #锚点 是否存在（渲染器 slug 规则不同时用）
      --post-url <tpl>      文章 URL 模板，如 /posts/{id}/
      --tag-url <tpl>       标签 URL 模板，如 /tags/{slug}/
      --category-url <tpl>  分类 URL 模板，如 /categories/{slug}/

相关文章（--format related）
      --related-top <n>         每篇保留几篇（默认 5）
      --related-min-score <n>   低于此分不输出（默认 1）

检查
      --check               只跑检查并打印报告，不进图
      --strict              连警告也算失败（需与 --check 同用）

  -h, --help                显示本帮助

退出码
  0  正常；检查模式下无错误（或仅警告且未加 --strict）
  1  出错（参数错、语料读不到）；或检查模式下发现错误

示例
  # 最小用法：给自己的博客出一张图
  mdkg --posts src/content/posts --out graph.json

  # 进 CI：断链会让构建失败
  mdkg --posts content --check

  # 连警告也不放过（长尾标签、无标签文章）
  mdkg --posts content --check --strict

  # 生成「相关阅读」数据，供博客消费
  mdkg --posts content --format related --out related.json --related-top 5

  # 离线可视化
  mdkg --posts content --out graph.html --format html
`;

/**
 * 解析并校验一个非负整数参数。
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function toNonNegativeInt(raw, fallback, name) {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`--${name} 需要一个非负整数，收到：${raw}`);
	}
	return n;
}

async function main() {
	const { values } = parseArgs({
		options: {
			posts: { type: "string", short: "p", default: "examples" },
			out: { type: "string", short: "o" },
			format: { type: "string", short: "f", default: "json" },
			"min-tag-count": { type: "string" },
			"max-nodes": { type: "string" },
			"no-link-edges": { type: "boolean", default: false },
			"no-anchor-check": { type: "boolean", default: false },
			"post-url": { type: "string" },
			"tag-url": { type: "string" },
			"category-url": { type: "string" },
			"related-top": { type: "string" },
			"related-min-score": { type: "string" },
			check: { type: "boolean", default: false },
			strict: { type: "boolean", default: false },
			compact: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
	});

	if (values.help) {
		process.stdout.write(USAGE);
		return;
	}

	if (values.strict && !values.check) {
		throw new Error("--strict 需要与 --check 一起使用。");
	}

	const format = String(values.format).toLowerCase();
	if (!FORMATS.has(format)) {
		throw new Error(`不支持的 --format：${values.format}（可选 ${[...FORMATS].join(" / ")}）`);
	}

	const postsDir = path.resolve(String(values.posts));
	const minTagCount = toNonNegativeInt(values["min-tag-count"], 2, "min-tag-count");
	const maxNodes = toNonNegativeInt(values["max-nodes"], 200, "max-nodes");
	const relatedTop = toNonNegativeInt(values["related-top"], 5, "related-top");
	const relatedMinScore = toNonNegativeInt(values["related-min-score"], 1, "related-min-score");

	process.stderr.write(`读取语料：${postsDir}\n`);
	const { posts, skipped } = await readCorpus(postsDir);

	if (posts.length === 0) {
		throw new Error(
			`在 ${postsDir} 里没有找到带 title 的 markdown 文件。\n` +
				`请确认目录正确，且文件的 frontmatter 里有 title 字段。`,
		);
	}

	const graph = buildGraph(posts, {
		minTagCount,
		maxNodes,
		linkEdges: !values["no-link-edges"],
		anchorCheck: !values["no-anchor-check"],
		postUrl: values["post-url"],
		tagUrl: values["tag-url"],
		categoryUrl: values["category-url"],
	});

	// ---- 检查模式 ----
	if (values.check) {
		const result = runChecks({ posts, skipped, graph, minTagCount });
		process.stdout.write(formatReport(result, { label: path.basename(postsDir) }));

		const failed = result.errors > 0 || (values.strict && result.warnings > 0);
		process.exitCode = failed ? 1 : 0;
		return;
	}

	// ---- 输出模式 ----
	let output;
	if (format === "mermaid") {
		output = toMermaid(graph);
	} else if (format === "html") {
		output = toHtml(graph, { title: `${path.basename(postsDir)} · 知识图谱` });
	} else if (format === "related") {
		const related = computeRelated(posts, { linkEdges: graph.links.edges }, {
			top: relatedTop,
			minScore: relatedMinScore,
		});
		output = `${JSON.stringify(related, null, values.compact ? 0 : 2)}\n`;
	} else {
		output = `${JSON.stringify(graph, null, values.compact ? 0 : 2)}\n`;
	}

	if (values.out) {
		const outPath = path.resolve(String(values.out));
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		await fs.writeFile(outPath, output, "utf8");
		process.stderr.write(`输出：${outPath}\n`);
	} else {
		process.stdout.write(output);
	}

	const { meta } = graph;
	process.stderr.write(
		`完成：${meta.postsInGraph}/${meta.posts} 篇文章入图，` +
			`${meta.tagsInGraph}/${meta.tags} 个标签，${meta.categories} 个分类，` +
			`${graph.nodes.length} 个节点，${graph.edges.length} 条边` +
			`（含 ${meta.linkEdges} 条正文引用）` +
			`${meta.truncated ? "，已按 --max-nodes 裁剪" : ""}\n`,
	);
	if (meta.brokenLinks > 0 || meta.brokenAnchors > 0) {
		const parts = [];
		if (meta.brokenLinks > 0) parts.push(`${meta.brokenLinks} 条断链`);
		if (meta.brokenAnchors > 0) parts.push(`${meta.brokenAnchors} 个失效锚点`);
		process.stderr.write(
			`提示：发现 ${parts.join("、")}。运行 mdkg --posts ${values.posts} --check 查看明细。\n`,
		);
	}
}

main().catch((err) => {
	process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
