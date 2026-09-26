/**
 * GitHub 注解格式的测试。
 *
 * 转义是这里最容易悄悄出错的地方：漏掉属性值里的 `:` 或 `,`，
 * 注解会被从错误的位置切开，于是**报到一个错误的文件上**——
 * 那比不报还糟，因为它让人去改一个没问题的文件。
 */

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { applyBaseline, buildBaseline } from "../src/baseline.js";
import { formatGithubAnnotations, runChecks } from "../src/check.js";
import { buildGraph } from "../src/graph.js";

const CWD = "/repo";

/** 造一份语料并跑检查 */
function scan(posts, options = {}) {
	// 默认按"作者在用 frontmatter"处理，与 check.test.js 保持一致
	const withFm = posts.map((p) => ({ hasFrontmatter: true, ...p }));
	const graph = buildGraph(withFm, { minTagCount: 2, ...options.graph });
	return runChecks({ posts: withFm, skipped: options.skipped ?? [], graph, minTagCount: 2 });
}

/** 一行注解拆成 {props, text} */
function parseLine(line) {
	const m = line.match(/^::(error|warning|notice)(?: (.*?))?::(.*)$/);
	if (!m) return null;
	const [, kind, rawProps, text] = m;
	const props = {};
	if (rawProps) {
		for (const pair of rawProps.split(",")) {
			const idx = pair.indexOf("=");
			if (idx > 0) props[pair.slice(0, idx)] = pair.slice(idx + 1);
		}
	}
	return { kind, props, text };
}

describe("formatGithubAnnotations —— 基本形态", () => {
	it("错误用 ::error，警告用 ::warning", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/content/a.md" },
		]);
		const lines = formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n");
		assert.ok(lines.some((l) => l.startsWith("::error ")), "应有 error 注解");
		assert.ok(lines.some((l) => l.startsWith("::warning ")), "应有 warning 注解");
	});

	it("每条问题一行注解，末尾附一行人读汇总", () => {
		const result = scan([
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[没了](./gone.md)", file: "/repo/content/a.md" },
		]);
		const lines = formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n");
		const annotations = lines.filter((l) => l.startsWith("::"));
		const summary = lines.filter((l) => !l.startsWith("::"));
		assert.equal(annotations.length, result.errors + result.warnings);
		assert.equal(summary.length, 1);
		assert.ok(summary[0].includes("错误 1"));
	});

	it("没有问题时不产生注解，只有汇总", () => {
		const result = scan([
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[B](./b.md)", file: "/repo/b/a.md" },
			{ id: "b", title: "B", tags: ["x", "y"], category: "C", content: "[A](./a.md)", file: "/repo/b/b.md" },
		]);
		const out = formatGithubAnnotations(result, { cwd: CWD });
		assert.ok(!out.includes("::error"));
		assert.ok(out.includes("✓ 没有新增问题"));
	});
});

describe("formatGithubAnnotations —— 文件定位", () => {
	it("把绝对路径转成仓库相对路径", () => {
		const result = scan([
			{ id: "content/a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/content/a.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD })
			.trim()
			.split("\n")
			.find((l) => l.startsWith("::error"));
		assert.equal(parseLine(line).props.file, "content/a.md");
	});

	it("路径在仓库外时省略 file 属性（宁可不定位，也不乱指）", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/elsewhere/a.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD })
			.trim()
			.split("\n")
			.find((l) => l.startsWith("::error"));
		assert.equal(parseLine(line).props.file, undefined);
		assert.ok(parseLine(line).props.title, "title 仍应在");
	});

	it("没有文件信息的条目（如长尾标签）只带 title", () => {
		const result = scan([
			{ id: "a", title: "A", tags: ["only"], category: "C", content: "", file: "/repo/a.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD })
			.trim()
			.split("\n")
			.find((l) => l.startsWith("::warning"));
		const parsed = parseLine(line);
		assert.equal(parsed.props.file, undefined);
		assert.ok(parsed.props.title);
	});
});

describe("formatGithubAnnotations —— 转义（漏了就报到错误的文件上）", () => {
	it("属性值里的冒号转成 %3A", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/we:ird/a.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n")[0];
		assert.ok(line.includes("file=we%3Aird/a.md"), `冒号未转义：${line}`);
		assert.ok(!line.includes("file=we:ird"), "原始冒号会切错属性");
	});

	it("属性值里的逗号转成 %2C", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/a,b/c.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n")[0];
		assert.ok(line.includes("file=a%2Cb/c.md"), `逗号未转义：${line}`);
	});

	it("属性值里的百分号先被转义（避免二次解码）", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/100%/a.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n")[0];
		assert.ok(line.includes("file=100%25/a.md"), `百分号未转义：${line}`);
	});

	it("中文标题不需要转义，可原样出现", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/a.md" },
		]);
		const line = formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n")[0];
		const parsed = parseLine(line);
		assert.equal(parsed.props.title, "正文断链（目标文件不存在）");
	});

	it("消息里的换行被转义，不会把一条注解断成两条", () => {
		// 直接构造一个带换行的条目
		const result = {
			groups: [
				{
					code: "x",
					severity: "error",
					title: "T",
					items: [{ key: "k", message: "第一行\n第二行", file: "/repo/a.md" }],
				},
			],
			errors: 1,
			warnings: 0,
		};
		const out = formatGithubAnnotations(result, { cwd: CWD });
		const annotationLines = out.trim().split("\n").filter((l) => l.startsWith("::"));
		assert.equal(annotationLines.length, 1, "换行没有被转义");
		assert.ok(annotationLines[0].includes("第一行%0A第二行"));
	});

	it("属性分隔符不会被标题里的中文括号影响", () => {
		const result = scan([
			{ id: "a", title: "A", tags: [], category: "C", content: "[没了](./gone.md)", file: "/repo/a.md" },
		]);
		const parsed = parseLine(formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n")[0]);
		assert.ok(parsed, "注解应能被解析");
		assert.equal(parsed.kind, "error");
	});
});

