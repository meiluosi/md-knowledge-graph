/**
 * 知识图谱构建核心。
 *
 * 职责边界：这里只做「读 markdown → 解析 frontmatter → 构图」，
 * 不做任何输出格式的决定（那是 render.js 的事）。
 *
 * @module graph
 */

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

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
 * 读取语料目录，解析出文章元数据。
 *
 * @param {string} dir 语料根目录
 * @returns {Promise<Array<{id: string, title: string, tags: string[], category: string, file: string}>>}
 */
export async function readPosts(dir) {
	const files = await collectMarkdown(dir);
	/** @type {Array<{id: string, title: string, tags: string[], category: string, file: string}>} */
	const posts = [];

	for (const file of files) {
		const raw = await fs.readFile(file, "utf8");
		let data;
		try {
			({ data } = matter(raw));
		} catch (err) {
			throw new Error(`frontmatter 解析失败：${file}\n${/** @type {Error} */ (err).message}`);
		}

		const title = typeof data.title === "string" ? data.title.trim() : "";
		// 没有标题的文件无法在图里标识，跳过而不是造一个空节点
		if (!title) continue;

		posts.push({
			id: path.relative(dir, file).replace(/\\/g, "/").replace(/\.mdx?$/i, ""),
			title,
			tags: normalizeList(data.tags),
			category: typeof data.category === "string" ? data.category.trim() : "",
			file,
		});
	}

	return posts;
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
 * 由文章列表构建图。
 *
 * 结构：post ↔ tag、post ↔ category 的二部边，合成一张三部图。
 *
 * @param {Array<{id: string, title: string, tags: string[], category: string}>} posts
 * @param {object} [options]
 * @param {number} [options.minTagCount=2] 标签出现次数低于此值则不入图（避免图谱被长尾标签淹没）
 * @param {number} [options.maxNodes=200] 节点上限，超出时按「分类全留 + 标签按频次」裁剪
 * @param {string} [options.postUrl] 文章 URL 模板，支持 {id} 占位
 * @param {string} [options.tagUrl] 标签 URL 模板，支持 {slug}
 * @param {string} [options.categoryUrl] 分类 URL 模板，支持 {slug}
 * @returns {{nodes: Array<object>, edges: Array<object>, meta: object}}
 */
export function buildGraph(posts, options = {}) {
	const {
		minTagCount = 2,
		maxNodes = 200,
		postUrl,
		tagUrl,
		categoryUrl,
	} = options;

	/** @type {Record<string, number>} */
	const tagCounts = {};
	/** @type {Record<string, number>} */
	const categoryCounts = {};

	for (const post of posts) {
		for (const tag of post.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
		if (post.category) categoryCounts[post.category] = (categoryCounts[post.category] || 0) + 1;
	}

	const withUrl = (template, value) => (template ? template.replace(/\{(\w+)\}/g, (_, k) => (k === "id" || k === "slug" ? value : "")) : undefined);

	const nodes = [];
	const categoryIds = new Set();
	const tagIds = new Set();
	const postIds = new Set();

	for (const [name, count] of Object.entries(categoryCounts)) {
		const slug = slugify(name);
		const id = `cat:${slug}`;
		nodes.push({ id, label: name, type: "category", count, url: withUrl(categoryUrl, slug) });
		categoryIds.add(id);
	}

	for (const [name, count] of Object.entries(tagCounts)) {
		if (count < minTagCount) continue;
		const slug = slugify(name);
		const id = `tag:${slug}`;
		nodes.push({ id, label: name, type: "tag", count, url: withUrl(tagUrl, slug) });
		tagIds.add(id);
	}

	for (const post of posts) {
		// 没有任何入图标签、也没有分类的文章会成为孤点，不放进图里
		const hasEdge = post.tags.some((t) => tagIds.has(`tag:${slugify(t)}`)) || (post.category && categoryIds.has(`cat:${slugify(post.category)}`));
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
			if (categoryIds.has(catId)) edges.push({ source: postId, target: catId });
		}
		for (const tag of post.tags) {
			const tagId = `tag:${slugify(tag)}`;
			if (tagIds.has(tagId)) edges.push({ source: postId, target: tagId });
		}
	}

	const meta = {
		posts: posts.length,
		postsInGraph: postIds.size,
		tags: Object.keys(tagCounts).length,
		tagsInGraph: tagIds.size,
		categories: categoryIds.size,
		truncated: false,
	};

	if (nodes.length > maxNodes) {
		meta.truncated = true;
		const cats = nodes.filter((n) => n.type === "category");
		const tags = nodes.filter((n) => n.type === "tag").sort((a, b) => (b.count || 0) - (a.count || 0));
		const keepTags = tags.slice(0, Math.max(0, Math.min(30, maxNodes - cats.length)));
		const keepPosts = nodes
			.filter((n) => n.type === "post")
			.slice(0, Math.max(0, maxNodes - cats.length - keepTags.length));

		const kept = new Set([...cats, ...keepTags, ...keepPosts].map((n) => n.id));
		const keptNodes = [...cats, ...keepTags, ...keepPosts];
		const keptEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target));

		return { nodes: keptNodes, edges: keptEdges, meta };
	}

	return { nodes, edges, meta };
}
