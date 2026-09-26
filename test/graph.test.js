/**
 * 测试套件。
 *
 * 最重要的一组是 normalizeList 的三条：它们把「手写解析器静默丢数据」
 * 这个真实故障固化成回归测试。如果哪天有人为了「减少依赖」把它改回
 * 手写解析，这几条会立刻红。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildGraph, normalizeList, readPosts, slugify } from "../src/graph.js";
import { toHtml, toMermaid } from "../src/render.js";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

/** 在临时目录里造一批 markdown，返回目录路径 */
async function makeCorpus(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-test-"));
	for (const [name, body] of Object.entries(files)) {
		const full = path.join(dir, name);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, body, "utf8");
	}
	return dir;
}

describe("normalizeList —— 三种标签写法的回归测试", () => {
	it("块式数组", () => {
		assert.deepEqual(normalizeList(["a", "b"]), ["a", "b"]);
	});

	it("行内数组（gray-matter 解析后已是数组）", () => {
		assert.deepEqual(normalizeList(["强化学习", "LLM"]), ["强化学习", "LLM"]);
	});

	it("标量字符串（旧实现会丢成 []）", () => {
		assert.deepEqual(normalizeList("RLHF"), ["RLHF"]);
	});

	it("null / undefined 得到空数组，且不抛错", () => {
		assert.deepEqual(normalizeList(null), []);
		assert.deepEqual(normalizeList(undefined), []);
	});

	it("数字标签被转成字符串", () => {
		assert.deepEqual(normalizeList([1, 2]), ["1", "2"]);
	});

	it("空串与纯空白被剔除", () => {
		assert.deepEqual(normalizeList(["a", "", "   ", "b"]), ["a", "b"]);
	});
});

describe("slugify", () => {
	it("保留中文", () => {
		assert.equal(slugify("强化学习"), "强化学习");
	});

	it("英文统一小写并用连字符连接", () => {
		assert.equal(slugify("Reinforcement Learning"), "reinforcement-learning");
	});

	it("去掉首尾多余连字符", () => {
		assert.equal(slugify("  ///LoRA///  "), "lora");
	});
});

describe("readPosts —— 端到端读取示例语料", () => {
	it("读到全部 6 篇示例文章", async () => {
		const posts = await readPosts(EXAMPLES);
		assert.equal(posts.length, 6);
	});

	it("行内数组那篇的标签没有丢", async () => {
		const posts = await readPosts(EXAMPLES);
		const qlora = posts.find((p) => p.id.includes("qlora"));
		assert.ok(qlora, "应能找到 QLoRA 那篇");
		assert.deepEqual(qlora.tags.sort(), ["QLoRA", "微调", "量化"].sort());
	});

	it("标量那篇的标签没有丢", async () => {
		const posts = await readPosts(EXAMPLES);
		const rlhf = posts.find((p) => p.id.includes("rlhf"));
		assert.ok(rlhf, "应能找到 RLHF 那篇");
		assert.deepEqual(rlhf.tags, ["RLHF"]);
	});

	it("标题里的冒号被完整保留", async () => {
		const posts = await readPosts(EXAMPLES);
		const kvcache = posts.find((p) => p.id.includes("kvcache"));
		assert.equal(kvcache.title, "推理优化：KV Cache 与 PagedAttention");
	});
});

describe("readPosts —— 边界情况", () => {
	it("没有 title 的文件被跳过，而不是造出空节点", async () => {
		const dir = await makeCorpus({
			"good.md": "---\ntitle: 有标题\ntags: [a, b]\n---\n正文\n",
			"bad.md": "---\ntags: [a, b]\n---\n没有标题\n",
		});
		const posts = await readPosts(dir);
		assert.equal(posts.length, 1);
		assert.equal(posts[0].title, "有标题");
	});

	it("没有 frontmatter 的文件被跳过", async () => {
		const dir = await makeCorpus({ "plain.md": "# 就是一段普通 markdown\n" });
		const posts = await readPosts(dir);
		assert.equal(posts.length, 0);
	});

	it("子目录被递归读取，且 id 带上了相对路径", async () => {
		const dir = await makeCorpus({
			"2026/deep/post.md": "---\ntitle: 深层文章\ntags: [a, b]\n---\n",
		});
		const posts = await readPosts(dir);
		assert.equal(posts.length, 1);
		assert.equal(posts[0].id, "2026/deep/post");
	});

	it("node_modules 不会被当成语料", async () => {
		const dir = await makeCorpus({
			"node_modules/pkg/readme.md": "---\ntitle: 不该出现\ntags: [a, b]\n---\n",
			"real.md": "---\ntitle: 真文章\ntags: [a, b]\n---\n",
		});
		const posts = await readPosts(dir);
		assert.deepEqual(
			posts.map((p) => p.title),
			["真文章"],
		);
	});

	it("目录不存在时抛出可读的错误", async () => {
		await assert.rejects(() => readPosts("/definitely/not/here"), /语料目录不存在/);
	});
});

