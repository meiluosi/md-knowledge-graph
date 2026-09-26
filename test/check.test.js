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
	const graph = buildGraph(posts, { minTagCount: 2, ...options });
	return runChecks({ posts, skipped: options.skipped ?? [], graph, minTagCount: 2 });
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
