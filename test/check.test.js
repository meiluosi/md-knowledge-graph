/**
 * 检查器测试。
 *
 * 这些用例定义了「什么算问题、什么算错误」——也正是 CI 会依据的东西，
 * 所以断言要写死具体行为，不能只测「有没有返回值」。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatReport, runChecks } from "../src/check.js";
import { buildGraph } from "../src/graph.js";

/** 造一份语料 + 图，省去文件系统 */
function setup(posts, options = {}) {
	// 默认按"作者在用 frontmatter"处理——untagged / missing-title 只对这类文章报。
	// 需要测"纯 markdown 语料"时，在用例里显式传 hasFrontmatter: false 覆盖。
	const withFm = posts.map((p) => ({ hasFrontmatter: true, ...p }));
	const graph = buildGraph(withFm, { minTagCount: 2, ...options });
	return runChecks({ posts: withFm, skipped: options.skipped ?? [], graph, minTagCount: 2 });
}

const codes = (r) => r.groups.map((g) => g.code);

describe("runChecks —— 错误级", () => {
	it("断链是错误", () => {
		const r = setup([{ id: "a", title: "A", tags: ["x", "y"], category: "", content: "[没了](./gone.md)" }]);
		assert.ok(codes(r).includes("broken-link"));
		assert.equal(r.errors, 1);
	});

	it("frontmatter 解析失败是错误", () => {
		const r = setup([{ id: "a", title: "A", tags: ["x", "y"], category: "", content: "" }], {
			skipped: [{ file: "bad.md", reason: "frontmatter 解析失败：boom" }],
		});
		assert.ok(codes(r).includes("parse-error"));
		assert.equal(r.errors, 1);
	});

	it("干净语料没有错误", () => {
		const r = setup([
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[B](./b.md)" },
			{ id: "b", title: "B", tags: ["x", "y"], category: "C", content: "[A](./a.md)" },
		]);
		assert.equal(r.errors, 0);
	});
});

describe("runChecks —— 警告级", () => {
	it("无标签文章被报出", () => {
		const r = setup([{ id: "a", title: "A", tags: [], category: "C", content: "" }]);
		assert.ok(codes(r).includes("untagged"));
		assert.equal(r.errors, 0);
	});

	it("**纯 markdown 语料不报「无标签」**（它们本来就不用标签）", () => {
		// 规格文档 design.md / tasks.md 没有 frontmatter，也就没有标签。
		// 对它们逐篇报无标签只是噪声，会掩盖真正的问题。
		const r = setup([
			{ id: "design", title: "设计", tags: [], category: "", content: "", hasFrontmatter: false },
			{ id: "tasks", title: "任务", tags: [], category: "", content: "", hasFrontmatter: false },
		]);
		assert.ok(!codes(r).includes("untagged"), "纯 markdown 不该被报无标签");
	});

	it("写了 frontmatter 却没给 title 会被报出（并说明用了什么兜底）", () => {
		const r = setup([
			{
				id: "a",
				title: "文件名兜底",
				tags: ["x", "y"],
				category: "",
				content: "",
				missingFrontmatterTitle: true,
			},
		]);
		const g = r.groups.find((x) => x.code === "missing-title");
		assert.ok(g, "应报出 missing-title");
		assert.ok(g.items[0].message.includes("文件名兜底"), "应说明兜底用的是什么");
	});

	it("没有该标记时不会误报 missing-title", () => {
		const r = setup([{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "" }]);
		assert.ok(!codes(r).includes("missing-title"), "字段缺失不该被推断成缺 title");
	});

	it("只出现一次的标签被报出", () => {
		const r = setup([{ id: "a", title: "A", tags: ["x", "only"], category: "C", content: "" }]);
		const g = r.groups.find((x) => x.code === "singleton-tag");
		assert.ok(g.items.some((i) => i.message.startsWith("only")));
	});

	it("大小写不一致的标签被报出且指向同一节点", () => {
		const r = setup([
			{ id: "a", title: "A", tags: ["PEFT", "x"], category: "C", content: "" },
			{ id: "b", title: "B", tags: ["peft", "x"], category: "C", content: "" },
		]);
		const g = r.groups.find((x) => x.code === "tag-case");
		assert.ok(g, "应报出 tag-case");
		assert.ok(g.items[0].message.includes("PEFT"));
		assert.ok(g.items[0].message.includes("peft"));
	});

	it("缺少 title 的文件被报出", () => {
		const r = setup([{ id: "a", title: "A", tags: ["x", "y"], category: "", content: "" }], {
			skipped: [{ file: "no-title.md", reason: "没有 title 字段" }],
		});
		const g = r.groups.find((x) => x.code === "missing-title");
		assert.deepEqual(
			g.items.map((i) => i.message),
			["no-title.md"],
		);
	});

	it("孤立节点被报出", () => {
		// 手工构造一个含孤立节点的图
		const posts = [{ id: "a", title: "A", tags: ["x", "y"], category: "", content: "" }];
		const graph = buildGraph(posts, { minTagCount: 2 });
		graph.nodes.push({ id: "tag:lonely", label: "lonely", type: "tag" });
		const r = runChecks({ posts, skipped: [], graph, minTagCount: 2 });
		const g = r.groups.find((x) => x.code === "orphan");
		assert.ok(g.items.some((i) => i.message.includes("lonely")));
	});

	it("自引用被报出", () => {
		const r = setup([{ id: "a", title: "A", tags: ["x", "y"], category: "", content: "[自己](./a.md)" }]);
		assert.ok(codes(r).includes("self-link"));
	});

	it("警告不影响 errors 计数", () => {
		const r = setup([{ id: "a", title: "A", tags: [], category: "", content: "" }]);
		assert.equal(r.errors, 0);
		assert.ok(r.warnings > 0);
	});
});

describe("formatReport", () => {
	it("无问题时给出明确结论", () => {
		const r = { groups: [], errors: 0, warnings: 0 };
		assert.ok(formatReport(r).includes("没有发现问题"));
	});

	it("错误用 ✗，警告用 ⚠", () => {
		const r = setup([{ id: "a", title: "A", tags: [], category: "", content: "[x](./gone.md)" }]);
		const text = formatReport(r);
		assert.ok(text.includes("✗"));
		assert.ok(text.includes("⚠"));
		assert.ok(text.includes("错误 1"));
	});

	it("明细超过上限时给出省略提示", () => {
		const posts = Array.from({ length: 12 }, (_, i) => ({
			id: `p${i}`,
			title: `P${i}`,
			tags: [],
			category: "",
			content: "",
		}));
		const text = formatReport(setup(posts), { maxPerGroup: 3 });
		assert.ok(text.includes("另有 9 项"));
	});
});
