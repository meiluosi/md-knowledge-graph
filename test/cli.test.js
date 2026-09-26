/**
 * CLI 端到端测试：真的把命令跑起来，断言 stdout / stderr / 退出码。
 *
 * 为什么值得单开一层：退出码是 CI 唯一真正依赖的契约。
 * 单元测试全绿但退出码错了，CI 依然是坏的。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

/**
 * 执行 CLI，返回 {code, stdout, stderr}。不抛错，退出码自己判。
 * @param {string[]} args
 */
async function mdkg(args) {
	try {
		const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
		return { code: 0, stdout, stderr };
	} catch (err) {
		return {
			code: /** @type {any} */ (err).code ?? 1,
			stdout: /** @type {any} */ (err).stdout ?? "",
			stderr: /** @type {any} */ (err).stderr ?? "",
		};
	}
}

/** 造一份临时语料 */
async function corpus(files) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-cli-"));
	for (const [name, body] of Object.entries(files)) {
		await fs.writeFile(path.join(dir, name), body, "utf8");
	}
	return dir;
}

const CLEAN = {
	"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n见 [B](./b.md)\n",
	"b.md": "---\ntitle: B\ntags: [x, y]\ncategory: C\n---\n见 [A](./a.md)\n",
};

describe("mdkg --check 的退出码", () => {
	it("干净语料 → 0，且报告无问题", async () => {
		const dir = await corpus(CLEAN);
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("没有发现问题"));
	});

	it("有断链 → 1，且报告里点名该链接", async () => {
		const dir = await corpus({ ...CLEAN, "c.md": "---\ntitle: C\ntags: [x, y]\n---\n[没了](./gone.md)\n" });
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("正文断链"));
		assert.ok(r.stdout.includes("gone.md"));
	});

	it("只有警告 → 0", async () => {
		const dir = await corpus({
			"a.md": "---\ntitle: A\ntags: []\ncategory: C\n---\n见 [B](./b.md)\n",
			"b.md": "---\ntitle: B\ntags: [x]\ncategory: C\n---\n见 [A](./a.md)\n",
		});
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("无标签"));
	});

	it("只有警告 + --strict → 1", async () => {
		const dir = await corpus({
			"a.md": "---\ntitle: A\ntags: []\ncategory: C\n---\n见 [B](./b.md)\n",
			"b.md": "---\ntitle: B\ntags: [x]\ncategory: C\n---\n见 [A](./a.md)\n",
		});
		const r = await mdkg(["--posts", dir, "--check", "--strict"]);
		assert.equal(r.code, 1);
	});

	it("--strict 不配 --check 时报错", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--strict"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("--strict 需要与 --check"));
	});

	it("示例语料含故意缺陷，因此 --check 应当失败（这本身是特性验证）", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check"]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("正文断链"));
		assert.ok(r.stdout.includes("写法不一致"));
	});
});

describe("mdkg 的其它行为", () => {
	it("--help 退出 0 并打印用法", async () => {
		const r = await mdkg(["--help"]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("mdkg"));
		assert.ok(r.stdout.includes("--check"));
	});

	it("未知 --format 报错退出 1", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--format", "nope"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("不支持的 --format"));
	});

	it("语料目录不存在时报错退出 1", async () => {
		const r = await mdkg(["--posts", "/definitely/not/here"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("语料目录不存在"));
	});

	it("mermaid 输出里引用边用虚线", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--format", "mermaid"]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.startsWith("graph LR"));
		assert.ok(r.stdout.includes("-.->"), "post↔post 引用边应为虚线");
		assert.ok(r.stdout.includes("-->"), "归属边应为实线");
	});

	it("--no-link-edges 产出的 mermaid 不含虚线", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--format", "mermaid", "--no-link-edges"]);
		assert.equal(r.code, 0);
		assert.ok(!r.stdout.includes("-.->"));
	});

	it("related 输出是带 schemaVersion 的合法 JSON", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--format", "related"]);
		assert.equal(r.code, 0);
		const data = JSON.parse(r.stdout);
		assert.equal(data.schemaVersion, 1);
		assert.ok(Array.isArray(data.posts));
		assert.ok(data.posts.every((p) => Array.isArray(p.related)));
	});

	it("related 的 top 参数生效", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--format", "related", "--related-top", "1"]);
		const data = JSON.parse(r.stdout);
		assert.ok(data.posts.every((p) => p.related.length <= 1));
	});

	it("有断链时在 stderr 给出提示但不失败", async () => {
		const dir = await corpus({ ...CLEAN, "c.md": "---\ntitle: C\ntags: [x, y]\n---\n[没了](./gone.md)\n" });
		const r = await mdkg(["--posts", dir]);
		assert.equal(r.code, 0, "出图模式不因断链失败");
		assert.ok(r.stderr.includes("断链"));
	});
});

