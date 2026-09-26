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

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
	applyBaseline,
	buildBaseline,
	collectKeys,
	parseBaseline,
	pruneBaseline,
	serializeBaseline,
} from "./baseline.js";
import { formatGithubAnnotations, formatReport, runChecks, RULES, toJsonReport } from "./check.js";
import {
	CONFIG_FILENAME,
	describeRuleOverrides,
	findConfigFile,
	loadConfig,
	RULE_SEVERITIES,
} from "./config.js";
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
      --asset-root <dir>    站点静态资源根目录，用于检查 /img/... 这类图片路径
                            （不给则只检查相对路径的图片，避免误报）
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
                            把当前全部问题写成基线（**会接受新问题**，维护动作）
      --prune-baseline <file>
                            只删除基线里已不再出现的条目，**绝不添加**
                            （修好一批就清理一批，安全性不依赖"记得何时运行"）

配置
  -c, --config <file>       指定配置文件（默认自动发现 ./${CONFIG_FILENAME}）
      --list-rules          列出全部检查项与当前生效的级别，然后退出

  配置文件里可以设置任何选项，并逐条覆盖规则级别：
    {
      "posts": "content",
      "minTagCount": 2,
      "assetRoot": "public",
      "rules": { "untagged": "off", "singleton-tag": "warn" }
    }
  规则级别可取：${RULE_SEVERITIES.join(" | ")}
  优先级：命令行 > 配置文件 > 默认值

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

  # 修好一批之后清理基线（不会顺手接受新问题）
  mdkg --posts content --prune-baseline .mdkg-baseline.json

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
			posts: { type: "string", short: "p" },
			out: { type: "string", short: "o" },
			// 刻意不给默认值：出图默认 json，检查默认 text，需按模式区分
			format: { type: "string", short: "f" },
			"min-tag-count": { type: "string" },
			"max-nodes": { type: "string" },
			"no-link-edges": { type: "boolean", default: false },
			"no-anchor-check": { type: "boolean", default: false },
			"asset-root": { type: "string" },
			"post-url": { type: "string" },
			"tag-url": { type: "string" },
			"category-url": { type: "string" },
			"related-top": { type: "string" },
			"related-min-score": { type: "string" },
			check: { type: "boolean", default: false },
			strict: { type: "boolean", default: false },
			baseline: { type: "string" },
			"update-baseline": { type: "string" },
			"prune-baseline": { type: "string" },
			config: { type: "string", short: "c" },
			"list-rules": { type: "boolean", default: false },
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
	if (values["update-baseline"] && values["prune-baseline"]) {
		throw new Error(
			"--update-baseline 与 --prune-baseline 不能同时使用：\n" +
				"  前者会**接受**当前全部问题，后者只删除已修好的、绝不添加。",
		);
	}
	if (values.baseline && (values["update-baseline"] || values["prune-baseline"])) {
		throw new Error("--baseline 是只读的，不能与写入基线的选项同时使用。");
	}
	if (values.baseline && !values.check) {
		throw new Error("--baseline 需要与 --check 一起使用（它只影响检查的判定）。");
	}

	const writeBaselineMode = values["update-baseline"] ? "update" : values["prune-baseline"] ? "prune" : null;
	const checkMode = values.check || writeBaselineMode !== null;
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

	const cwd = process.cwd();

	// ---- 配置文件：CLI > 配置文件 > 默认值 ----
	//
	// 顺序说明：先看有没有 --config；没有就在 cwd 与「命令行给的语料目录」里找。
	// 不向上递归——一个藏在祖先目录的配置会让"为什么行为不同"极难排查。
	const cliPostsDir = values.posts ? path.resolve(cwd, String(values.posts)) : null;
	const explicitConfig = values.config ? path.resolve(cwd, String(values.config)) : null;

	if (explicitConfig && !existsSync(explicitConfig)) {
		throw new Error(`指定的配置文件不存在：${explicitConfig}`);
	}
	const configPath = explicitConfig ?? findConfigFile({ cwd, postsDir: cliPostsDir });
	const config = configPath ? loadConfig(configPath) : null;

	if (config) {
		const overrides = describeRuleOverrides(config);
		process.stderr.write(
			`读取配置：${configPath}${overrides ? `（规则覆盖：${overrides}）` : ""}\n`,
		);
	}

	/** 取值优先级：命令行显式给了就用命令行，否则配置，否则默认 */
	const pick = (cliValue, key, fallback) =>
		cliValue !== undefined ? cliValue : config?.[key] !== undefined ? config[key] : fallback;

	// ---- --list-rules：先于读取语料，方便排查"为什么这条不报" ----
	if (values["list-rules"]) {
		const configured = config?.rules ?? {};
		const rows = RULES.map((r) => {
			const effective = configured[r.code] ?? r.severity;
			const mark = effective === "off" ? "·" : "●";
			const tag = r.opinion ? "   ← 意见，非事实" : "";
			return `  ${mark} ${r.code.padEnd(18)} ${effective.padEnd(6)} ${r.title}${tag}`;
		});
		process.stdout.write(
			`检查项（用 ${CONFIG_FILENAME} 的 rules 逐条覆盖）\n` +
				`${"─".repeat(76)}\n` +
				`${rows.join("\n")}\n\n` +
				`  ● 生效   · 已关闭\n` +
				`  级别可选：${RULE_SEVERITIES.join(" | ")}\n\n` +
				`  标「意见，非事实」的：答案取决于你的项目意图，不由工具决定——\n` +
				`  不认同就用 \"rules\": { \"singleton-tag\": \"off\" } 关掉。\n` +
				`  只要事实的配置见 docs/retrospective.md。\n`,
		);
		return;
	}

	const postsDir = path.resolve(cwd, String(pick(values.posts, "posts", "examples")));
	const minTagCount = toNonNegativeInt(pick(values["min-tag-count"], "minTagCount"), 2, "min-tag-count");
	const maxNodes = toNonNegativeInt(pick(values["max-nodes"], "maxNodes"), 200, "max-nodes");
	const relatedTop = toNonNegativeInt(pick(values["related-top"], "relatedTop"), 5, "related-top");
	const relatedMinScore = toNonNegativeInt(
		pick(values["related-min-score"], "relatedMinScore"),
		1,
		"related-min-score",
	);

	// `--no-xxx` 是对配置项的反向覆盖：给了就一定是关
	const linkEdges = values["no-link-edges"] ? false : pick(undefined, "linkEdges", true);
	const anchorCheck = values["no-anchor-check"] ? false : pick(undefined, "anchorCheck", true);
	const assetRootSetting = pick(values["asset-root"], "assetRoot", undefined);

	process.stderr.write(`读取语料：${postsDir}\n`);
	const { posts, skipped } = await readCorpus(postsDir);

	if (posts.length === 0) {
		throw new Error(
			`在 ${postsDir} 里没有找到 markdown 文件。\n` +
				`请确认目录正确。文件没有 frontmatter 也可以——标题会用第一个一级标题或文件名兜底。`,
		);
	}

	const graph = buildGraph(posts, {
		minTagCount,
		maxNodes,
		linkEdges,
		anchorCheck,
		assetRoot: assetRootSetting ? path.resolve(cwd, String(assetRootSetting)) : null,
		postUrl: pick(values["post-url"], "postUrl"),
		tagUrl: pick(values["tag-url"], "tagUrl"),
		categoryUrl: pick(values["category-url"], "categoryUrl"),
	});

	const rules = config?.rules;

	// ---- 写入基线（维护动作，总是成功退出） ----
	if (writeBaselineMode === "update") {
		const raw = runChecks({ posts, skipped, graph, minTagCount, rules });
		const version = await readOwnVersion();
		const baseline = buildBaseline(raw, { version });
		const outPath = path.resolve(String(values["update-baseline"]));
		await fs.writeFile(outPath, serializeBaseline(baseline), "utf8");

		process.stdout.write(
			`已写入基线：${outPath}\n` +
				`  记录 ${baseline.count} 项（错误 ${raw.errors} · 警告 ${raw.warnings}）——**当前全部问题都被接受为已知**\n` +
				`  之后用 --check --baseline ${values["update-baseline"]} 只对新增问题失败。\n`,
		);
		return;
	}

	if (writeBaselineMode === "prune") {
		const file = String(values["prune-baseline"]);
		const outPath = path.resolve(file);
		const existing = await loadBaseline(outPath);
		if (!existing) {
			throw new Error(
				`基线文件不存在：${outPath}\n` + `--prune-baseline 只做删除；创建基线请用 --update-baseline。`,
			);
		}

		const raw = runChecks({ posts, skipped, graph, minTagCount, rules });
		const version = await readOwnVersion();
		const { baseline, removed, changed } = pruneBaseline(existing, collectKeys(raw), { version });

		if (!changed) {
			process.stdout.write(`基线无变化：${baseline.count} 项仍全部存在。\n`);
			return;
		}

		await fs.writeFile(outPath, serializeBaseline(baseline), "utf8");
		process.stdout.write(
			`已清理基线：${outPath}\n` +
				`  移除 ${removed.length} 项已不再出现的问题，保留 ${baseline.count} 项\n` +
				`  未添加任何新问题。\n`,
		);
		for (const item of removed.slice(0, 10)) {
			process.stdout.write(`    - ${item.key}\n`);
		}
		if (removed.length > 10) {
			process.stdout.write(`    … 另有 ${removed.length - 10} 项\n`);
		}
		return;
	}

	// ---- 检查模式 ----
	if (values.check) {
		const raw = runChecks({ posts, skipped, graph, minTagCount, rules });
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
	if (meta.brokenLinks > 0 || meta.brokenAnchors > 0 || meta.localPaths > 0 || meta.brokenImages > 0) {
		const parts = [];
		if (meta.brokenLinks > 0) parts.push(`${meta.brokenLinks} 条断链`);
		if (meta.brokenAnchors > 0) parts.push(`${meta.brokenAnchors} 个失效锚点`);
		if (meta.localPaths > 0) parts.push(`${meta.localPaths} 个本地路径`);
		if (meta.brokenImages > 0) parts.push(`${meta.brokenImages} 张缺失图片`);
		process.stderr.write(
			`提示：发现 ${parts.join("、")}。运行 mdkg --posts ${values.posts} --check 查看明细。\n`,
		);
	}
}

main().catch((err) => {
	process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
});
