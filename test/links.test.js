/**
 * 链接提取与解析的测试。
 *
 * 这一层决定了「图里文章之间到底连不连得起来」，
 * 也是最容易出隐蔽错误的地方（假链接、中文百分号编码、同名歧义）。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
	buildLinkIndex,
	extractLinks,
	isExternal,
	isLocalFilePath,
	resolvePostLinks,
	resolveTarget,
} from "../src/links.js";
import { maskCode, offsetToPosition } from "../src/text.js";

describe("maskCode —— 不把代码里的示例当链接", () => {
	it("遮蔽围栏代码块", () => {
		const md = "前\n\n```js\nconst x = '[a](fake.md)';\n```\n\n后";
		assert.ok(!maskCode(md).includes("fake.md"));
	});

	it("遮蔽波浪号围栏代码块", () => {
		assert.ok(!maskCode("~~~\n[a](fake.md)\n~~~").includes("fake.md"));
	});

	it("遮蔽未闭合的围栏（按规范延伸到文末）", () => {
		assert.ok(!maskCode("正文\n\n```\n[a](fake.md)\n更多内容").includes("fake.md"));
	});

	it("遮蔽行内代码", () => {
		assert.ok(!maskCode("参考 `[a](fake.md)` 的写法").includes("fake.md"));
	});

	it("遮蔽 HTML 注释", () => {
		assert.ok(!maskCode("<!-- [a](fake.md) -->").includes("fake.md"));
	});

	it("保留正常正文里的链接", () => {
		assert.ok(maskCode("见 [真链接](real.md)").includes("real.md"));
	});

	it("长度与换行位置都不变（这是行号能还原的前提）", () => {
		const md = "开头\n\n```js\nconst x = 1;\n```\n\n`inline`\n\n结尾\n";
		const masked = maskCode(md);
		assert.equal(masked.length, md.length, "长度必须一致");
		assert.equal(
			[...md].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0).join(","),
			[...masked].map((c, i) => (c === "\n" ? i : -1)).filter((i) => i >= 0).join(","),
			"换行位置必须一致",
		);
	});
});

describe("offsetToPosition", () => {
	it("第 1 行第 1 列对应偏移 0", () => {
		assert.deepEqual(offsetToPosition("abc\ndef", 0), { line: 1, column: 1 });
	});

	it("算到行首之后", () => {
		assert.deepEqual(offsetToPosition("abc\ndef", 3), { line: 1, column: 4 });
	});

	it("换行符之后是下一行第 1 列", () => {
		assert.deepEqual(offsetToPosition("abc\ndef", 4), { line: 2, column: 1 });
	});

	it("跨多行", () => {
		assert.deepEqual(offsetToPosition("a\nb\nc\nd", 6), { line: 4, column: 1 });
	});

	it("偏移超出长度时夹到末尾，不抛错", () => {
		assert.deepEqual(offsetToPosition("ab", 99), { line: 1, column: 3 });
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

	it("图片被单独归类，不会当成文章引用", () => {
		const links = extractLinks("![截图](img/x.png)");
		assert.equal(links.length, 1);
		assert.equal(links[0].kind, "image");
		assert.equal(links[0].target, "img/x.png");
	});

	it("图片与正文链接可以同时提取，各自归类", () => {
		const links = extractLinks("![图](a.png)\n\n见 [文](./b.md)");
		assert.deepEqual(
			links.map((l) => l.kind).sort(),
			["image", "markdown"],
		);
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

	it("Windows 盘符路径**不是**外部链接", () => {
		// 这是个真实 bug：`C:` 曾被当成 URL 协议，导致 19 个引用被静默跳过
		for (const t of ["C:\\Users\\x\\a.png", "C:/Users/x/a.png", "d:\\a.md"]) {
			assert.equal(isLocalFilePath(t), true, `应识别为本地路径: ${t}`);
			assert.equal(isExternal(t), false, `不应视为外链: ${t}`);
		}
	});

	it("UNC 路径也是本地路径", () => {
		assert.equal(isLocalFilePath("\\\\server\\share\\a.png"), true);
		assert.equal(isExternal("\\\\server\\share\\a.png"), false);
	});

	it("多字符协议仍然是外部（单字母才可能是盘符）", () => {
		for (const t of ["tls:foo", "data:image/png;base64,AAA", "obsidian://x"]) {
			assert.equal(isExternal(t), true, t);
			assert.equal(isLocalFilePath(t), false, t);
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

describe("resolvePostLinks —— 位置信息", () => {
	it("断链带上正确的行列号", () => {
		const content = ["第一行", "第二行", "第三行 [没了](./gone.md) 后面"].join("\n");
		const { broken } = resolvePostLinks([{ id: "a", title: "A", content }]);
		assert.equal(broken.length, 1);
		assert.equal(broken[0].line, 3);
		assert.equal(broken[0].column, 5);
	});

	it("失效锚点带行列号", () => {
		const content = ["## 存在的章节", "", "见 [x](./b.md#不存在)"].join("\n");
		const posts = [
			{ id: "a", title: "A", content },
			{ id: "b", title: "B", content: "## 存在的章节\n" },
		];
		const { brokenAnchors } = resolvePostLinks(posts);
		assert.equal(brokenAnchors.length, 1);
		assert.equal(brokenAnchors[0].line, 3);
	});

	it("同文件失效锚点也带行列号", () => {
		const content = ["## 甲", "", "回到 [不存在](#ghost)"].join("\n");
		const { brokenAnchors } = resolvePostLinks([{ id: "a", title: "A", content }]);
		assert.equal(brokenAnchors[0].line, 3);
		assert.equal(brokenAnchors[0].sameFile, true);
	});

	it("自引用带行列号", () => {
		const content = ["行一", "行二 [自](./a.md)"].join("\n");
		const { selfLinks } = resolvePostLinks([{ id: "a", title: "A", content }]);
		assert.equal(selfLinks[0].line, 2);
	});

	it("代码块里的假链接不产生位置条目", () => {
		const content = ["```", "[假](./gone.md)", "```"].join("\n");
		const { broken } = resolvePostLinks([{ id: "a", title: "A", content }]);
		assert.deepEqual(broken, []);
	});

	it("lineOffset 被加进去（换算成文件行号，而不是正文行号）", () => {
		// 模拟 frontmatter 占 6 行：正文第 1 行其实是文件第 7 行
		const posts = [
			{ id: "a", title: "A", content: "行一\n行二 [没了](./gone.md)", lineOffset: 6 },
		];
		const { broken } = resolvePostLinks(posts);
		assert.equal(broken[0].line, 8, "正文第 2 行 + 偏移 6 = 文件第 8 行");
	});

	it("没有 lineOffset 时按正文行号（向后兼容）", () => {
		const posts = [{ id: "a", title: "A", content: "行一\n行二 [没了](./gone.md)" }];
		const { broken } = resolvePostLinks(posts);
		assert.equal(broken[0].line, 2);
	});

	it("列号按字符计，中文字符各占一列", () => {
		// 「见 」占 2 列，链接从第 3 列开始
		const content = "见 [没了](./gone.md)";
		const { broken } = resolvePostLinks([{ id: "a", title: "A", content }]);
		assert.equal(broken[0].column, 3);
	});
});

describe("resolvePostLinks —— 本地路径与图片", () => {
	it("Windows 路径被单独归类，不算断链", () => {
		const posts = [{ id: "a", title: "A", content: "![图](C:\\Users\\x\\a.png)" }];
		const { localPaths, broken, brokenImages } = resolvePostLinks(posts);
		assert.equal(localPaths.length, 1);
		assert.equal(localPaths[0].kind, "image");
		assert.deepEqual(broken, [], "本地路径不该同时被算成断链");
		assert.deepEqual(brokenImages, []);
	});

	it("Windows 路径上的正文链接同样归类为本地路径", () => {
		const posts = [{ id: "a", title: "A", content: "[文档](C:\\docs\\x.md)" }];
		const { localPaths, broken } = resolvePostLinks(posts);
		assert.equal(localPaths.length, 1);
		assert.equal(localPaths[0].kind, "markdown");
		assert.deepEqual(broken, []);
	});

	it("本地路径带行列号", () => {
		const posts = [{ id: "a", title: "A", content: "行一\n行二 ![图](D:/x/a.png)" }];
		const { localPaths } = resolvePostLinks(posts);
		assert.equal(localPaths[0].line, 2);
		assert.equal(localPaths[0].column, 4);
	});

	it("代码块里的本地路径不报（被遮蔽）", () => {
		const posts = [{ id: "a", title: "A", content: "```\n![图](C:\\x\\a.png)\n```" }];
		assert.deepEqual(resolvePostLinks(posts).localPaths, []);
	});

	it("外链图片不计入内部图片数，也不检查存在性", () => {
		const posts = [{ id: "a", title: "A", content: "![图](https://example.com/a.png)" }];
		const { imagesFound, brokenImages } = resolvePostLinks(posts);
		assert.equal(imagesFound, 0, "imagesFound 的口径是「内部图片」，外链不算");
		assert.deepEqual(brokenImages, []);
	});

	it("内部图片（含站点绝对路径）计入 imagesFound", () => {
		const posts = [{ id: "a", title: "A", content: "![图](/img/a.png)", file: "/x/a.md" }];
		assert.equal(resolvePostLinks(posts).imagesFound, 1);
	});

	it("data URI 不检查", () => {
		const posts = [{ id: "a", title: "A", content: "![图](data:image/png;base64,AAAA)" }];
		assert.deepEqual(resolvePostLinks(posts).brokenImages, []);
	});

	it("相对路径图片存在时不报", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-img-"));
		await fs.writeFile(path.join(dir, "pic.png"), "x");
		const posts = [
			{ id: "a", title: "A", content: "![图](./pic.png)", file: path.join(dir, "a.md") },
		];
		assert.deepEqual(resolvePostLinks(posts).brokenImages, []);
	});

	it("相对路径图片不存在时报 broken-image，并带行列号", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-img-"));
		const posts = [
			{ id: "a", title: "A", content: "行一\n![图](./missing.png)", file: path.join(dir, "a.md") },
		];
		const { brokenImages, imagesFound } = resolvePostLinks(posts);
		assert.equal(imagesFound, 1);
		assert.equal(brokenImages.length, 1);
		assert.equal(brokenImages[0].line, 2);
	});

	it("没有 file 信息时无法判断，不误报", () => {
		const posts = [{ id: "a", title: "A", content: "![图](./x.png)" }];
		assert.deepEqual(resolvePostLinks(posts).brokenImages, [], "判不了就不能说缺失");
	});

	it("站点绝对路径图片默认不检查（宁可不判，不可误报）", () => {
		const posts = [{ id: "a", title: "A", content: "![图](/img/a.png)", file: "/nowhere/a.md" }];
		assert.deepEqual(resolvePostLinks(posts).brokenImages, []);
	});

	it("给了 assetRoot 才检查站点绝对路径", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-assets-"));
		const posts = [{ id: "a", title: "A", content: "![图](/img/a.png)", file: "/nowhere/a.md" }];

		assert.equal(
			resolvePostLinks(posts, { assetRoot: root }).brokenImages.length,
			1,
			"根目录下没有 img/a.png，应报缺失",
		);

		await fs.mkdir(path.join(root, "img"), { recursive: true });
		await fs.writeFile(path.join(root, "img", "a.png"), "x");
		assert.deepEqual(
			resolvePostLinks(posts, { assetRoot: root }).brokenImages,
			[],
			"文件放进去之后就不该报了",
		);
	});

	it("百分号编码的图片路径也能被检查", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-img-"));
		await fs.writeFile(path.join(dir, "中文图.png"), "x");
		const encoded = `./${encodeURIComponent("中文图.png")}`;
		const posts = [{ id: "a", title: "A", content: `![图](${encoded})`, file: path.join(dir, "a.md") }];
		assert.deepEqual(resolvePostLinks(posts).brokenImages, []);
	});

	it("图片不进入图边（图片不是知识结构）", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-img-"));
		await fs.writeFile(path.join(dir, "pic.png"), "x");
		const posts = [
			{ id: "a", title: "A", content: "![图](./pic.png)", file: path.join(dir, "a.md") },
			{ id: "b", title: "B", content: "", file: path.join(dir, "b.md") },
		];
		const { edges, broken } = resolvePostLinks(posts);
		assert.deepEqual(edges, []);
		assert.deepEqual(broken, []);
	});
});