describe("mdkg 的锚点校验", () => {
	const WITH_ANCHORS = {
		"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n## First\n\n[B 的第二节](./b.md#second)\n",
		"b.md": "---\ntitle: B\ntags: [x, y]\ncategory: C\n---\n## Second\n\n回到 [A](./a.md)\n",
	};

	it("有效锚点不报错、退出 0", async () => {
		const dir = await corpus(WITH_ANCHORS);
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.equal(r.code, 0);
		assert.ok(!r.stdout.includes("失效锚点"));
	});

	it("失效锚点报错、退出 1，且点名该锚点", async () => {
		const dir = await corpus({
			...WITH_ANCHORS,
			"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n## First\n\n[B 的旧章节](./b.md#renamed)\n",
		});
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("失效锚点"));
		assert.ok(r.stdout.includes("renamed"));
	});

	it("同文件失效锚点也被报出", async () => {
		const dir = await corpus({
			"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n## First\n\n[回不去](#ghost)\n",
		});
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("本文"));
	});

	it("--no-anchor-check 关闭锚点校验", async () => {
		const dir = await corpus({
			...WITH_ANCHORS,
			"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n## First\n\n[B 的旧章节](./b.md#renamed)\n",
		});
		const r = await mdkg(["--posts", dir, "--check", "--no-anchor-check"]);
		assert.equal(r.code, 0);
		assert.ok(!r.stdout.includes("失效锚点"));
	});

	it("示例语料报出 2 个失效锚点（故意植入）", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check"]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("flash-attention"));
		assert.ok(r.stdout.includes("不存在的小节"));
	});

	it("示例语料报出本地路径与缺失图片", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check"]);
		assert.ok(r.stdout.includes("本地文件系统路径"));
		assert.ok(r.stdout.includes("shot.png"));
		assert.ok(r.stdout.includes("图片文件不存在"));
		assert.ok(r.stdout.includes("missing-diagram.png"));
	});

	it("本地路径带正确的行列号", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check", "--format", "json"]);
		const report = JSON.parse(r.stdout);
		const group = report.groups.find((g) => g.code === "local-file-path");
		assert.ok(group, "应有 local-file-path 组");
		assert.equal(group.items[0].line, 24);
		assert.ok(Number.isInteger(group.items[0].column));
	});

	it("代码块里的假锚点不会被误报", async () => {
		const dir = await corpus({
			"a.md":
				"---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n## First\n\n```\n[假](#fake)\n```\n",
		});
		const r = await mdkg(["--posts", dir, "--check"]);
		assert.ok(!r.stdout.includes("fake"), "代码块里的假锚点被误报");
	});
});

describe("mdkg 的基线机制", () => {
	/** 造一个有问题的语料 + 一个临时目录用来放基线文件 */
	async function fixture() {
		const dir = await corpus({
			"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n[没了](./gone.md)\n",
			"b.md": "---\ntitle: B\ntags: [x, y]\ncategory: C\n---\n[好](./a.md)\n",
		});
		const work = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-bl-"));
		return { dir, baseline: path.join(work, "baseline.json"), work };
	}

	it("--update-baseline 写出文件并退出 0", async () => {
		const { dir, baseline } = await fixture();
		const r = await mdkg(["--posts", dir, "--update-baseline", baseline]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("已写入基线"));

		const written = JSON.parse(await fs.readFile(baseline, "utf8"));
		assert.equal(written.schemaVersion, 1);
		assert.equal(written.count, 1, "只有一条断链");
	});

	it("全部问题都已记录时，--check --baseline 退出 0", async () => {
		const { dir, baseline } = await fixture();
		await mdkg(["--posts", dir, "--update-baseline", baseline]);
		const r = await mdkg(["--posts", dir, "--check", "--baseline", baseline]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("没有新增问题"));
	});

	it("出现新问题时退出 1，且只报新增的那条", async () => {
		const { dir, baseline } = await fixture();
		await mdkg(["--posts", dir, "--update-baseline", baseline]);
		await fs.writeFile(
			path.join(dir, "c.md"),
			"---\ntitle: C\ntags: [x, y]\ncategory: C\n---\n[又坏了](./nope.md)\n",
			"utf8",
		);
		const r = await mdkg(["--posts", dir, "--check", "--baseline", baseline]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("nope.md"), "应报出新问题");
		assert.ok(!r.stdout.includes("gone.md"), "旧的已知问题不该出现在新增里");
		assert.ok(r.stdout.includes("已忽略"), "应说明有已知项被忽略");
	});

	it("基线文件不存在时只是提示，不失败", async () => {
		const { dir } = await fixture();
		const r = await mdkg(["--posts", dir, "--check", "--baseline", "/tmp/definitely-missing-bl.json"]);
		assert.equal(r.code, 1, "仍按无基线判定（有错误）");
		assert.ok(r.stderr.includes("不存在"));
	});

	it("基线文件格式错误时报错退出 1", async () => {
		const { dir, baseline } = await fixture();
		await fs.writeFile(baseline, "{ not json", "utf8");
		const r = await mdkg(["--posts", dir, "--check", "--baseline", baseline]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("不是合法 JSON"));
	});

	it("--baseline 不配 --check 时报错", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--baseline", "/tmp/x.json"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("--baseline 需要与 --check"));
	});

	it("--baseline 与 --update-baseline 互斥", async () => {
		const r = await mdkg([
			"--posts", EXAMPLES, "--check", "--baseline", "/tmp/x.json", "--update-baseline", "/tmp/y.json",
		]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("只读"));
	});

	it("--update-baseline 与 --prune-baseline 互斥（危险程度不同）", async () => {
		const r = await mdkg([
			"--posts", EXAMPLES, "--update-baseline", "/tmp/x.json", "--prune-baseline", "/tmp/y.json",
		]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("不能同时使用"));
		assert.ok(r.stderr.includes("--update-baseline"), "错误信息应说明两者的区别");
	});

	it("--prune-baseline 在文件不存在时报错（它只删不建）", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--prune-baseline", "/tmp/no-such-baseline.json"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("不存在"));
		assert.ok(r.stderr.includes("--update-baseline"), "应提示用 update 创建");
	});
});

