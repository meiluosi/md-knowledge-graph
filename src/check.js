/**
 * 知识库检查器（lint）。
 *
 * 这是本工具「有理由被反复运行」的一半：可视化看一次就够了，
 * 但检查可以进 CI。退出码非 0 时，构建就会失败。
 *
 * 严重级别：
 *   error —— 一定是错的（断链、frontmatter 解析失败）
 *   warn  —— 可能是有意的，但通常值得看一眼（无标签、长尾标签、孤儿文章）
 *
 * @module check
 */

import { aggregateBySlug } from "./graph.js";

/**
 * 对语料跑全部检查。
 *
 * @param {object} input
 * @param {Array<{id: string, title: string, tags: string[], category: string}>} input.posts
 * @param {Array<{file: string, reason: string}>} input.skipped
 * @param {ReturnType<import("./graph.js").buildGraph>} input.graph
 * @param {number} [input.minTagCount=2]
 * @returns {{groups: Array<{code: string, severity: "error"|"warn", title: string, items: string[], hint?: string}>, errors: number, warnings: number}}
 */
export function runChecks({ posts, skipped, graph, minTagCount = 2 }) {
	/** @type {Array<{code: string, severity: "error"|"warn", title: string, items: string[], hint?: string}>} */
	const groups = [];

	const add = (code, severity, title, items, hint) => {
		if (items.length === 0) return;
		groups.push({ code, severity, title, items, hint });
	};

	// ---- 错误级 ----

	add(
		"broken-link",
		"error",
		"正文断链（目标文件不存在）",
		graph.links.broken.map((b) => `${b.from}  →  ${b.target}  (${b.kind})`),
		"链接指向的文章在语料里找不到。检查路径拼写，或该文章是否已被删除。",
	);

	add(
		"broken-anchor",
		"error",
		"失效锚点（文件存在，但章节不存在）",
		graph.links.brokenAnchors.map(
			(b) => `${b.from}  →  ${b.sameFile ? "（本文）" : b.to}  #${b.anchor}`,
		),
		"章节标题被改名或删除了。这是文档型语料最常见的失效——文件还在，链接已经死了。",
	);

	add(
		"parse-error",
		"error",
		"frontmatter 解析失败",
		skipped.filter((s) => s.reason.startsWith("frontmatter")).map((s) => `${s.file}  (${s.reason})`),
	);

	// ---- 警告级 ----

	add(
		"missing-title",
		"warn",
		"缺少 title 的文章被跳过",
		skipped.filter((s) => s.reason === "没有 title 字段").map((s) => s.file),
		"没有 title 的文件无法在图里标识，已跳过。",
	);

	add(
		"untagged",
		"warn",
		"无标签的文章",
		posts.filter((p) => p.tags.length === 0).map((p) => p.id),
		"这类文章只能靠分类或正文链接连入图；两者都没有时不会出现在图里。",
	);

	// 标签统计：必须与 buildGraph 用同一套 slug 归并口径，
	// 否则会出现「图里已经合并了，检查器还按两种拼写各报一次」的不一致。
	const tagGroups = aggregateBySlug(posts, "tags");

	add(
		"singleton-tag",
		"warn",
		`只出现一次的标签（低于 --min-tag-count ${minTagCount}，不入图）`,
		[...tagGroups.values()]
			.filter((g) => g.count < minTagCount)
			.map((g) => `${g.label}  (${g.count} 次)`),
		"长尾标签会让图变噪声，默认过滤。若确实重要，可调低 --min-tag-count。",
	);

	add(
		"tag-case",
		"warn",
		"写法不一致的标签（已按 slug 合并为同一个节点）",
		[...tagGroups.entries()]
			.filter(([, g]) => g.variants.size > 1)
			.map(([slug, g]) => `${[...g.variants.keys()].join("  /  ")}  →  合并为「${slug}」，共 ${g.count} 篇`),
		"确认这是有意的；否则统一写法，避免以后检索时漏掉。",
	);

	// 孤儿：在图中但没有任何边
	const degree = new Map();
	for (const e of graph.edges) {
		degree.set(e.source, (degree.get(e.source) || 0) + 1);
		degree.set(e.target, (degree.get(e.target) || 0) + 1);
	}
	add(
		"orphan",
		"warn",
		"图中的孤立节点（没有任何边）",
		graph.nodes.filter((n) => !degree.has(n.id)).map((n) => `${n.type}:${n.label}`),
	);

	add(
		"self-link",
		"warn",
		"文章引用了自己",
		graph.links.selfLinks.map((s) => `${s.from}  →  ${s.target}`),
	);

	const errors = groups.filter((g) => g.severity === "error").reduce((n, g) => n + g.items.length, 0);
	const warnings = groups.filter((g) => g.severity === "warn").reduce((n, g) => n + g.items.length, 0);

	return { groups, errors, warnings };
}

/**
 * 把检查结果渲染成人可读的报告。
 *
 * @param {ReturnType<typeof runChecks>} result
 * @param {object} [options]
 * @param {string} [options.label] 语料目录名
 * @param {number} [options.maxPerGroup=8] 每组最多列几条明细
 * @returns {string}
 */
export function formatReport(result, options = {}) {
	const { label = "", maxPerGroup = 8 } = options;
	const lines = [];
	const head = label ? `检查报告 · ${label}` : "检查报告";
	const rule = "─".repeat(Math.max(24, head.length + 8));
	lines.push(head);
	lines.push(rule);

	if (result.groups.length === 0) {
		lines.push("✓ 没有发现问题");
		lines.push(rule);
		return `${lines.join("\n")}\n`;
	}

	for (const group of result.groups) {
		const mark = group.severity === "error" ? "✗" : "⚠";
		lines.push(`${mark} ${group.title} —— ${group.items.length} 项`);
		for (const item of group.items.slice(0, maxPerGroup)) {
			lines.push(`    ${item}`);
		}
		if (group.items.length > maxPerGroup) {
			lines.push(`    … 另有 ${group.items.length - maxPerGroup} 项`);
		}
		if (group.hint) lines.push(`    ↳ ${group.hint}`);
		lines.push("");
	}

	lines.push(rule);
	const verdict =
		result.errors > 0
			? "  → 存在错误，退出码 1"
			: result.warnings > 0
				? "  → 仅警告，退出码 0（加 --strict 可让警告也失败）"
				: "";
	lines.push(`错误 ${result.errors} · 警告 ${result.warnings}${verdict}`);

	return `${lines.join("\n")}\n`;
}
