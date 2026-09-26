/**
 * 知识库检查器（lint）。
 *
 * 这是本工具「有理由被反复运行」的一半：可视化看一次就够了，
 * 但检查可以进 CI。退出码非 0 时，构建就会失败。
 *
 * 严重级别：
 *   error —— 一定是错的（断链、失效锚点、frontmatter 解析失败）
 *   warn  —— 可能是有意的，但通常值得看一眼（无标签、长尾标签、孤儿文章）
 *
 * 每个检查项都是**结构化对象**，带一个稳定的 `key`：
 *
 *   { key: "broken-anchor|a|b|flash-attention", message: "…", … }
 *
 * `key` 是基线机制的基础，必须只依赖「问题本身」而不依赖任何易变的东西：
 * 不含行号、不含出现顺序、不含措辞、不含计数。否则改一次文案或插一行字，
 * 所有基线条目就会集体失效——那基线就白做了。
 *
 * 同时它也得是**人能读的**：`.mdkg-baseline.json` 是要提交进仓库、被人 review 的。
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
 * @returns {{groups: Array<{code: string, severity: "error"|"warn", title: string, hint?: string, items: Array<{key: string, message: string}>}>, errors: number, warnings: number}}
 */
export function runChecks({ posts, skipped, graph, minTagCount = 2 }) {
	/** @type {Array<{code: string, severity: "error"|"warn", title: string, hint?: string, items: Array<Record<string, unknown> & {key: string, message: string}>}>} */
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
		graph.links.broken.map((b) => ({
			key: `broken-link|${b.from}|${b.target}`,
			message: `${b.from}  →  ${b.target}  (${b.kind})`,
			from: b.from,
			target: b.target,
			kind: b.kind,
		})),
		"链接指向的文章在语料里找不到。检查路径拼写，或该文章是否已被删除。",
	);

	add(
		"broken-anchor",
		"error",
		"失效锚点（文件存在，但章节不存在）",
		graph.links.brokenAnchors.map((b) => ({
			key: `broken-anchor|${b.from}|${b.to}|${b.anchor}`,
			message: `${b.from}  →  ${b.sameFile ? "（本文）" : b.to}  #${b.anchor}`,
			from: b.from,
			to: b.to,
			anchor: b.anchor,
			sameFile: b.sameFile,
		})),
		"章节标题被改名或删除了。这是文档型语料最常见的失效——文件还在，链接已经死了。",
	);

	add(
		"parse-error",
		"error",
		"frontmatter 解析失败",
		skipped
			.filter((s) => s.reason.startsWith("frontmatter"))
			.map((s) => ({
				key: `parse-error|${s.file}`,
				message: `${s.file}  (${s.reason})`,
				file: s.file,
				reason: s.reason,
			})),
	);

	// ---- 警告级 ----

	add(
		"missing-title",
		"warn",
		"缺少 title 的文章被跳过",
		skipped
			.filter((s) => s.reason === "没有 title 字段")
			.map((s) => ({
				key: `missing-title|${s.file}`,
				message: s.file,
				file: s.file,
			})),
		"没有 title 的文件无法在图里标识，已跳过。",
	);

	add(
		"untagged",
		"warn",
		"无标签的文章",
		posts
			.filter((p) => p.tags.length === 0)
			.map((p) => ({
				key: `untagged|${p.id}`,
				message: p.id,
				post: p.id,
			})),
		"这类文章只能靠分类或正文链接连入图；两者都没有时不会出现在图里。",
	);

	// 标签统计：必须与 buildGraph 用同一套 slug 归并口径，
	// 否则会出现「图里已经合并了，检查器还按两种拼写各报一次」的不一致。
	const tagGroups = aggregateBySlug(posts, "tags");

	add(
		"singleton-tag",
		"warn",
		`只出现一次的标签（低于 --min-tag-count ${minTagCount}，不入图）`,
		[...tagGroups.entries()]
			.filter(([, g]) => g.count < minTagCount)
			.map(([slug, g]) => ({
				// 用 slug 而非 label：label 的大小写可能被"多数决"改写，key 不能跟着变
				key: `singleton-tag|${slug}`,
				message: `${g.label}  (${g.count} 次)`,
				slug,
				label: g.label,
				count: g.count,
			})),
		"长尾标签会让图变噪声，默认过滤。若确实重要，可调低 --min-tag-count。",
	);

	add(
		"tag-case",
		"warn",
		"写法不一致的标签（已按 slug 合并为同一个节点）",
		[...tagGroups.entries()]
			.filter(([, g]) => g.variants.size > 1)
			.map(([slug, g]) => ({
				key: `tag-case|${slug}`,
				message: `${[...g.variants.keys()].join("  /  ")}  →  合并为「${slug}」，共 ${g.count} 篇`,
				slug,
				variants: [...g.variants.keys()],
				count: g.count,
			})),
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
		graph.nodes
			.filter((n) => !degree.has(n.id))
			.map((n) => ({
				key: `orphan|${n.id}`,
				message: `${n.type}:${n.label}`,
				node: n.id,
				nodeType: n.type,
				label: n.label,
			})),
	);

	add(
		"self-link",
		"warn",
		"文章引用了自己",
		graph.links.selfLinks.map((s) => ({
			key: `self-link|${s.from}|${s.target}`,
			message: `${s.from}  →  ${s.target}`,
			from: s.from,
			target: s.target,
		})),
	);

	const sum = (sev) =>
		groups.filter((g) => g.severity === sev).reduce((n, g) => n + g.items.length, 0);

	return { groups, errors: sum("error"), warnings: sum("warn") };
}

