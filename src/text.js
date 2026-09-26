/**
 * 共享的文本预处理。
 *
 * 单独成模块是为了避免 links ↔ anchors 之间的循环依赖：
 * 两边都需要「剥掉代码」这一步，但谁都不该依赖对方。
 *
 * **三个函数语义各不相同，混用会直接制造误报**：
 *
 * | 场景 | 用哪个 | 长度 | 为什么 |
 * |---|---|---|---|
 * | 提取链接 | `maskCode` | **不变** | 既要去掉代码里的示例链接，又要能还原行列号 |
 * | 提取标题 | `unwrapInlineCode` | 变 | 行内代码是标题文字的一部分，只去反引号、保留内容 |
 *
 * 两条历史教训：
 *
 * 1. 把「删除行内代码内容」那套用在标题上，`## Use \`foo\` here` 会算成
 *    `use-here`，而 GitHub 的真实锚点是 `use-foo-here`——**整类误报**。
 * 2. 用「删除」而不是「遮蔽」来去掉代码块，偏移量就变了，
 *    于是**行号无从还原**；而错的行号比没有行号更糟。
 *
 * 所以遮蔽用的是**等长空白**：被遮掉的字符全部换成空格，**换行原样保留**。
 *
 * @module text
 */

/** 把一段文本换成等长空白（保留换行），用于遮蔽代码区域 */
function blank(match) {
	return match.replace(/[^\n]/g, " ");
}

/**
 * 去掉围栏代码块、波浪号代码块与 HTML 注释。**保留行内代码。**
 *
 * 仅用于标题提取前的准备——标题里的行内代码要保留内容，
 * 所以这里不能连它一起去掉。
 *
 * @param {string} content
 * @returns {string}
 */
export function stripFencedBlocks(content) {
	return String(content ?? "")
		.replace(/^```[\s\S]*?^```/gm, "")
		.replace(/^~~~[\s\S]*?^~~~/gm, "")
		.replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * 等长遮蔽代码区域（围栏块、未闭合围栏、行内代码、HTML 注释）。
 *
 * **返回值的长度与原文完全一致，换行位置也一致**，因此每个字符的偏移量
 * 在两边是同一个值——这就是能把匹配位置还原成「第几行第几列」的原因。
 *
 * 用于链接提取：遮蔽后代码里的 `[示例](x.md)` 不会被匹配到，
 * 但匹配结果的下标仍可直接用于原文。
 *
 * @param {string} content
 * @returns {string}
 */
export function maskCode(content) {
	return (
		String(content ?? "")
			// 先遮蔽闭合的围栏块
			.replace(/^```[\s\S]*?^```/gm, blank)
			.replace(/^~~~[\s\S]*?^~~~/gm, blank)
			// 未闭合的围栏按 Markdown 规范一直延伸到文末
			.replace(/^```[^\n]*\n[\s\S]*$/m, blank)
			.replace(/^~~~[^\n]*\n[\s\S]*$/m, blank)
			.replace(/<!--[\s\S]*?-->/g, blank)
			.replace(/`[^`\n]*`/g, blank)
	);
}

/**
 * 用于**标题提取**：只去掉反引号，保留行内代码的内容。
 * @param {string} content
 * @returns {string}
 */
export function unwrapInlineCode(content) {
	return stripFencedBlocks(content).replace(/`([^`\n]*)`/g, "$1");
}

/**
 * 把字符偏移量换算成 1-based 的行号与列号。
 *
 * 列号按 UTF-16 码元计（与 GitHub 注解的 `col` 一致）。
 * 含代理对的字符（如 emoji）会占两列——这是已知且可接受的偏差。
 *
 * @param {string} content 原文
 * @param {number} offset 字符偏移
 * @returns {{line: number, column: number}}
 */
export function offsetToPosition(content, offset) {
	const text = String(content ?? "");
	const limit = Math.max(0, Math.min(offset, text.length));
	let line = 1;
	let lastNewline = -1;
	for (let i = 0; i < limit; i++) {
		if (text.charCodeAt(i) === 10) {
			line += 1;
			lastNewline = i;
		}
	}
	return { line, column: limit - lastNewline };
}
