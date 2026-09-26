/**
 * 共享的文本预处理。
 *
 * 单独成模块是为了避免 links ↔ anchors 之间的循环依赖：
 * 两边都需要「剥掉代码」这一步，但谁都不该依赖对方。
 *
 * **注意这里有两个不同的操作，别混用**：
 *
 * | 场景 | 要用的函数 | 为什么 |
 * |---|---|---|
 * | 提取链接 | `stripCode` | 行内代码里的 `[a](b.md)` 是**示例**，内容要整段丢掉 |
 * | 提取标题 | `unwrapInlineCode` | 行内代码是标题文字的一部分，只能去掉反引号、保留内容 |
 *
 * 混用会直接产生**误报**：标题 `` ## Use `foo` here `` 在 GitHub 上的锚点是
 * `use-foo-here`；若按链接那套把行内代码内容删掉，就会算成 `use-here`，
 * 于是所有指向该标题的链接都被判为"失效锚点"。误报会让门禁被关掉。
 *
 * @module text
 */

/**
 * 去掉围栏代码块、波浪号代码块与 HTML 注释。**保留行内代码。**
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
 * 用于**链接提取**：连同行内代码的内容一起去掉。
 * @param {string} content
 * @returns {string}
 */
export function stripCode(content) {
	return stripFencedBlocks(content).replace(/`[^`\n]*`/g, "");
}

/**
 * 用于**标题提取**：只去掉反引号，保留行内代码的内容。
 * @param {string} content
 * @returns {string}
 */
export function unwrapInlineCode(content) {
	return stripFencedBlocks(content).replace(/`([^`\n]*)`/g, "$1");
}