/**
 * 把检查结果渲染成人可读的文本报告。
 *
 * 支持两种附加状态（由 baseline 机制注入）：
 *   group.knownCount —— 该组里被基线忽略的条数
 *   result.knownTotal / result.stale —— 汇总与「已不再出现」的旧问题
 *
 * @param {ReturnType<typeof runChecks>} result
 * @param {object} [options]
 * @param {string} [options.label] 语料目录名
 * @param {string} [options.baselineLabel] 基线文件名，用于报告头
 * @param {number} [options.maxPerGroup=8]
 * @returns {string}
 */
export function formatReport(result, options = {}) {
	const { label = "", baselineLabel = "", maxPerGroup = 8 } = options;
	const lines = [];
	const head = label ? `检查报告 · ${label}` : "检查报告";
	const rule = "─".repeat(Math.max(24, head.length + 8));

	lines.push(baselineLabel ? `${head}（基线：${baselineLabel}）` : head);
	lines.push(rule);

	const total = result.groups.reduce((n, g) => n + g.items.length, 0);

	if (total === 0) {
		lines.push(
			result.knownTotal > 0
				? `✓ 没有新增问题（${result.knownTotal} 项已知问题仍在基线里）`
				: "✓ 没有发现问题",
		);
	} else {
		for (const group of result.groups) {
			const mark = group.severity === "error" ? "✗" : "⚠";
			const known = group.knownCount ? `（另有 ${group.knownCount} 项已知，已忽略）` : "";
			lines.push(`${mark} ${group.title} —— ${group.items.length} 项${known}`);
			for (const item of group.items.slice(0, maxPerGroup)) {
				lines.push(`    ${item.message}`);
			}
			if (group.items.length > maxPerGroup) {
				lines.push(`    … 另有 ${group.items.length - maxPerGroup} 项`);
			}
			if (group.hint) lines.push(`    ↳ ${group.hint}`);
			lines.push("");
		}
	}

	if (result.stale?.length) {
		lines.push(`ℹ 基线里有 ${result.stale.length} 项已不再出现，可以清理：`);
		for (const s of result.stale.slice(0, 5)) {
			lines.push(`    ${s.key}`);
		}
		if (result.stale.length > 5) lines.push(`    … 另有 ${result.stale.length - 5} 项`);
		lines.push("");
	}

	lines.push(rule);
	const verdict =
		result.errors > 0
			? "  → 存在错误，退出码 1"
			: result.warnings > 0
				? "  → 仅警告，退出码 0（加 --strict 可让警告也失败）"
				: "";
	const knownNote = result.knownTotal > 0 ? `  ·  已知 ${result.knownTotal} 项已忽略` : "";
	lines.push(`错误 ${result.errors} · 警告 ${result.warnings}${knownNote}${verdict}`);

	return `${lines.join("\n")}\n`;
}

/**
 * 输出结构化 JSON 报告，供 agent / 其它程序消费。
 *
 * 与文本报告同源，只是不再把信息压扁成字符串——每个条目保留
 * `key` 与各自的字段，调用方不需要正则解析。
 *
 * @param {ReturnType<typeof runChecks>} result
 * @param {object} [options]
 * @param {{path?: string, generatedAt?: string}} [options.baseline]
 * @returns {object}
 */
export function toJsonReport(result, options = {}) {
	const baseline = options.baseline
		? { path: options.baseline.path ?? null, knownIgnored: result.knownTotal ?? 0 }
		: null;

	return {
		schemaVersion: 1,
		baseline,
		summary: {
			errors: result.errors,
			warnings: result.warnings,
			knownIgnored: result.knownTotal ?? 0,
			staleBaselineEntries: result.stale?.length ?? 0,
		},
		groups: result.groups.map((g) => ({
			code: g.code,
			severity: g.severity,
			title: g.title,
			count: g.items.length,
			knownIgnored: g.knownCount ?? 0,
			items: g.items,
		})),
		stale: result.stale ?? [],
	};
}
