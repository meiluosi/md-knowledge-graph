#!/usr/bin/env node
/**
 * mdkg —— markdown 知识图谱构建器 / 知识库检查器
 *
 * 四种用法：
 *   出图     mdkg --posts ./content --out graph.json
 *   检查     mdkg --posts ./content --check                 （退出码可进 CI）
 *   基线     mdkg --posts ./content --update-baseline .mdkg-baseline.json
 *   相关文章 mdkg --posts ./content --format related --out related.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	applyBaseline,
	buildBaseline,
	parseBaseline,
	serializeBaseline,
} from "./baseline.js";
import { formatGithubAnnotations, formatReport, runChecks, toJsonReport } from "./check.js";
import { buildGraph, readCorpus } from "./graph.js";
import { computeRelated } from "./related.js";
import { toHtml, toMermaid } from "./render.js";

const GRAPH_FORMATS = new Set(["json", "mermaid", "html", "related"]);
const CHECK_FORMATS = new Set(["text", "json", "github"]);

const USAGE = `
mdkg —— 从 markdown 构建知识图谱，并检查知识库

用法
  mdkg [选项]

语料与输出
  -p, --posts <dir>         语料目录（默认 examples）
  -o, --out <file>          输出文件（默认写到 stdout）
  -f, --format <fmt>        出图：json | mermaid | html | related（默认 json）
                            检查：text | json | github（默认 text）
      --compact             输出不缩进（json / related 格式）

图的范围
      --min-tag-count <n>   标签出现次数低于 n 则不入图（默认 2）
      --max-nodes <n>       节点数上限（默认 200）
      --no-link-edges       不生成正文引用边（post↔post）
      --no-anchor-check     不校验 #锚点 是否存在
      --post-url <tpl>      文章 URL 模板，如 /posts/{id}/
      --tag-url <tpl>       标签 URL 模板，如 /tags/{slug}/
      --category-url <tpl>  分类 URL 模板，如 /categories/{slug}/

相关文章（--format related）
      --related-top <n>         每篇保留几篇（默认 5）
      --related-min-score <n>   低于此分不输出（默认 1）

检查与基线
      --check               只跑检查并打印报告，不进图
      --strict              连警告也算失败（需与 --check 同用）
      --baseline <file>     忽略基线里已记录的问题，只对**新增**问题失败
      --update-baseline <file>
                            把当前全部问题写成基线文件（维护动作，总是退出 0）

  -h, --help                显示本帮助

退出码
  0  正常；检查模式下没有**新增**错误（或仅有新增警告且未加 --strict）
  1  出错（参数错、语料读不到）；或检查模式下发现新增错误

为什么需要基线
  一个攒了 40 条历史断链的知识库，第一次跑 --check 就会拿到 40 个错误、
  退出码 1。人不会去修那 40 条——他会在 CI 里删掉这一步。
  基线把已知问题冻结下来，只有新增问题才失败，门禁才活得下去。

示例
  # 最小用法：给自己的博客出一张图
  mdkg --posts src/content/posts --out graph.json

  # 进 CI：断链与失效锚点会让构建失败
  mdkg --posts content --check

  # 接入既有项目：先把历史问题冻结，之后只挡新增
  mdkg --posts content --update-baseline .mdkg-baseline.json
  mdkg --posts content --check --baseline .mdkg-baseline.json

  # 让 agent 消费：结构化 JSON，不用正则解析
  mdkg --posts content --check --format json

  # 在 GitHub Actions 里输出注解（会挂在 PR 的文件上）
  mdkg --posts content --check --format github

  # 生成「相关阅读」数据
  mdkg --posts content --format related --out related.json --related-top 5
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

/** 读取自身版本号，用于写进基线的生成信息 */
async function readOwnVersion() {
	try {
		const text = await fs.readFile(new URL("../package.json", import.meta.url), "utf8");
		return JSON.parse(text).version;
	} catch {
		return undefined;
	}
}

/**
 * 读取基线文件。不存在时返回 null 并给出提示，而不是直接失败——
 * 第一次接入的人不该因为"还没有基线"就跑不起来。
 * @param {string} file
 * @returns {Promise<object|null>}
 */
async function loadBaseline(file) {
	const abs = path.resolve(file);
	let text;
	try {
		text = await fs.readFile(abs, "utf8");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
			process.stderr.write(`提示：基线文件 ${abs} 不存在，本次按"没有已知问题"处理。\n`);
			return null;
		}
		throw err;
	}
	return parseBaseline(text, abs);
}

async function main() {
	const { values } = parseArgs({
		options: {
			posts: { type: "string", short: "p", default: "examples" },
			out: { type: "string", short: "o" },
			// 刻意不给默认值：出图默认 json，检查默认 text，需按模式区分
			format: { type: "string", short: "f" },
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
			baseline: { type: "string" },
			"update-baseline": { type: "string" },
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
	if (values.baseline && values["update-baseline"]) {
		throw new Error("--baseline 与 --update-baseline 不能同时使用（前者读、后者写）。");
	}
	if (values.baseline && !values.check) {
		throw new Error("--baseline 需要与 --check 一起使用（它只影响检查的判定）。");
	}

	const checkMode = values.check || Boolean(values["update-baseline"]);
	const format = String(values.format ?? (checkMode ? "text" : "json")).toLowerCase();

	if (checkMode) {
		if (!CHECK_FORMATS.has(format)) {
			throw new Error(
				`检查模式不支持 --format ${values.format}（可选 ${[...CHECK_FORMATS].join(" / ")}）。`,
			);
		}
	} else if (!GRAPH_FORMATS.has(format)) {
		throw new Error(
			`不支持的 --format：${values.format}（可选 ${[...GRAPH_FORMATS].join(" / ")}）`,
		);
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

	// ---- 生成基线（维护动作，总是成功退出） ----
	if (values["update-baseline"]) {
		const raw = runChecks({ posts, skipped, graph, minTagCount });
		const version = await readOwnVersion();
		const baseline = buildBaseline(raw, { version });
		const outPath = path.resolve(String(values["update-baseline"]));
		await fs.writeFile(outPath, serializeBaseline(baseline), "utf8");

		process.stdout.write(
			`已写入基线：${outPath}\n` +
				`  记录 ${baseline.count} 项（错误 ${raw.errors} · 警告 ${raw.warnings}）\n` +
				`  之后用 --check --baseline ${values["update-baseline"]} 只对新增问题失败。\n`,
		);
		return;
	}

	// ---- 检查模式 ----
	if (values.check) {
		const raw = runChecks({ posts, skipped, graph, minTagCount });
		const baselineFile = values.baseline ? String(values.baseline) : null;
		const baseline = baselineFile ? await loadBaseline(baselineFile) : null;
		const effective = applyBaseline(raw, baseline);

		if (format === "json") {
			process.stdout.write(
				`${JSON.stringify(
					toJsonReport(effective, {
						baseline: baselineFile ? { path: path.resolve(baselineFile) } : undefined,
					}),
					null,
					values.compact ? 0 : 2,
				)}\n`,
			);
		} else if (format === "github") {
			// GitHub 注解：会挂在 PR 的 Files changed 上对应文件处
			process.stdout.write(formatGithubAnnotations(effective));
		} else {
			process.stdout.write(
				formatReport(effective, {
					label: path.basename(postsDir),
					baselineLabel: baselineFile ? path.basename(baselineFile) : "",
				}),
			);
		}

		const failed = effective.errors > 0 || (values.strict && effective.warnings > 0);
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
