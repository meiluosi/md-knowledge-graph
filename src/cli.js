#!/usr/bin/env node
/**
 * mdkg —— markdown 知识图谱构建器 CLI
 *
 * 用法示例：
 *   mdkg --posts ./content --out graph.json
 *   mdkg -p ./content -o graph.html -f html
 *   mdkg -p ./content -o graph.mmd -f mermaid --min-tag-count 1
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildGraph, readPosts } from "./graph.js";
import { toHtml, toMermaid } from "./render.js";

const FORMATS = new Set(["json", "mermaid", "html"]);

const USAGE = `
mdkg —— 从 markdown frontmatter 构建知识图谱

用法
  mdkg [选项]

选项
  -p, --posts <dir>         语料目录（默认 examples）
  -o, --out <file>          输出文件（默认写到 stdout）
  -f, --format <fmt>        json | mermaid | html（默认 json）
      --min-tag-count <n>   标签出现次数低于 n 则不入图（默认 2）
      --max-nodes <n>       节点数上限（默认 200）
      --post-url <tpl>      文章 URL 模板，如 /posts/{id}/
      --tag-url <tpl>       标签 URL 模板，如 /tags/{slug}/
      --category-url <tpl>  分类 URL 模板，如 /categories/{slug}/
      --compact             输出不缩进（json 格式）
  -h, --help                显示本帮助

示例
  # 最小用法：拿自己的博客跑一遍
  mdkg --posts src/content/posts --out graph.json

  # 生成可直接在浏览器打开、离线可用的可视化
  mdkg --posts ./notes --out graph.html --format html

  # 生成可贴进 README 的 Mermaid（无需截图）
  mdkg --posts ./notes --out graph.mmd --format mermaid

  # 复刻 Astro 站点的 URL 结构
  mdkg --posts src/content/posts \\
       --post-url "/posts/{id}/" --tag-url "/tags/{slug}/" \\
       --category-url "/categories/{slug}/" --out graph.json
`;

/**
 * 解析并校验一个正整数参数。
 * @param {string|undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function toPositiveInt(raw, fallback, name) {
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
			"post-url": { type: "string" },
			"tag-url": { type: "string" },
			"category-url": { type: "string" },
			compact: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: false,
	});

	if (values.help) {
		process.stdout.write(USAGE);
		return;
	}

	const format = String(values.format).toLowerCase();
	if (!FORMATS.has(format)) {
		throw new Error(`不支持的 --format：${values.format}（可选 ${[...FORMATS].join(" / ")}）`);
	}

	const postsDir = path.resolve(String(values.posts));
	const minTagCount = toPositiveInt(values["min-tag-count"], 2, "min-tag-count");
	const maxNodes = toPositiveInt(values["max-nodes"], 200, "max-nodes");

	process.stderr.write(`读取语料：${postsDir}\n`);
	const posts = await readPosts(postsDir);

	if (posts.length === 0) {
		throw new Error(
			`在 ${postsDir} 里没有找到带 title 的 markdown 文件。\n` +
				`请确认目录正确，且文件的 frontmatter 里有 title 字段。`,
		);
	}

	const graph = buildGraph(posts, {
		minTagCount,
		maxNodes,
		postUrl: values["post-url"],
		tagUrl: values["tag-url"],
		categoryUrl: values["category-url"],
	});

	let output;
	if (format === "mermaid") {
		output = toMermaid(graph);
	} else if (format === "html") {
		output = toHtml(graph, { title: `${path.basename(postsDir)} · 知识图谱` });
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
			`${meta.truncated ? "（已按 --max-nodes 裁剪）" : ""}\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
