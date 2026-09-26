/**
 * 知识图谱构建核心。
 *
 * 职责边界：这里只做「读 markdown → 解析 frontmatter 与正文链接 → 构图」，
 * 不做任何输出格式的决定（那是 render.js 的事）。
 *
 * 图有三种边：
 *   post → tag        主题归属
 *   post → category   分类归属
 *   post → post       正文里的相互引用（这是「知识图谱」真正的价值所在）
 *
 * @module graph
 */

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { resolvePostLinks } from "./links.js";

/** 跳过这些目录名，避免把依赖或构建产物当成语料 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".astro"]);

/**
 * 递归收集目录下的所有 markdown 文件。
 *
 * 刻意不引入 glob 依赖：一个自带的递归遍历就能覆盖真实需求，
 * 少一个依赖 = 少一个别人复现时卡住的理由。
 *
 * @param {string} dir 语料根目录
 * @returns {Promise<string[]>} 排序后的绝对路径列表
 */
export async function collectMarkdown(dir) {
	/** @type {string[]} */
	const found = [];

	async function walk(current) {
		/** @type {import("node:fs").Dirent[]} */
		let entries;
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch (err) {
			if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") {
				throw new Error(`语料目录不存在：${current}`);
			}
			throw err;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
				found.push(full);
			}
		}
	}

	await walk(dir);
	return found.sort();
}

/**
 * 把 frontmatter 里的字段规整成字符串数组。
 *
 * 这是本项目存在的直接原因：手写的 frontmatter 解析器会把
 * `tags: [a, b]`（行内数组）和 `tags: a`（标量）静默解析成空数组，
 * 造成无声的数据丢失。这里显式把三种写法都收敛成同一种结果。
 *
 * @param {unknown} value frontmatter 原始值
 * @returns {string[]}
 */
export function normalizeList(value) {
	if (value == null) return [];
	const asArray = Array.isArray(value) ? value : [value];
	return asArray
		.map((v) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim())
		.filter((v) => v.length > 0);
}

/**
 * 读取语料目录，解析出文章元数据与正文，并报告被跳过的文件。
 *
 * @param {string} dir 语料根目录
 * @returns {Promise<{
 *   posts: Array<{id: string, title: string, tags: string[], category: string, file: string, content: string}>,
 *   skipped: Array<{file: string, reason: string}>,
 * }>}
 */
export async function readCorpus(dir) {
	const files = await collectMarkdown(dir);
	/** @type {Array<{id: string, title: string, tags: string[], category: string, file: string, content: string}>} */
	const posts = [];
	/** @type {Array<{file: string, reason: string}>} */
	const skipped = [];

	for (const file of files) {
		const rel = path.relative(dir, file).replace(/\\/g, "/");
		const raw = await fs.readFile(file, "utf8");
		let data;
		let content;
		try {
			({ data, content } = matter(raw));
		} catch (err) {
			skipped.push({ file: rel, reason: `frontmatter 解析失败：${/** @type {Error} */ (err).message}` });
			continue;
		}

		const title = typeof data.title === "string" ? data.title.trim() : "";
		if (!title) {
			skipped.push({ file: rel, reason: "没有 title 字段" });
			continue;
		}

		// 正文行号 → 文件行号的偏移量。
		//
		// gray-matter 会剥掉 frontmatter，于是正文里的第 1 行在文件里并不是第 1 行。
		// 不做这个换算，报出来的行号会整体偏掉 frontmatter 的行数——
		// 而**错的行号比没有行号更糟**：它让人去改一个没问题的位置。
		//
		// 这里用「正文是原文的后缀」这个性质来定位，而不是用正则去匹配
		// frontmatter 分隔符——后者要处理各种边界，且容易与实际剥离行为不一致。
		const lineOffset = lineCountBefore(raw, content ?? "");

		posts.push({
			id: rel.replace(/\.mdx?$/i, ""),
			title,
			tags: normalizeList(data.tags),
			category: typeof data.category === "string" ? data.category.trim() : "",
			file,
			content: content ?? "",
			lineOffset,
		});
	}

	return { posts, skipped };
}

/**
 * 算出 `body` 之前的换行数（即 body 在原文中的行偏移）。
 *
 * 依赖「body 是 raw 的后缀」这一性质；若不是（例如解析器做了别的裁剪），
 * 退回到按 frontmatter 分隔符计数，宁可保守也不要给出错的偏移。
 *
 * @param {string} raw 原始文件内容
 * @param {string} body gray-matter 返回的正文
 * @returns {number}
 */
