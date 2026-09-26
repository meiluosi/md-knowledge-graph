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

import fs from "node:fs";
import path from "node:path";
import { buildAnchorIndex, hasAnchor } from "./anchors.js";
import { maskCode, offsetToPosition } from "./text.js";

/**
 * 判断一个引用目标是不是**本地文件系统路径**。
 *
 * 两类：Windows 盘符（`C:\...` / `C:/...`）与 UNC（`\\server\share`）。
 *
 * 为什么必须单独判：`C:` 会被 URL 协议的正则匹配上，于是 `C:\Users\...\a.png`
 * 会被当成"外链"跳过——**而它在网页上必然 404**。
 * 这个 bug 是在真实语料上跑出来的：19 个引用的漏报。
 *
 * @param {string} target
 * @returns {boolean}
 */
export function isLocalFilePath(target) {
	const t = String(target ?? "");
	return /^[a-zA-Z]:[\\/]/.test(t) || t.startsWith("\\\\");
}

/**
 * 判断链接目标是否为外部链接（不参与图谱）。
 *
 * 注意顺序：本地文件路径要先判掉。按 RFC 3986，真正的 URI scheme 至少两个字符，
 * 所以单字母 + 冒号只可能是盘符。
 *
 * @param {string} target
 * @returns {boolean}
 */
export function isExternal(target) {
	const t = String(target ?? "");
	if (isLocalFilePath(t)) return false;
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) || t.startsWith("//");
}

/**
 * 从正文中提取所有链接。
 *
 * `offset` 是**原文**中的字符偏移——因为 maskCode 是等长遮蔽，
 * 遮蔽后匹配到的下标可以直接用于原文，从而还原行列号。
 *
 * @param {string} content 正文（不含 frontmatter）
 * @returns {Array<{kind: "markdown"|"wikilink"|"image", target: string, text: string, offset: number}>}
 */
