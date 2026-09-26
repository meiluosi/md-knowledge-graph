/**
 * 基线机制测试。
 *
 * 最重要的一组是「指纹稳定性」：基线能不能用，全看 key 会不会因为
 * 无关变动而失效。如果加一篇无关文章就导致整份基线作废，
 * 那这个机制就等于没有。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	BASELINE_SCHEMA_VERSION,
	applyBaseline,
	buildBaseline,
	parseBaseline,
	serializeBaseline,
} from "../src/baseline.js";
import { runChecks, toJsonReport } from "../src/check.js";
import { buildGraph } from "../src/graph.js";

/** 造一份带问题的语料并跑检查 */
function scan(posts, options = {}) {
	const graph = buildGraph(posts, { minTagCount: 2, ...options });
	return runChecks({ posts, skipped: options.skipped ?? [], graph, minTagCount: 2 });
}

/** 一份有断链、有警告的语料 */
const BROKEN = [
	{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[没了](./gone.md)" },
	{ id: "b", title: "B", tags: [], category: "C", content: "" },
];

describe("buildBaseline", () => {
	it("记录全部问题，含错误与警告", () => {
		const result = scan(BROKEN);
		const baseline = buildBaseline(result, { generatedAt: "2026-01-01T00:00:00.000Z" });
		assert.equal(baseline.schemaVersion, BASELINE_SCHEMA_VERSION);
		assert.equal(baseline.count, result.errors + result.warnings);
		assert.equal(baseline.issues.length, baseline.count);
	});

	it("条目按 key 排序（保证文件内容稳定）", () => {
		const baseline = buildBaseline(scan(BROKEN));
		const keys = baseline.issues.map((i) => i.key);
		assert.deepEqual(keys, [...keys].sort());
	});

	it("每条都带 code / severity / message，便于人工 review", () => {
		const baseline = buildBaseline(scan(BROKEN));
		for (const issue of baseline.issues) {
			assert.ok(issue.code, "缺 code");
			assert.ok(["error", "warn"].includes(issue.severity), "severity 不合法");
			assert.ok(issue.message, "缺 message");
		}
	});

	it("记录生成时的工具版本", () => {
		const baseline = buildBaseline(scan(BROKEN), { version: "1.2.3" });
		assert.equal(baseline.generatedBy, "md-knowledge-graph@1.2.3");
	});
});

describe("serializeBaseline", () => {
	it("内容相同时输出完全一致（不产生无意义的 diff）", () => {
		const fixed = { generatedAt: "2026-01-01T00:00:00.000Z" };
		const p = serializeBaseline(buildBaseline(scan(BROKEN), fixed));
		const q = serializeBaseline(buildBaseline(scan(BROKEN), fixed));
		assert.equal(p, q);
	});

	it("以换行结尾", () => {
		assert.ok(serializeBaseline(buildBaseline(scan(BROKEN))).endsWith("\n"));
	});
});

describe("parseBaseline —— 格式错误必须报错，不能静默当空", () => {
	it("非法 JSON 报错", () => {
		assert.throws(() => parseBaseline("{ not json"), /不是合法 JSON/);
	});

	it("schemaVersion 不匹配报错", () => {
		assert.throws(
			() => parseBaseline(JSON.stringify({ schemaVersion: 99, issues: [] })),
			/schemaVersion 不匹配/,
		);
	});

	it("缺少 issues 报错", () => {
		assert.throws(
			() => parseBaseline(JSON.stringify({ schemaVersion: BASELINE_SCHEMA_VERSION })),
			/缺少 issues/,
		);
	});

	it("条目缺少 key 报错", () => {
		assert.throws(
			() =>
				parseBaseline(
					JSON.stringify({ schemaVersion: BASELINE_SCHEMA_VERSION, issues: [{ code: "x" }] }),
				),
			/缺少 key/,
		);
	});

	it("合法文件可解析", () => {
		const baseline = buildBaseline(scan(BROKEN));
		const parsed = parseBaseline(serializeBaseline(baseline));
		assert.equal(parsed.issues.length, baseline.issues.length);
	});
});

describe("applyBaseline —— 只留新增", () => {
	it("全部已知时没有新增，errors/warnings 归零", () => {
		const result = scan(BROKEN);
		const effective = applyBaseline(result, buildBaseline(result));
		assert.equal(effective.errors, 0);
		assert.equal(effective.warnings, 0);
		assert.equal(effective.knownTotal, result.errors + result.warnings);
		assert.deepEqual(effective.stale, []);
	});

	it("新增问题被保留，已知的被过滤", () => {
		const before = scan(BROKEN);
		const baseline = buildBaseline(before);

		const after = scan([...BROKEN, { id: "c", title: "C", tags: ["x", "y"], category: "C", content: "[坏](./nope.md)" }]);
		const effective = applyBaseline(after, baseline);

		assert.equal(effective.errors, 1, "只应剩下新增的那一条断链");
		assert.equal(effective.groups.length, 1);
		assert.ok(effective.groups[0].items[0].message.includes("nope.md"));
		assert.equal(effective.groups[0].knownCount, 1, "同组里原有那一条应记为已知");
	});

	it("修好的旧问题进入 stale", () => {
		const before = scan(BROKEN);
		const baseline = buildBaseline(before);

		// 修掉那条断链
		const fixed = [{ ...BROKEN[0], content: "" }, BROKEN[1]];
		const effective = applyBaseline(scan(fixed), baseline);

		assert.ok(
			effective.stale.some((s) => s.key.startsWith("broken-link|")),
			"修好的断链应出现在 stale 里",
		);
	});

	it("没有基线时原样返回", () => {
		const result = scan(BROKEN);
		const effective = applyBaseline(result, null);
		assert.equal(effective.errors, result.errors);
		assert.equal(effective.knownTotal, 0);
	});

	it("key 不在基线里但同组的其它 key 在 —— 只过滤匹配的那些", () => {
		const before = scan(BROKEN);
		const baseline = buildBaseline(before);
		// 人为插入一个不在基线里的 key
		const tampered = {
			groups: [
				{
					...before.groups.find((g) => g.code === "broken-link"),
					items: [
						...before.groups.find((g) => g.code === "broken-link").items,
						{ key: "broken-link|zzz|./new.md", message: "新问题" },
					],
				},
			],
			errors: 2,
			warnings: 0,
		};
		const effective = applyBaseline(tampered, baseline);
		assert.equal(effective.errors, 1);
		assert.equal(effective.groups[0].items[0].key, "broken-link|zzz|./new.md");
	});
});

describe("指纹稳定性 —— 基线到底能不能用，全看这个", () => {
	// 用一份标签已达阈值的语料，这样插入新文章不会改变标签计数，
	// 能把「指纹是否稳定」和「问题本身是否消失」两件事分开测。
	const STABLE = [
		{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[没了](./gone.md)" },
		{ id: "b", title: "B", tags: ["x", "y"], category: "C", content: "" },
	];

	it("插入一篇无关文章后，原有问题仍是「已知」而不是「新增」", () => {
		const before = scan(STABLE);
		const baseline = buildBaseline(before);

		// 在最前面插一篇无关文章：会改变顺序、id 集合，但不应改变已有问题的指纹
		const after = scan([
			{ id: "aaa-new", title: "新写的", tags: ["x", "y"], category: "C", content: "" },
			...STABLE,
		]);

		const effective = applyBaseline(after, baseline);
		assert.equal(effective.errors, 0, "无关新增不应让原有断链变成「新增」");
		assert.equal(effective.warnings, 0);
		assert.equal(effective.knownTotal, before.errors + before.warnings);
		assert.deepEqual(effective.stale, [], "原有问题都还在，不应有 stale");
	});

	it("计数型问题（长尾标签）会随语料变化而消失，这是语义正确的", () => {
		// 单篇时 x 只出现一次 → singleton 警告
		const single = scan([{ id: "a", title: "A", tags: ["x"], category: "", content: "" }]);
		const baseline = buildBaseline(single);
		// 再来一篇也带 x → x 出现两次 → 警告应当消失，进入 stale 而非「新增」
		const doubled = scan([
			{ id: "a", title: "A", tags: ["x"], category: "", content: "" },
			{ id: "b", title: "B", tags: ["x"], category: "", content: "" },
		]);
		const effective = applyBaseline(doubled, baseline);
		assert.equal(effective.errors, 0);
		assert.equal(effective.warnings, 0);
		assert.ok(effective.stale.some((s) => s.key === "singleton-tag|x"));
	});

	it("标签 label 的大小写被多数决改写时，singleton-tag 的 key 不变", () => {
		const a = scan([{ id: "a", title: "A", tags: ["PEFT"], category: "", content: "" }]);
		const b = scan([
			{ id: "a", title: "A", tags: ["PEFT"], category: "", content: "" },
			{ id: "b", title: "B", tags: ["PEFT"], category: "", content: "" },
			{ id: "c", title: "C", tags: ["PEFT"], category: "", content: "" },
			{ id: "d", title: "D", tags: ["peft"], category: "", content: "" },
		]);

		const keyA = a.groups.find((g) => g.code === "singleton-tag").items[0].key;
		const groupB = b.groups.find((g) => g.code === "singleton-tag");
		// b 里 PEFT 出现 3 次 + peft 1 次 = 4，已不低于阈值，所以 singleton 里不该再有它
		assert.ok(!groupB || !groupB.items.some((i) => i.key === keyA));
		// 而 a 里的 key 用的是 slug，不是 label
		assert.equal(keyA, "singleton-tag|peft");
	});

	it("改措辞不影响 key（key 不含 message 文本）", () => {
		const baseline = buildBaseline(scan(BROKEN));
		for (const issue of baseline.issues) {
			assert.ok(!issue.key.includes(" "), `key 里不该有空格/句子：${issue.key}`);
			assert.notEqual(issue.key, issue.message);
		}
	});
});

describe("toJsonReport —— agent 可消费的契约", () => {
	it("带 schemaVersion 与 summary", () => {
		const report = toJsonReport(scan(BROKEN));
		assert.equal(report.schemaVersion, 1);
		assert.equal(typeof report.summary.errors, "number");
		assert.equal(typeof report.summary.warnings, "number");
		assert.equal(typeof report.summary.knownIgnored, "number");
	});

	it("条目保留结构化字段，不必正则解析", () => {
		const report = toJsonReport(scan(BROKEN));
		const group = report.groups.find((g) => g.code === "broken-link");
		const item = group.items[0];
		assert.equal(item.from, "a");
		assert.equal(item.target, "./gone.md");
		assert.equal(item.kind, "markdown");
		assert.ok(item.key);
	});

	it("应用基线后 knownIgnored 与 stale 反映在报告里", () => {
		const result = scan(BROKEN);
		const effective = applyBaseline(result, buildBaseline(result));
		const report = toJsonReport(effective, { baseline: { path: "/x/.mdkg-baseline.json" } });
		assert.equal(report.summary.knownIgnored, result.errors + result.warnings);
		assert.equal(report.baseline.path, "/x/.mdkg-baseline.json");
		assert.deepEqual(report.groups, []);
	});

	it("整个报告可 JSON 序列化", () => {
		const report = toJsonReport(scan(BROKEN));
		assert.doesNotThrow(() => JSON.stringify(report));
	});
});
