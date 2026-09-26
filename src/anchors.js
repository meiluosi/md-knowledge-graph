/**
 * 标题锚点提取与校验。
 *
 * 为什么需要这一层：博客里链接指向的是「另一篇文章」，而规格文档里
 * 链接指向的是「另一个文件的某个章节」。后者最常见的失效方式是
 * **章节被改名，引用还指着旧锚点**——文件存在，链接却已经死了。
 * 只校验文件是否存在，抓不到这类问题。
 *
 * slug 算法用 `github-slugger`（GitHub 标题锚点的参考实现，本身零依赖），
 * 而不是自己写。理由见 docs/when-to-build-a-tool.md 的条件 ⑤：
 * 自研 slug 会在标点/中日韩/去重等边界上与渲染器产生细微差异，
 * 而那些差异会变成**误报**——误报会让门禁被关掉，比漏报更致命。
 *
 * @module anchors
 */

import GithubSlugger from "github-slugger";
import { unwrapInlineCode } from "./text.js";

/**
 * 按文档顺序提取一份 markdown 里所有标题的锚点。
 *
 * 顺序很重要：同名标题的去重（foo → foo-1 → foo-2）依赖出现次序。
 *
 * 支持 ATX（`## 标题`）与 Setext（下划线式）两种写法。Setext 必须支持，
 * 否则用它的文档会被误报成"锚点不存在"——又是一个误报。
 *
 * 已知不覆盖：HTML 里手写的 `<h2 id="...">`、以及渲染器自定义的
 * slug 规则（如某些插件会加前缀）。前者的取舍见 README 已知取舍。
 *
 * @param {string} content markdown 正文（不含 frontmatter）
 * @returns {string[]} 按出现顺序的锚点列表
 */
export function extractHeadingSlugs(content) {
	const slugger = new GithubSlugger();
	// 注意：这里必须用 unwrapInlineCode 而不是 stripCode。
	// 行内代码是标题文字的一部分（`## Use \`foo\` here` → use-foo-here），
	// 把内容删掉会产生误报。
	const body = unwrapInlineCode(content ?? "");
	const lines = body.split("\n");
	/** @type {string[]} */
	const slugs = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// ATX：## 标题 / ## 标题 ##
		const atx = line.match(/^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
		if (atx) {
			slugs.push(slugger.slug(atx[1]));
			continue;
		}

		// Setext：文本行 + 下一行全 = 或全 -
		const next = lines[i + 1];
		if (
			next !== undefined &&
			line.trim() !== "" &&
			!line.startsWith("    ") &&
			/^ {0,3}(=+|-+)\s*$/.test(next)
		) {
			slugs.push(slugger.slug(line.trim()));
			i += 1; // 跳过下划线行
		}
	}

	return slugs;
}

/**
 * 为全部文章建立「id → 锚点集合」索引。
 *
 * @param {Array<{id: string, content?: string}>} posts
 * @returns {Map<string, Set<string>>}
 */
export function buildAnchorIndex(posts) {
	const index = new Map();
	for (const post of posts) {
		index.set(post.id, new Set(extractHeadingSlugs(post.content ?? "")));
	}
	return index;
}

/**
 * 判断某篇文章是否存在指定锚点。
 *
 * 空锚点视为「指向文件本身」，永远成立。
 *
 * @param {Map<string, Set<string>>} index
 * @param {string} postId
 * @param {string} anchor
 * @returns {boolean}
 */
export function hasAnchor(index, postId, anchor) {
	if (!anchor) return true;
	const set = index.get(postId);
	if (!set) return true; // 不是语料里的文章，交给上层判断
	return set.has(anchor);
}
