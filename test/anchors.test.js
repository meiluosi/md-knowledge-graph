/**
 * 锚点提取与校验的测试。
 *
 * 这一层的失败模式是「误报」而不是「漏报」：
 * 如果 slug 算法与渲染器有差异，或者代码块里的假标题被当成真标题，
 * 用户就会看到不存在的"失效锚点"，然后关掉整个门禁。
 * 所以这里的用例以「不该报的不能报」为主。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAnchorIndex, extractHeadingSlugs, hasAnchor } from "../src/anchors.js";
import { resolvePostLinks } from "../src/links.js";

describe("extractHeadingSlugs —— 与渲染器对齐", () => {
	// 这些期望值来自 github-slugger 的实际输出，不是推测
	const cases = [
		["## Hello, World!", "hello-world"],
		["## API 契约", "api-契约"],
		["### LoRA：低秩微调", "lora低秩微调"],
		["## Use `foo` here", "use-foo-here"],
		["## **Bold** heading", "bold-heading"],
		["## 1. Numbered", "1-numbered"],
		["## C++ / Rust", "c--rust"],
		["## 中文标题（带括号）", "中文标题带括号"],
	];

	for (const [heading, expected] of cases) {
		it(`${JSON.stringify(heading)} → ${expected}`, () => {
			assert.deepEqual(extractHeadingSlugs(heading), [expected]);
		});
	}

	it("支持 1–6 级标题", () => {
		const md = "# a\n## b\n### c\n#### d\n##### e\n###### f\n####### g";
		assert.deepEqual(extractHeadingSlugs(md), ["a", "b", "c", "d", "e", "f"]);
	});

	it("支持行尾闭合井号", () => {
		assert.deepEqual(extractHeadingSlugs("## 标题 ##"), ["标题"]);
	});

	it("同名标题按出现顺序去重", () => {
		assert.deepEqual(extractHeadingSlugs("## Foo\n## Foo\n## Foo"), ["foo", "foo-1", "foo-2"]);
	});

	it("按文档顺序返回（去重依赖顺序）", () => {
		assert.deepEqual(extractHeadingSlugs("## B\n## A\n## B"), ["b", "a", "b-1"]);
	});

	it("围栏代码块里的 # 不是标题", () => {
		const md = "## 真标题\n\n```sh\n# 这是注释\n## 也不是标题\n```\n";
		assert.deepEqual(extractHeadingSlugs(md), ["真标题"]);
	});

	it("行内代码里的 # 不产生标题", () => {
		assert.deepEqual(extractHeadingSlugs("正文 `# 不是标题` 结束"), []);
	});

	it("HTML 注释里的标题被忽略", () => {
		assert.deepEqual(extractHeadingSlugs("<!-- ## 隐藏 -->\n## 真"), ["真"]);
	});
});

describe("extractHeadingSlugs —— Setext 标题", () => {
	it("=== 形式的 H1", () => {
		assert.deepEqual(extractHeadingSlugs("标题\n==="), ["标题"]);
	});

	it("--- 形式的 H2", () => {
		assert.deepEqual(extractHeadingSlugs("小节\n---"), ["小节"]);
	});

	it("Setext 与 ATX 混合时保持文档顺序", () => {
		assert.deepEqual(extractHeadingSlugs("A\n===\n## B\nC\n---"), ["a", "b", "c"]);
	});

	it("分隔线（前后空行）不会被当成 Setext 标题", () => {
		// 前面的行是空的，所以 --- 是分隔线而非标题下划线
		assert.deepEqual(extractHeadingSlugs("正文\n\n---\n\n更多正文"), []);
	});

	it("缩进 4 空格的行不参与 Setext", () => {
		assert.deepEqual(extractHeadingSlugs("    缩进代码\n---"), []);
	});
});

describe("buildAnchorIndex / hasAnchor", () => {
	const posts = [
		{ id: "a", content: "## Alpha\n## Beta" },
		{ id: "b", content: "## 中文小节" },
	];

	it("为每篇文章建立锚点集合", () => {
		const index = buildAnchorIndex(posts);
		assert.deepEqual([...index.get("a")].sort(), ["alpha", "beta"]);
		assert.deepEqual([...index.get("b")], ["中文小节"]);
	});

	it("存在则命中", () => {
		assert.equal(hasAnchor(buildAnchorIndex(posts), "a", "alpha"), true);
	});

	it("不存在则不命中", () => {
		assert.equal(hasAnchor(buildAnchorIndex(posts), "a", "gamma"), false);
	});

	it("空锚点视为指向文件本身，永远成立", () => {
		assert.equal(hasAnchor(buildAnchorIndex(posts), "a", ""), true);
	});

	it("未知文章不在这里判定（交给上层）", () => {
		assert.equal(hasAnchor(buildAnchorIndex(posts), "ghost", "whatever"), true);
	});
});

describe("resolvePostLinks —— 锚点校验", () => {
	const posts = [
		{
			id: "a",
			title: "A",
			content: [
				"## First Section",
				"",
				"[跨文件-有效](./b.md#second-section)",
				"[跨文件-失效](./b.md#renamed-section)",
				"[本文-有效](#first-section)",
				"[本文-失效](#ghost-section)",
				"",
				"```",
				"[代码块里的假锚点](#also-fake)",
				"```",
			].join("\n"),
		},
		{ id: "b", title: "B", content: "## Second Section\n\n回到 [A](./a.md)" },
	];

	it("有效锚点不报", () => {
		const { brokenAnchors } = resolvePostLinks(posts);
		const anchors = brokenAnchors.map((b) => b.anchor);
		assert.ok(!anchors.includes("second-section"), "有效锚点被误报");
		assert.ok(!anchors.includes("first-section"), "本文有效锚点被误报");
	});

	it("代码块里的假锚点不报", () => {
		const { brokenAnchors } = resolvePostLinks(posts);
		assert.ok(
			!brokenAnchors.some((b) => b.anchor === "also-fake"),
			"代码块里的假锚点被误报",
		);
	});

	it("跨文件失效锚点被报出", () => {
		const { brokenAnchors } = resolvePostLinks(posts);
		const hit = brokenAnchors.find((b) => b.anchor === "renamed-section");
		assert.ok(hit, "应报出 renamed-section");
		assert.equal(hit.from, "a");
		assert.equal(hit.to, "b");
		assert.equal(hit.sameFile, false);
	});

	it("同文件失效锚点被报出并标记 sameFile", () => {
		const { brokenAnchors } = resolvePostLinks(posts);
		const hit = brokenAnchors.find((b) => b.anchor === "ghost-section");
		assert.ok(hit, "应报出 ghost-section");
		assert.equal(hit.sameFile, true);
		assert.equal(hit.to, "a");
	});

	it("恰好报出 2 个失效锚点", () => {
		const { brokenAnchors } = resolvePostLinks(posts);
		assert.equal(brokenAnchors.length, 2);
	});

	it("带锚点的链接仍然产生图边（锚点不影响连通性）", () => {
		const { edges } = resolvePostLinks(posts);
		assert.ok(edges.some((e) => e.from === "a" && e.to === "b"));
	});

	it("同文件锚点不产生图边", () => {
		const { edges } = resolvePostLinks(posts);
		assert.ok(!edges.some((e) => e.from === "a" && e.to === "a"));
	});

	it("同文件锚点不算「自引用文章」警告", () => {
		const { selfLinks } = resolvePostLinks(posts);
		assert.deepEqual(selfLinks, []);
	});

	it("anchorCheck: false 时完全不校验锚点", () => {
		const { brokenAnchors } = resolvePostLinks(posts, { anchorCheck: false });
		assert.deepEqual(brokenAnchors, []);
	});

	it("百分号编码的锚点会被解码后比较", () => {
		const cn = [
			{ id: "x", title: "X", content: "[有效](./y.md#%E4%B8%AD%E6%96%87)" },
			{ id: "y", title: "Y", content: "## 中文" },
		];
		const { brokenAnchors } = resolvePostLinks(cn);
		assert.deepEqual(brokenAnchors, [], "编码后的中文锚点应解析为「中文」并命中");
	});
});
