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