function lineCountBefore(raw, body) {
	const countNewlines = (s) => (s.match(/\n/g) ?? []).length;

	if (body.length > 0 && raw.endsWith(body)) {
		return countNewlines(raw.slice(0, raw.length - body.length));
	}

	// 后备：按 frontmatter 分隔符计数
	const m = raw.match(/^(---)\r?\n[\s\S]*?\r?\n\1[ \t]*\r?\n/);
	return m ? countNewlines(m[0]) : 0;
}

/**
 * 只取文章列表的便捷封装。
 * @param {string} dir
 * @returns {Promise<Array<{id: string, title: string, tags: string[], category: string, file: string, content: string}>>}
 */
export async function readPosts(dir) {
	return (await readCorpus(dir)).posts;
}

/**
 * 把文本转成可用于节点 id 的 slug，保留中文。
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * 按 slug 归并标签或分类：`PEFT` 与 `peft` 是同一个概念，必须合成一个节点。
 *
 * 不归并的后果不是「少一个节点」，而是**畸形的图**：两个 id 相同、
 * label 不同的节点同时存在，Mermaid 里会渲染成重复定义，前端按 id
 * 建索引时则互相覆盖。这是实测发现的 bug。
 *
 * 计数的口径是「有多少篇文章用了这个概念」，所以同一篇文章里同时写了
 * 两种拼写也只算一次。
 *
 * @param {Array<{tags: string[], category: string}>} posts
 * @param {"tags"|"category"} field
 * @returns {Map<string, {label: string, count: number, variants: Map<string, number>}>}
 */
export function aggregateBySlug(posts, field) {
	/** @type {Map<string, {label: string, count: number, variants: Map<string, number>}>} */
	const map = new Map();

	for (const post of posts) {
		const values = field === "tags" ? post.tags : post.category ? [post.category] : [];
		const seen = new Set();
		for (const value of values) {
			const slug = slugify(value);
			if (!slug) continue;
			if (!map.has(slug)) map.set(slug, { label: value, count: 0, variants: new Map() });
			const group = map.get(slug);
			group.variants.set(value, (group.variants.get(value) || 0) + 1);
			if (!seen.has(slug)) {
				group.count += 1;
				seen.add(slug);
			}
		}
	}

	// 规范写法：出现次数最多的那个；并列时优先选大写更多的（PEFT 这类缩写
	// 通常写成大写），再并列则按字典序，保证结果确定。
	for (const group of map.values()) {
		group.label = [...group.variants.entries()].sort((a, b) => {
			if (b[1] !== a[1]) return b[1] - a[1];
			const caps = (s) => (s.match(/\p{Lu}/gu) ?? []).length;
			if (caps(b[0]) !== caps(a[0])) return caps(b[0]) - caps(a[0]);
			return a[0].localeCompare(b[0]);
		})[0][0];
	}

	return map;
}

/**
 * 由文章列表构建图。
 *
 * @param {Array<{id: string, title: string, tags: string[], category: string, content?: string}>} posts
 * @param {object} [options]
 * @param {number} [options.minTagCount=2] 标签出现次数低于此值则不入图
 * @param {number} [options.maxNodes=200] 节点上限
 * @param {boolean} [options.linkEdges=true] 是否从正文链接生成 post↔post 边
 * @param {string} [options.postUrl] 文章 URL 模板，支持 {id}
 * @param {string} [options.tagUrl] 标签 URL 模板，支持 {slug}
 * @param {string} [options.categoryUrl] 分类 URL 模板，支持 {slug}
 * @returns {{
 *   nodes: Array<{id: string, label: string, type: string, count?: number, url?: string}>,
 *   edges: Array<{source: string, target: string, type: "tag"|"category"|"link"}>,
 *   meta: object,
 *   links: {edges: Array<{from: string, to: string}>, broken: Array<object>, selfLinks: Array<object>, total: number},
 * }}
 */