describe("mdkg 的基线清理（--prune-baseline）", () => {
	async function fixture() {
		const dir = await corpus({
			"a.md": "---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n[没了](./gone.md)\n",
			"b.md": "---\ntitle: B\ntags: [x, y]\ncategory: C\n---\n[好](./a.md)\n",
		});
		const work = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-prune-"));
		const baseline = path.join(work, "baseline.json");
		await mdkg(["--posts", dir, "--update-baseline", baseline]);
		return { dir, baseline };
	}

	it("无变化时不改动文件", async () => {
		const { dir, baseline } = await fixture();
		const before = await fs.readFile(baseline, "utf8");
		const r = await mdkg(["--posts", dir, "--prune-baseline", baseline]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("基线无变化"));
		assert.equal(await fs.readFile(baseline, "utf8"), before);
	});

	it("修好后清理，并列出被移除的条目", async () => {
		const { dir, baseline } = await fixture();
		await fs.writeFile(
			path.join(dir, "a.md"),
			"---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n链接已修好\n",
			"utf8",
		);
		const r = await mdkg(["--posts", dir, "--prune-baseline", baseline]);
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("移除 1 项"));
		assert.ok(r.stdout.includes("未添加任何新问题"));
		assert.ok(r.stdout.includes("broken-link|a|./gone.md"));

		const written = JSON.parse(await fs.readFile(baseline, "utf8"));
		assert.equal(written.count, 0);
	});

	it("清理后新问题仍然会被 --check 报出", async () => {
		const { dir, baseline } = await fixture();
		await fs.writeFile(
			path.join(dir, "a.md"),
			"---\ntitle: A\ntags: [x, y]\ncategory: C\n---\n链接已修好\n",
			"utf8",
		);
		await mdkg(["--posts", dir, "--prune-baseline", baseline]);

		await fs.writeFile(
			path.join(dir, "c.md"),
			"---\ntitle: C\ntags: [x, y]\ncategory: C\n---\n[新的坏链](./nope.md)\n",
			"utf8",
		);
		const r = await mdkg(["--posts", dir, "--check", "--baseline", baseline]);
		assert.equal(r.code, 1);
		assert.ok(r.stdout.includes("nope.md"));
	});
});

describe("mdkg 的结构化检查报告", () => {
	it("--check --format json 输出合法 JSON 且带 schemaVersion", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check", "--format", "json"]);
		assert.equal(r.code, 1, "示例语料有错误");
		const report = JSON.parse(r.stdout);
		assert.equal(report.schemaVersion, 1);
		assert.equal(typeof report.summary.errors, "number");
		assert.ok(Array.isArray(report.groups));
	});

	it("JSON 条目是结构化的，不需要正则解析", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check", "--format", "json"]);
		const report = JSON.parse(r.stdout);
		const anchor = report.groups.find((g) => g.code === "broken-anchor");
		assert.ok(anchor, "应有 broken-anchor 组");
		const item = anchor.items[0];
		assert.ok(item.key && item.from && item.anchor);
		assert.equal(typeof item.sameFile, "boolean");
	});

	it("检查模式不接受出图用的 format", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check", "--format", "mermaid"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("检查模式不支持"));
	});

	it("检查模式默认 text（不传 --format）", async () => {
		const r = await mdkg(["--posts", EXAMPLES, "--check"]);
		assert.ok(r.stdout.includes("检查报告"), "默认应是文本报告");
		assert.throws(() => JSON.parse(r.stdout), "默认输出不是 JSON");
	});
});
