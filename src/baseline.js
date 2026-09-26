/**
 * 基线机制。
 *
 * 解决的问题：**门禁一开就红，于是被关掉。**
 *
 * 一个已经存在两年、攒了 40 条历史断链的知识库，第一次跑 `--check` 就会
 * 拿到 40 个错误、退出码 1。人不会去修那 40 条——他会在 CI 里把那一步删掉，
 * 或者永远忽略那个红色的叉。**这样门禁就死了。**
 *
 * 基线把「已知问题」冻结下来：只有**新增**问题会让构建失败。历史债仍然
 * 记录在案、可以随时查看、可以逐步偿还，但它不再阻止你使用这个工具。
 *
 * 基线的核心是每条的 `key`（见 check.js）。key 必须只依赖问题本身：
 * 不含行号、顺序、措辞、计数。否则改一次文案就会让整份基线失效。
 *
 * @module baseline
 */

/** 基线文件的 schema 版本 */
export const BASELINE_SCHEMA_VERSION = 1;

/** 建议的文件名 */
export const DEFAULT_BASELINE_NAME = ".mdkg-baseline.json";

/**
 * 收集一次检查结果里全部问题的 key。
 * @param {ReturnType<import("./check.js").runChecks>} result
 * @returns {Set<string>}
 */
export function collectKeys(result) {
	const keys = new Set();
	for (const group of result.groups) {
		for (const item of group.items) keys.add(item.key);
	}
	return keys;
}

/**
 * 从检查结果生成一份基线。
 *
 * 条目按 key 排序，保证「内容没变 → 文件也没变」，不会产生无意义的 diff。
 *
 * @param {ReturnType<import("./check.js").runChecks>} result
 * @param {object} [options]
 * @param {string} [options.version] 生成时的工具版本，便于日后追溯
 * @param {string} [options.generatedAt] ISO 时间戳；省略则用当前时间
 * @returns {object}
 */
export function buildBaseline(result, options = {}) {
	const issues = [];
	for (const group of result.groups) {
		for (const item of group.items) {
			issues.push({
				key: item.key,
				code: group.code,
				severity: group.severity,
				message: item.message,
			});
		}
	}

	issues.sort((a, b) => a.key.localeCompare(b.key));

	return {
		schemaVersion: BASELINE_SCHEMA_VERSION,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		generatedBy: options.version ? `md-knowledge-graph@${options.version}` : undefined,
		count: issues.length,
		issues,
	};
}

/**
 * 只删除「已不再出现」的条目，**绝不添加新的**。
 *
 * 与 updateBaseline 的区别很重要，两者危险程度完全不同：
 *
 * | | 会添加新问题吗 | 语义 |
 * |---|---|---|
 * | `--update-baseline` | **会** | 「把所有现存问题都接受为已知」 |
 * | `--prune-baseline`  | **不会** | 「忘掉已经修好的，但绝不放过新的」 |
 *
 * 前者方便（一次接住全部历史债），但跑在不该跑的时候会**静默接受新引入的问题**。
 * 后者是日常维护动作：修好一批就清理一批，安全性不依赖于"你记得它只在什么时候跑"。
 *
 * @param {object} baseline 现有基线
 * @param {Set<string>} currentKeys 当前仍然存在的问题 key
 * @param {object} [options]
 * @param {string} [options.version]
 * @param {string} [options.generatedAt]
 * @returns {{baseline: object, removed: Array<{key: string}>, changed: boolean}}
 */
export function pruneBaseline(baseline, currentKeys, options = {}) {
	const kept = baseline.issues.filter((i) => currentKeys.has(i.key));
	const removed = baseline.issues.filter((i) => !currentKeys.has(i.key));

	if (removed.length === 0) {
		// 没有变化就不要重写文件，免得每次跑都产生无意义的 diff
		return { baseline, removed, changed: false };
	}

	return {
		baseline: {
			...baseline,
			generatedAt: options.generatedAt ?? new Date().toISOString(),
			generatedBy: options.version ? `md-knowledge-graph@${options.version}` : baseline.generatedBy,
			count: kept.length,
			issues: kept,
		},
		removed,
		changed: true,
	};
}

/**
 * 序列化成稳定的文件内容。
 * @param {object} baseline
 * @returns {string}
 */
export function serializeBaseline(baseline) {
	return `${JSON.stringify(baseline, null, 2)}\n`;
}

/**
 * 解析基线文件内容。格式不对时抛出可读错误——
 * 静默当成空基线会让"门禁失效"这件事本身变成静默错误。
 *
 * @param {string} text
 * @param {string} [source] 文件名，用于错误信息
 * @returns {{issues: Array<{key: string}>}}
 */
export function parseBaseline(text, source = DEFAULT_BASELINE_NAME) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new Error(`基线文件不是合法 JSON：${source}\n${/** @type {Error} */ (err).message}`);
	}

	if (data == null || typeof data !== "object") {
		throw new Error(`基线文件格式不对：${source}（顶层应为对象）`);
	}
	if (data.schemaVersion !== BASELINE_SCHEMA_VERSION) {
		throw new Error(
			`基线文件 schemaVersion 不匹配：${source} 是 ${data.schemaVersion}，本工具期望 ${BASELINE_SCHEMA_VERSION}。\n` +
				`如果只是工具升级导致，用 --update-baseline 重新生成一份。`,
		);
	}
	if (!Array.isArray(data.issues)) {
		throw new Error(`基线文件缺少 issues 数组：${source}`);
	}
	for (const issue of data.issues) {
		if (issue == null || typeof issue.key !== "string" || issue.key === "") {
			throw new Error(`基线文件里有条目缺少 key：${source}`);
		}
	}

	return data;
}

/**
 * 把基线应用到检查结果上：只保留**新增**问题。
 *
 * @param {ReturnType<import("./check.js").runChecks>} result
 * @param {{issues: Array<{key: string}>}|null} baseline
 * @returns {ReturnType<import("./check.js").runChecks> & {knownTotal: number, stale: Array<{key: string}>}}
 */
export function applyBaseline(result, baseline) {
	if (!baseline) {
		return { ...result, knownTotal: 0, stale: [] };
	}

	const knownKeys = new Set(baseline.issues.map((i) => i.key));

	const groups = result.groups
		.map((group) => {
			const fresh = group.items.filter((item) => !knownKeys.has(item.key));
			return { ...group, items: fresh, knownCount: group.items.length - fresh.length };
		})
		.filter((group) => group.items.length > 0);

	// 当前仍然存在的问题
	const currentKeys = new Set();
	for (const group of result.groups) {
		for (const item of group.items) currentKeys.add(item.key);
	}

	// 基线里记着、但现在已经不存在的 —— 说明修好了，可以清理
	const stale = baseline.issues.filter((i) => !currentKeys.has(i.key)).map((i) => ({ key: i.key }));

	const sum = (sev) =>
		groups.filter((g) => g.severity === sev).reduce((n, g) => n + g.items.length, 0);

	return {
		groups,
		errors: sum("error"),
		warnings: sum("warn"),
		knownTotal: result.errors + result.warnings - sum("error") - sum("warn"),
		stale,
	};
}