export function buildGraph(posts, options = {}) {
	const {
		minTagCount = 2,
		maxNodes = 200,
		linkEdges = true,
		anchorCheck = true,
		assetRoot = null,
		postUrl,
		tagUrl,
		categoryUrl,
	} = options;

	// 按 slug 归并：PEFT / peft 合成一个概念，避免产出 id 重复的畸形节点
	const tagGroups = aggregateBySlug(posts, "tags");
	const categoryGroups = aggregateBySlug(posts, "category");

	const withUrl = (template, value) =>
		template
			? template.replace(/\{(\w+)\}/g, (_, k) => (k === "id" || k === "slug" ? value : ""))
			: undefined;

	/*
	 * 引用解析与「是否生成图边」是两件事：
	 * `--no-link-edges` 只是不进图，断链 / 坏锚点 / 本地路径 / 坏图片仍然要检查。
	 * 所以这里始终做完整解析，只在构图时决定要不要用 edges。
	 */
	const links = resolvePostLinks(posts, { anchorCheck, assetRoot });
	const graphLinkEdges = linkEdges ? links.edges : [];

	const nodes = [];
	const categoryIds = new Set();
	const tagIds = new Set();
	const postIds = new Set();

	for (const [slug, group] of categoryGroups) {
		const id = `cat:${slug}`;
		nodes.push({ id, label: group.label, type: "category", count: group.count, url: withUrl(categoryUrl, slug) });
		categoryIds.add(id);
	}

	for (const [slug, group] of tagGroups) {
		if (group.count < minTagCount) continue;
		const id = `tag:${slug}`;
		nodes.push({ id, label: group.label, type: "tag", count: group.count, url: withUrl(tagUrl, slug) });
		tagIds.add(id);
	}

	// 只有被链接指向、或链接出去的文章 id 集合，用于判断文章节点是否有边
	const linkedFrom = new Set(graphLinkEdges.map((e) => e.from));
	const linkedTo = new Set(graphLinkEdges.map((e) => e.to));

	for (const post of posts) {
		const hasEdge =
			post.tags.some((t) => tagIds.has(`tag:${slugify(t)}`)) ||
			(post.category && categoryIds.has(`cat:${slugify(post.category)}`)) ||
			linkedFrom.has(post.id) ||
			linkedTo.has(post.id);
		// 没有任何连接的叶子节点会让图变成噪声，不入图
		if (!hasEdge) continue;
		const id = `post:${post.id}`;
		nodes.push({ id, label: post.title, type: "post", url: withUrl(postUrl, post.id) });
		postIds.add(id);
	}

	const edges = [];
	for (const post of posts) {
		const postId = `post:${post.id}`;
		if (!postIds.has(postId)) continue;
		if (post.category) {
			const catId = `cat:${slugify(post.category)}`;
			if (categoryIds.has(catId)) edges.push({ source: postId, target: catId, type: "category" });
		}
		const emitted = new Set();
		for (const tag of post.tags) {
			const tagId = `tag:${slugify(tag)}`;
			// 同一篇文章里写了 PEFT 又写了 peft，只应产生一条边
			if (!tagIds.has(tagId) || emitted.has(tagId)) continue;
			emitted.add(tagId);
			edges.push({ source: postId, target: tagId, type: "tag" });
		}
	}

	// post ↔ post 引用边
	let linkEdgeCount = 0;
	for (const { from, to } of graphLinkEdges) {
		const s = `post:${from}`;
		const t = `post:${to}`;
		if (!postIds.has(s) || !postIds.has(t)) continue;
		edges.push({ source: s, target: t, type: "link" });
		linkEdgeCount += 1;
	}

	const meta = {
		posts: posts.length,
		postsInGraph: postIds.size,
		tags: tagGroups.size,
		tagsInGraph: tagIds.size,
		categories: categoryGroups.size,
		linkEdges: linkEdgeCount,
		linksFound: links.total,
		brokenLinks: links.broken.length,
		brokenAnchors: links.brokenAnchors.length,
		localPaths: links.localPaths.length,
		imagesFound: links.imagesFound,
		brokenImages: links.brokenImages.length,
		truncated: false,
	};

	if (nodes.length > maxNodes) {
		meta.truncated = true;
		const cats = nodes.filter((n) => n.type === "category");
		const tags = nodes
			.filter((n) => n.type === "tag")
			.sort((a, b) => (b.count || 0) - (a.count || 0));
		const keepTags = tags.slice(0, Math.max(0, Math.min(30, maxNodes - cats.length)));
		const keepPosts = nodes
			.filter((n) => n.type === "post")
			.slice(0, Math.max(0, maxNodes - cats.length - keepTags.length));

		const kept = new Set([...cats, ...keepTags, ...keepPosts].map((n) => n.id));
		const keptNodes = [...cats, ...keepTags, ...keepPosts];
		const keptEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));

		return { nodes: keptNodes, edges: keptEdges, meta, links };
	}

	return { nodes, edges, meta, links };
}