describe("buildGraph", () => {
	const posts = [
		{ id: "a", title: "A", tags: ["x", "y"], category: "C" },
		{ id: "b", title: "B", tags: ["x"], category: "C" },
		{ id: "c", title: "C", tags: ["z"], category: "" },
	];

	it("minTagCount 默认 2，只出现一次的标签不入图", () => {
		const g = buildGraph(posts);
		const tagLabels = g.nodes.filter((n) => n.type === "tag").map((n) => n.label).sort();
		assert.deepEqual(tagLabels, ["x"]);
	});

	it("--min-tag-count 1 时全部标签入图", () => {
		const g = buildGraph(posts, { minTagCount: 1 });
		const tagLabels = g.nodes.filter((n) => n.type === "tag").map((n) => n.label).sort();
		assert.deepEqual(tagLabels, ["x", "y", "z"]);
	});

	it("有分类但标签全被过滤的文章仍然入图", () => {
		// 这篇文章的唯一标签只出现一次会被 minTagCount 过滤掉，
		// 但它有 category，所以应该靠分类这条边留在图里。
		const g = buildGraph(
			[
				{ id: "a", title: "A", tags: ["x", "y"], category: "C" },
				{ id: "b", title: "B", tags: ["x"], category: "C" },
				{ id: "onlycat", title: "只有分类", tags: ["z"], category: "C" },
			],
			{ minTagCount: 2 },
		);
		assert.ok(
			!g.nodes.some((n) => n.label === "z"),
			"z 只出现一次，应被 minTagCount 过滤",
		);
		assert.ok(
			g.nodes.some((n) => n.id === "post:onlycat"),
			"该文章应通过分类连入图",
		);
		assert.ok(
			g.edges.some((e) => e.source === "post:onlycat" && e.target === "cat:c"),
			"应存在 该文章 → 分类 的边",
		);
	});

	it("既无标签又无分类的文章不入图（避免孤点）", () => {
		const g = buildGraph([...posts, { id: "d", title: "D", tags: [], category: "" }]);
		assert.ok(!g.nodes.some((n) => n.id === "post:d"));
	});

	it("边只连接已入图的节点", () => {
		const g = buildGraph(posts);
		const ids = new Set(g.nodes.map((n) => n.id));
		for (const e of g.edges) {
			assert.ok(ids.has(e.source), `悬空边的 source: ${e.source}`);
			assert.ok(ids.has(e.target), `悬空边的 target: ${e.target}`);
		}
	});

	it("URL 模板按类型分别套用", () => {
		const g = buildGraph(posts, {
			minTagCount: 1,
			postUrl: "/posts/{id}/",
			tagUrl: "/tags/{slug}/",
			categoryUrl: "/categories/{slug}/",
		});
		assert.equal(g.nodes.find((n) => n.id === "post:a").url, "/posts/a/");
		assert.equal(g.nodes.find((n) => n.id === "tag:x").url, "/tags/x/");
		assert.equal(g.nodes.find((n) => n.id === "cat:c").url, "/categories/c/");
	});

	it("不传 URL 模板时不产生 url 字段", () => {
		const g = buildGraph(posts, { minTagCount: 1 });
		assert.equal(g.nodes[0].url, undefined);
	});

	it("超过 maxNodes 时裁剪，并置 truncated 标记", () => {
		const many = Array.from({ length: 120 }, (_, i) => ({
			id: `p${i}`,
			title: `P${i}`,
			tags: ["shared", `uniq${i}`],
			category: "C",
		}));
		const g = buildGraph(many, { minTagCount: 1, maxNodes: 20 });
		assert.ok(g.nodes.length <= 20, `节点数应 ≤ 20，实际 ${g.nodes.length}`);
		assert.equal(g.meta.truncated, true);
	});

	it("meta 里的计数正确", () => {
		const g = buildGraph(posts, { minTagCount: 1 });
		assert.equal(g.meta.posts, 3);
		assert.equal(g.meta.categories, 1);
		assert.equal(g.meta.tags, 3);
		assert.equal(g.meta.truncated, false);
	});
});

describe("输出渲染", () => {
	const graph = buildGraph(
		[
			{ id: "a", title: "带: 冒号的标题", tags: ["x", "y"], category: "C" },
			{ id: "b", title: "B", tags: ["x"], category: "C" },
		],
		{ minTagCount: 1 },
	);

	it("Mermaid 输出是 graph LR 且节点数正确", () => {
		const mmd = toMermaid(graph);
		assert.ok(mmd.startsWith("graph LR\n"));
		assert.equal(mmd.split("\n").filter((l) => l.includes("-->")).length, graph.edges.length);
	});

	it("Mermaid 里标签的方括号被替换，不会破坏语法", () => {
		const mmd = toMermaid(
			buildGraph([{ id: "a", title: "标题[带]方括号", tags: ["x", "y"], category: "C" }], {
				minTagCount: 1,
			}),
		);
		assert.ok(!/\["[^"]*\[/.test(mmd), "标签内不应残留未转义的方括号");
	});

	it("HTML 自包含：不含任何外部资源引用", () => {
		const html = toHtml(graph);
		assert.ok(!/src=["']https?:/.test(html), "不应引用外部脚本");
		assert.ok(!/<link[^>]+href=["']https?:/.test(html), "不应引用外部样式");
		assert.ok(html.includes("graph-data"));
	});

	it("HTML 内嵌数据中的 < 被转义，防止提前闭合 script", () => {
		const evil = buildGraph([{ id: "a", title: "</script><script>x", tags: ["x", "y"], category: "C" }], {
			minTagCount: 1,
		});
		const html = toHtml(evil);
		assert.ok(!html.includes("</script><script>x"), "标题里的 </script> 必须被转义");
	});
});
