/**
 * 链接提取与解析的测试。
 *
 * 这一层决定了「图里文章之间到底连不连得起来」，
 * 也是最容易出隐蔽错误的地方（假链接、中文百分号编码、同名歧义）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildLinkIndex,
	extractLinks,
	isExternal,
	resolvePostLinks,
	resolveTarget,
	stripCode,
} from "../src/links.js";

describe("stripCode —— 不把代码里的示例当链接", () => {
	it("去掉围栏代码块", () => {
		const md = "前\n\n```js\nconst x = '[a](fake.md)';\n```\n\n后";
		assert.ok(!stripCode(md).includes("fake.md"));
	});

	it("去掉波浪号围栏代码块", () => {
		const md = "~~~\n[a](fake.md)\n~~~";
		assert.ok(!stripCode(md).includes("fake.md"));
	});

	it("去掉行内代码", () => {
		assert.ok(!stripCode("参考 `[a](fake.md)` 的写法").includes("fake.md"));
	});

	it("去掉 HTML 注释", () => {
		assert.ok(!stripCode("<!-- [a](fake.md) -->").includes("fake.md"));
	});

	it("保留正常正文里的链接", () => {
		assert.ok(stripCode("见 [真链接](real.md)").includes("real.md"));
	});
});

describe("extractLinks", () => {
	it("提取 markdown 链接", () => {
		const links = extractLinks("见 [文字](a/b.md)。");
		assert.equal(links.length, 1);
		assert.equal(links[0].kind, "markdown");
		assert.equal(links[0].target, "a/b.md");
		assert.equal(links[0].text, "文字");
	});

	it("跳过图片，不当成引用", () => {
		assert.deepEqual(extractLinks("![截图](img/x.png)"), []);
	});

	it("提取 wikilink，并支持 | 别名", () => {
		const links = extractLinks("见 [[foo]] 与 [[bar|显示这个]]");
		assert.equal(links.length, 2);
		assert.equal(links[0].kind, "wikilink");
		assert.equal(links[0].target, "foo");
		assert.equal(links[1].target, "bar");
		assert.equal(links[1].text, "显示这个");
	});

	it("支持链接标题（title 部分）", () => {
		const links = extractLinks('[x](a.md "标题")');
		assert.equal(links[0].target, "a.md");
	});

	it("空内容返回空数组", () => {
		assert.deepEqual(extractLinks(""), []);
	});
});

describe("isExternal", () => {
	it("http/https/mailto 是外部", () => {
		for (const t of ["https://a.com", "http://a.com", "mailto:a@b.c"]) {
			assert.equal(isExternal(t), true, t);
		}
	});
	it("相对路径与站点绝对路径不是外部", () => {
		for (const t of ["./a.md", "../a.md", "/posts/a/"]) {
			assert.equal(isExternal(t), false, t);
		}
	});
});

describe("resolveTarget", () => {
	const posts = [
		{ id: "2026-01-05-lora-rank", title: "LoRA" },
		{ id: "notes/deep/thing", title: "Deep" },
		{ id: "dup/same", title: "Same A" },
		{ id: "other/same", title: "Same B" },
	];
	const index = buildLinkIndex(posts);
	const from = { id: "2026-01-05-lora-rank" };

	it("同目录相对路径 + .md", () => {
		assert.equal(resolveTarget("./2026-01-05-lora-rank.md", { id: "x" }, index), "2026-01-05-lora-rank");
	});

	it("去掉扩展名也能命中", () => {
		assert.equal(resolveTarget("2026-01-05-lora-rank", from, index), "2026-01-05-lora-rank");
	});

	it("站内绝对路径 /posts/<id>/", () => {
		assert.equal(resolveTarget("/posts/2026-01-05-lora-rank/", from, index), "2026-01-05-lora-rank");
	});

	it("百分号编码的中文路径能被解码", () => {
		const cn = [{ id: "2024-06-09-关于数据分析思考", title: "t" }];
		const cnIndex = buildLinkIndex(cn);
		const encoded = `/posts/${encodeURIComponent("2024-06-09-关于数据分析思考")}/`;
		assert.equal(resolveTarget(encoded, { id: "x" }, cnIndex), "2024-06-09-关于数据分析思考");
	});

	it("wikilink 按文件名解析", () => {
		assert.equal(resolveTarget("thing", { id: "x" }, index), "notes/deep/thing");
	});

	it("相对路径能向上跨目录", () => {
		assert.equal(resolveTarget("../../2026-01-05-lora-rank.md", { id: "notes/deep/thing" }, index), "2026-01-05-lora-rank");
	});

	it("锚点被忽略", () => {
		assert.equal(resolveTarget("2026-01-05-lora-rank#section", from, index), "2026-01-05-lora-rank");
	});

	it("同名文件产生歧义时返回 null，而不是猜一个", () => {
		assert.equal(resolveTarget("same", { id: "x" }, index), null);
	});

	it("外部链接返回 null", () => {
		assert.equal(resolveTarget("https://example.com", from, index), null);
	});

	it("找不到时返回 null", () => {
		assert.equal(resolveTarget("./nope.md", from, index), null);
	});
});

describe("resolvePostLinks", () => {
	const posts = [
		{
			id: "a",
			title: "A",
			content: "见 [B](./b.md)，再引一次 [B](./b.md)，还有 [[c]]。",
		},
		{ id: "b", title: "B", content: "回到 [A](./a.md)。" },
		{ id: "c", title: "C", content: "自引用 [自己](./c.md)，断链 [没了](./gone.md)。" },
		{ id: "d", title: "D", content: "" },
	];

	it("重复引用只留一条边", () => {
		const { edges } = resolvePostLinks(posts);
		const ab = edges.filter((e) => e.from === "a" && e.to === "b");
		assert.equal(ab.length, 1);
	});

	it("wikilink 也能连上", () => {
		const { edges } = resolvePostLinks(posts);
		assert.ok(edges.some((e) => e.from === "a" && e.to === "c"));
	});

	it("反向引用单独成边", () => {
		const { edges } = resolvePostLinks(posts);
		assert.ok(edges.some((e) => e.from === "b" && e.to === "a"));
	});

	it("自引用被单独归类，不进边", () => {
		const { edges, selfLinks } = resolvePostLinks(posts);
		assert.equal(selfLinks.length, 1);
		assert.equal(selfLinks[0].from, "c");
		assert.ok(!edges.some((e) => e.from === "c" && e.to === "c"));
	});

	it("断链被单独归类", () => {
		const { broken } = resolvePostLinks(posts);
		assert.deepEqual(
			broken.map((b) => b.from),
			["c"],
		);
	});

	it("没有正文的文章不产生任何链接", () => {
		const { edges, broken } = resolvePostLinks([posts[3]]);
		assert.deepEqual(edges, []);
		assert.deepEqual(broken, []);
	});
});
