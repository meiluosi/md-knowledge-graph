/**
 * 正文链接的提取与解析 —— post ↔ post 边的来源。
 *
 * 这是本工具从「标签浏览器」变成「知识图谱」的关键：没有这一层，
 * 图里只有 post→tag，文章之间永远互不相连。
 *
 * 处理三种写法：
 *   1. 相对 markdown 链接   [文字](../posts/2024-06-09-foo.md)
 *   2. 站点绝对路径         [文字](/posts/2024-06-09-foo/)
 *   3. wikilink             [[2024-06-09-foo]] / [[foo|显示文字]]
 *
 * @module links
 */

import path from "node:path";

/**
 * 去掉代码块与行内代码。
 *
 * 必须有这一步：技术文章里代码块经常含 `[text](url)` 这样的**示例**，
 * 如果直接全文匹配，会把示例当成真链接，从而产生大量假断链。
 * 这是实测踩到的坑，见 README 的 What didn't work。
 *
 * @param {string} content
 * @returns {string}
 */
export function stripCode(content) {
	return content
		.replace(/^```[\s\S]*?^```/gm, "")
		.replace(/^~~~[\s\S]*?^~~~/gm, "")
		.replace(/`[^`\n]*`/g, "")
		.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * 从正文中提取所有链接。
 *
 * @param {string} content 正文（不含 frontmatter）
 * @returns {Array<{kind: "markdown"|"wikilink", target: string, text: string, offset: number}>}
 */
export function extractLinks(content) {
	if (!content) return [];
	const source = stripCode(content);
	/** @type {Array<{kind: "markdown"|"wikilink", target: string, text: string, offset: number}>} */
	const found = [];

	// wikilink：[[target]] 或 [[target|显示文字]]
	for (const m of source.matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
		found.push({
			kind: "wikilink",
			target: m[1].trim(),
			text: (m[2] ?? "").trim(),
			offset: m.index ?? 0,
		});
	}

	// markdown 链接：跳过图片（前面是 !），跳过已处理的 wikilink
	for (const m of source.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
		if (m[1] === "!") continue; // 图片，不是引用
		found.push({
			kind: "markdown",
			target: m[3].trim(),
			text: m[2].trim(),
			offset: m.index ?? 0,
		});
	}

	return found;
}

/**
 * 判断链接目标是否为外部链接（不参与图谱）。
 * @param {string} target
 * @returns {boolean}
 */
export function isExternal(target) {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

/** 安全地做百分号解码（中文路径很常见） */
function safeDecode(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * 为语料建立查找索引：多种写法 → 唯一的文章 id。
 *
 * 支持按「完整相对路径」「文件名」「去掉日期前缀的文件名」以及
 * 站点绝对路径 `/posts/<id>/` 四种方式命中，覆盖不同静态站点的习惯。
 *
 * @param {Array<{id: string, title: string}>} posts
 * @returns {{exact: Map<string,string>, basename: Map<string,string|null>, slug: Map<string,string|null>}}
 */
export function buildLinkIndex(posts) {
	const exact = new Map();
	/** @type {Map<string, string|null>} */
	const basename = new Map();
	/** @type {Map<string, string|null>} */
	const slug = new Map();

	const addAmbiguous = (map, key, id) => {
		if (!key) return;
		map.set(key, map.has(key) && map.get(key) !== id ? null : id);
	};

	for (const post of posts) {
		exact.set(post.id, post.id);
		const base = path.posix.basename(post.id);
		addAmbiguous(basename, base, post.id);
		// 去掉 YYYY-MM-DD- 前缀，方便 [[中文标题]] 这类写法
		addAmbiguous(slug, base.replace(/^\d{4}-\d{1,2}-\d{1,2}-/, ""), post.id);
	}

	return { exact, basename, slug };
}

/**
 * 把单个链接目标解析成文章 id，解析不出返回 null（即断链）。
 *
 * @param {string} rawTarget 原始链接目标
 * @param {{id: string}} from 来源文章
 * @param {ReturnType<typeof buildLinkIndex>} index
 * @returns {string|null}
 */
export function resolveTarget(rawTarget, from, index) {
	if (!rawTarget) return null;

	let target = safeDecode(rawTarget.split("#")[0].split("?")[0]).trim();
	if (!target) return null;
	if (isExternal(target)) return null;

	target = target.replace(/\\/g, "/");

	// 站点绝对路径：/posts/<id>/ 或 /notes/<id>
	if (target.startsWith("/")) {
		const trimmed = target.replace(/^\/+/, "").replace(/\/+$/, "");
		const withoutSection = trimmed.replace(/^[a-z-]+\//i, "");
		for (const candidate of [trimmed, withoutSection]) {
			if (index.exact.has(candidate)) return index.exact.get(candidate);
		}
		const base = path.posix.basename(trimmed);
		if (index.exact.has(base)) return index.exact.get(base);
		if (index.basename.get(base)) return index.basename.get(base);
		return null;
	}

	// 相对路径：解析后去掉扩展名，得到候选 id
	const rel = path.posix.normalize(
		path.posix.join(path.posix.dirname(from.id), target).replace(/^\/+/, ""),
	);
	const candidates = [rel, rel.replace(/\.mdx?$/i, "")];
	for (const c of candidates) {
		if (index.exact.has(c)) return index.exact.get(c);
	}

	// 不含路径分隔符的目标（如 wikilink 的 [[foo]]）：按文件名 / 去日期前缀的文件名查找。
	// 注意只对「无斜杠」的目标启用这层回退，否则 ./gone.md 会因为
	// 别处恰好有个 gone 而误判成有效链接，掩盖真正的断链。
	if (!target.includes("/")) {
		const key = path.posix.basename(target.replace(/\.mdx?$/i, ""));
		if (index.exact.has(key)) return index.exact.get(key);
		const byBase = index.basename.get(key);
		if (byBase) return byBase;
		const bySlug = index.slug.get(key);
		if (bySlug) return bySlug;
	}

	return null;
}

/**
 * 解析全部文章的链接，分成「已连上的边」与「断链」。
 *
 * @param {Array<{id: string, title: string, content?: string}>} posts
 * @returns {{
 *   edges: Array<{from: string, to: string}>,
 *   broken: Array<{from: string, target: string, kind: string}>,
 *   selfLinks: Array<{from: string, target: string}>,
 *   total: number,
 * }}
 */
export function resolvePostLinks(posts) {
	const index = buildLinkIndex(posts);
	const edges = [];
	const broken = [];
	const selfLinks = [];
	const seen = new Set();
	let total = 0;

	for (const post of posts) {
		for (const link of extractLinks(post.content ?? "")) {
			if (isExternal(link.target)) continue;
			total += 1;

			// 纯锚点链接（#section）指向本文，不算引用
			if (link.target.startsWith("#")) continue;

			const to = resolveTarget(link.target, post, index);
			if (!to) {
				broken.push({ from: post.id, target: link.target, kind: link.kind });
				continue;
			}
			if (to === post.id) {
				selfLinks.push({ from: post.id, target: link.target });
				continue;
			}
			const key = `${post.id}\u0000${to}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ from: post.id, to });
		}
	}

	return { edges, broken, selfLinks, total };
}