export function extractLinks(content) {
	if (!content) return [];
	const source = maskCode(content);
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

	// markdown 链接：图片（! 前缀）单独成类，其余算引用
	for (const m of source.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
		found.push({
			kind: m[1] === "!" ? "image" : "markdown",
			target: m[3].trim(),
			text: m[2].trim(),
			offset: m.index ?? 0,
		});
	}

	return found;
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
 * 把链接目标拆成「文件部分」与「锚点部分」。
 *
 * `./design.md#api-contract?x=1` → `{ path: "./design.md", anchor: "api-contract" }`
 * `#section`                     → `{ path: "",          anchor: "section" }`
 *
 * @param {string} rawTarget
 * @returns {{path: string, anchor: string}}
 */
export function splitAnchor(rawTarget) {
	const raw = String(rawTarget ?? "");
	const hashAt = raw.indexOf("#");
	const beforeHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
	const afterHash = hashAt >= 0 ? raw.slice(hashAt + 1) : "";

	return {
		path: safeDecode(beforeHash.split("?")[0]).trim(),
		anchor: safeDecode(afterHash.split("?")[0]).trim(),
	};
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
 * 只关心文件，不校验锚点。需要锚点时用 resolveLink。
 *
 * @param {string} rawTarget 原始链接目标
 * @param {{id: string}} from 来源文章
 * @param {ReturnType<typeof buildLinkIndex>} index
 * @returns {string|null}
 */
export function resolveTarget(rawTarget, from, index) {
	return resolveLink(rawTarget, from, index)?.id ?? null;
}

/**
 * 解析链接目标，同时取出锚点。
 *
 * @param {string} rawTarget
 * @param {{id: string}} from
 * @param {ReturnType<typeof buildLinkIndex>} index
 * @returns {{id: string, anchor: string, sameFile: boolean}|null} 解析不出返回 null
 */
export function resolveLink(rawTarget, from, index) {
	if (!rawTarget) return null;

	const { path: target, anchor } = splitAnchor(rawTarget);

	// 纯锚点（#section）指向本文
	if (!target) return anchor ? { id: from.id, anchor, sameFile: true } : null;

	if (isExternal(target)) return null;

	const normalized = target.replace(/\\/g, "/");

	// 站点绝对路径：/posts/<id>/ 或 /notes/<id>
	if (normalized.startsWith("/")) {
		const trimmed = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
		const withoutSection = trimmed.replace(/^[a-z-]+\//i, "");
		for (const candidate of [trimmed, withoutSection]) {
			if (index.exact.has(candidate)) {
				return { id: index.exact.get(candidate), anchor, sameFile: false };
			}
		}
		const base = path.posix.basename(trimmed);
		if (index.exact.has(base)) return { id: index.exact.get(base), anchor, sameFile: false };
		if (index.basename.get(base)) return { id: index.basename.get(base), anchor, sameFile: false };
		return null;
	}

	// 相对路径：解析后去掉扩展名，得到候选 id
	const rel = path.posix.normalize(
		path.posix.join(path.posix.dirname(from.id), normalized).replace(/^\/+/, ""),
	);
	const candidates = [rel, rel.replace(/\.mdx?$/i, "")];
	for (const c of candidates) {
		if (index.exact.has(c)) return { id: index.exact.get(c), anchor, sameFile: false };
	}

	// 不含路径分隔符的目标（如 wikilink 的 [[foo]]）：按文件名 / 去日期前缀的文件名查找。
	// 注意只对「无斜杠」的目标启用这层回退，否则 ./gone.md 会因为
	// 别处恰好有个 gone 而误判成有效链接，掩盖真正的断链。
	if (!normalized.includes("/")) {
		const key = path.posix.basename(normalized.replace(/\.mdx?$/i, ""));
		if (index.exact.has(key)) return { id: index.exact.get(key), anchor, sameFile: false };
		const byBase = index.basename.get(key);
		if (byBase) return { id: byBase, anchor, sameFile: false };
		const bySlug = index.slug.get(key);
		if (bySlug) return { id: bySlug, anchor, sameFile: false };
	}

	return null;
}

/**
 * 检查一个图片引用是否指向真实存在的文件。
 *
 * 三种结果：
 *   ok        —— 文件在
 *   missing   —— 文件不在（要报出来）
 *   unchecked —— 无法判断（外链、data URI、或站点绝对路径但没给 --asset-root）
 *
 * 「无法判断」必须与「缺失」区分开：把判不了的说成缺失，
 * 就是误报，而误报会让门禁被关掉。
 *
 * @param {string} rawTarget
 * @param {{file?: string}} post
 * @param {string|null} assetRoot 站点静态资源根目录（用于解析 `/img/...` 这类路径）
 * @returns {"ok"|"missing"|"unchecked"}
 */
function checkImageTarget(rawTarget, post, assetRoot) {
	const target = safeDecode(String(rawTarget ?? "").split("#")[0].split("?")[0]).trim();
	if (!target) return "unchecked";
	if (/^data:/i.test(target)) return "unchecked";
	if (isExternal(target)) return "unchecked";

	const normalized = target.replace(/\\/g, "/");

	// 站点绝对路径：/img/x.png → <assetRoot>/img/x.png
	if (normalized.startsWith("/")) {
		if (!assetRoot) return "unchecked";
		return fs.existsSync(path.join(assetRoot, normalized)) ? "ok" : "missing";
	}

	// 相对路径：相对于该 markdown 文件所在目录
	if (!post.file) return "unchecked";
	return fs.existsSync(path.join(path.dirname(post.file), normalized)) ? "ok" : "missing";
}

/**
 * 解析全部文章的链接，分成「已连上的边」「断链」「坏锚点」「本地路径」「坏图片」。
 *
 * 五种问题分开归类，因为**修复动作不同**：
 *   断链     → 文件没了或路径写错
 *   坏锚点   → 文件在，但章节被改名了（文档型语料最常见的失效）
 *   本地路径 → 写成了 C:\... ，在网页上必然 404（要上传资源 / 改路径）
 *   坏图片   → 图片文件不在（相对路径才可判；外链与未给 assetRoot 的站点路径不做判断）
 *   自引用   → 可能是笔误，也可能是有意的
 *
 * @param {Array<{id: string, title: string, content?: string, file?: string, lineOffset?: number}>} posts
 * @param {object} [options]
 * @param {Map<string, Set<string>>} [options.anchorIndex] 复用已有的锚点索引，省一次遍历
 * @param {boolean} [options.anchorCheck=true] 是否校验锚点
 * @param {string|null} [options.assetRoot=null] 站点静态资源根目录
 * @returns {object}
 */
export function resolvePostLinks(posts, options = {}) {
	const { anchorCheck = true, assetRoot = null } = options;
	const index = buildLinkIndex(posts);
	const anchorIndex = options.anchorIndex ?? (anchorCheck ? buildAnchorIndex(posts) : null);

	const edges = [];
	const broken = [];
	const brokenAnchors = [];
	const selfLinks = [];
	const localPaths = [];
	const brokenImages = [];
	const seen = new Set();
	let total = 0;
	let imagesFound = 0;

	for (const post of posts) {
		const content = post.content ?? "";
		// 换算成**文件行号**：正文第 1 行前面还有 frontmatter
		const lineOffset = post.lineOffset ?? 0;
		const at = (offset) => {
			const pos = offsetToPosition(content, offset);
			return { line: pos.line + lineOffset, column: pos.column };
		};

		for (const link of extractLinks(content)) {
			const pos = at(link.offset);

			// 本地文件系统路径：必然 404，单独归类（修复动作与"断链"不同）
			if (isLocalFilePath(link.target)) {
				localPaths.push({
					from: post.id,
					target: link.target,
					kind: link.kind,
					offset: link.offset,
					...pos,
				});
				continue;
			}

			if (isExternal(link.target)) continue;

			// 图片不进图，只检查存在性
			if (link.kind === "image") {
				// imagesFound 的口径：**内部**图片引用数（外链与本地路径不计入），
				// 也就是"本工具尝试去看的图片"
				imagesFound += 1;
				if (checkImageTarget(link.target, post, assetRoot) === "missing") {
					brokenImages.push({
						from: post.id,
						target: link.target,
						offset: link.offset,
						...pos,
					});
				}
				continue;
			}

			total += 1;

			const resolved = resolveLink(link.target, post, index);
			if (!resolved) {
				broken.push({
					from: post.id,
					target: link.target,
					kind: link.kind,
					offset: link.offset,
					...pos,
				});
				continue;
			}

			if (anchorIndex && resolved.anchor && !hasAnchor(anchorIndex, resolved.id, resolved.anchor)) {
				brokenAnchors.push({
					from: post.id,
					to: resolved.id,
					anchor: resolved.anchor,
					target: link.target,
					sameFile: resolved.sameFile,
					offset: link.offset,
					...pos,
				});
			}

			// 同文件锚点（#section）不是图里的边
			if (resolved.sameFile) continue;

			if (resolved.id === post.id) {
				selfLinks.push({
					from: post.id,
					target: link.target,
					offset: link.offset,
					...pos,
				});
				continue;
			}

			const key = `${post.id}\u0000${resolved.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push({ from: post.id, to: resolved.id });
		}
	}

	return { edges, broken, brokenAnchors, selfLinks, localPaths, brokenImages, total, imagesFound };
}
