/**
 * 相关文章打分的测试。
 *
 * 打分数值是下游会直接消费的契约，所以这里把权重也断言下来：
 * 改动权重会让测试红，迫使改动者意识到这是对外行为。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeRelated } from "../src/related.js";

const posts = [
	{ id: "a", title: "A", tags: ["x", "y"], category: "C" },
	{ id: "b", title: "B", tags: ["x"], category: "C" },
	{ id: "c", title: "C", tags: ["z"], category: "" },
	{ id: "d", title: "D", tags: [], category: "" },
];

const rel = (result, id) => result.posts.find((p) => p.id === id);

describe("computeRelated", () => {
	it("共享标签会加分（每个差集标签 +2）", () => {
		const r = computeRelated(posts, { linkEdges: [] });
		const b = rel(r, "a").related.find((x) => x.id === "b");
		assert.equal(b.score, 2 + 1); // tag:x(2) + category:C(1)
		assert.ok(b.reasons.includes("tag:x"));
	});

	it("正文引用权重最高", () => {
		const withLink = computeRelated(posts, { linkEdges: [{ from: "a", to: "c" }] });
		const c = rel(withLink, "a").related.find((x) => x.id === "c");
		assert.ok(c.reasons.includes("link"));
		assert.ok(c.score >= 3);
	});

	it("反向引用被标为 backlink", () => {
		const r = computeRelated(posts, { linkEdges: [{ from: "c", to: "a" }] });
		const c = rel(r, "a").related.find((x) => x.id === "c");
		assert.ok(c.reasons.includes("backlink"));
	});

	it("互相引用会累加出更高分", () => {
		const both = [{ from: "a", to: "c" }, { from: "c", to: "a" }];
		const r = computeRelated(posts, { linkEdges: both });
		const c = rel(r, "a").related.find((x) => x.id === "c");
		assert.ok(c.reasons.includes("link") && c.reasons.includes("backlink"));
		assert.equal(c.score, 6);
	});

	it("不同分类不会因分类加分", () => {
		const r = computeRelated(posts, { linkEdges: [] });
		const c = rel(r, "a").related.find((x) => x.id === "c");
		assert.equal(c, undefined, "a 与 c 无共享标签/分类，不应出现");
	});

	it("top 限制生效", () => {
		const many = Array.from({ length: 10 }, (_, i) => ({
			id: `p${i}`,
			title: `P${i}`,
			tags: ["shared"],
			category: "",
		}));
		const r = computeRelated(many, { linkEdges: [] }, { top: 3 });
		assert.equal(rel(r, "p0").related.length, 3);
	});

	it("minScore 生效（阈值是闭区间，等于阈值的保留）", () => {
		// a↔b 的分数：共享 tag:x (+2) + 同分类 (+1) = 3
		const at3 = computeRelated(posts, { linkEdges: [] }, { minScore: 3 });
		assert.equal(rel(at3, "a").related.length, 1, "分数 3 应被保留");

		const at4 = computeRelated(posts, { linkEdges: [] }, { minScore: 4 });
		assert.equal(rel(at4, "a").related.length, 0, "阈值 4 时分数 3 应被过滤");
	});

	it("结果按分数降序，同分按 id 升序（确定性）", () => {
		const tied = [
			{ id: "a", title: "A", tags: ["shared"], category: "" },
			{ id: "z", title: "Z", tags: ["shared"], category: "" },
			{ id: "m", title: "M", tags: ["shared"], category: "" },
		];
		const r = computeRelated(tied, { linkEdges: [] });
		assert.deepEqual(
			rel(r, "a").related.map((x) => x.id),
			["m", "z"],
		);
	});

	it("不把自己列为相关", () => {
		const r = computeRelated(posts, { linkEdges: [{ from: "a", to: "a" }] });
		assert.ok(!rel(r, "a").related.some((x) => x.id === "a"));
	});

	it("带 schemaVersion，供下游判断契约", () => {
		assert.equal(computeRelated(posts, { linkEdges: [] }).schemaVersion, 1);
	});

	it("引用指向不存在的文章时被忽略", () => {
		const r = computeRelated(posts, { linkEdges: [{ from: "a", to: "ghost" }] });
		assert.ok(!rel(r, "a").related.some((x) => x.id === "ghost"));
	});
});