describe("formatGithubAnnotations —— 与基线配合", () => {
	it("应用基线后只剩汇总行与已修复提示", () => {
		const posts = [
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[没了](./gone.md)", file: "/repo/a.md" },
		];
		const result = scan(posts);
		const total = result.errors + result.warnings;
		const effective = applyBaseline(result, buildBaseline(result));
		const out = formatGithubAnnotations(effective, { cwd: CWD });
		assert.ok(!out.includes("::error"), "已知问题不该再出现在注解里");
		assert.ok(out.includes("✓ 没有新增问题"));
		assert.ok(out.includes(`已知 ${total} 项已忽略`), `应说明忽略了 ${total} 项：\n${out}`);
	});

	it("已修复的基线项输出 ::notice", () => {
		const before = scan([
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[没了](./gone.md)", file: "/repo/a.md" },
		]);
		const baseline = buildBaseline(before);
		const after = scan([
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "", file: "/repo/a.md" },
		]);
		const out = formatGithubAnnotations(applyBaseline(after, baseline), { cwd: CWD });
		assert.ok(out.includes("::notice::"), "应提示可以清理基线");
		assert.ok(out.includes("broken-link|a|./gone.md"));
	});

	it("新增问题仍然报出来", () => {
		const before = scan([
			{ id: "a", title: "A", tags: ["x", "y"], category: "C", content: "[没了](./gone.md)", file: "/repo/a.md" },
		]);
		const baseline = buildBaseline(before);
		// 同一篇文章里再引入一条新的断链
		const after = scan([
			{
				id: "a",
				title: "A",
				tags: ["x", "y"],
				category: "C",
				content: "[没了](./gone.md)\n[新的](./new.md)",
				file: "/repo/a.md",
			},
		]);
		const out = formatGithubAnnotations(applyBaseline(after, baseline), { cwd: CWD });
		assert.ok(out.includes("new.md"), "新增问题应被报出");
		assert.ok(!out.includes("gone.md"), "已知问题不该被报出");
	});
});

describe("formatGithubAnnotations —— 路径解析", () => {
	it("相对路径原样使用", () => {
		const result = {
			groups: [
				{ code: "x", severity: "error", title: "T", items: [{ key: "k", message: "m", file: "content/a.md" }] },
			],
			errors: 1,
			warnings: 0,
		};
		const parsed = parseLine(formatGithubAnnotations(result, { cwd: CWD }).trim().split("\n")[0]);
		assert.equal(parsed.props.file, "content/a.md");
	});

	it("不传 cwd 时用当前进程目录", () => {
		const result = {
			groups: [
				{
					code: "x",
					severity: "error",
					title: "T",
					items: [{ key: "k", message: "m", file: path.join(process.cwd(), "x.md") }],
				},
			],
			errors: 1,
			warnings: 0,
		};
		const parsed = parseLine(formatGithubAnnotations(result).trim().split("\n")[0]);
		assert.equal(parsed.props.file, "x.md");
	});
});
