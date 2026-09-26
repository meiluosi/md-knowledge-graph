/**
 * action 转接器测试。
 *
 * scripts/action-report.mjs 是 action.yml 依赖的交付物。
 * 它坏了不会让任何单元测试变红——只会在使用者自己的 CI 里炸。
 * 所以它也得被真正跑起来测。
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join(ROOT, "scripts", "action-report.mjs");
const CLI = path.join(ROOT, "src", "cli.js");
const EXAMPLES = path.join(ROOT, "examples");

async function tmpFile(name, content = "") {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-adapter-"));
	const file = path.join(dir, name);
	await fs.writeFile(file, content, "utf8");
	return file;
}

/**
 * 跑转接器，返回 {code, stdout, stderr, githubOutput}。
 * 不抛错——退出码自己判。
 * @param {string} reportPath
 */
async function adapter(reportPath) {
	const outputFile = await tmpFile("github-output.txt");
	try {
		const { stdout, stderr } = await run(process.execPath, [ADAPTER, reportPath], {
			env: { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: "" },
		});
		return { code: 0, stdout, stderr, githubOutput: await fs.readFile(outputFile, "utf8") };
	} catch (err) {
		const e = /** @type {any} */ (err);
		return {
			code: e.code ?? 1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			githubOutput: await fs.readFile(outputFile, "utf8"),
		};
	}
}

/** 用 CLI 生成一份 JSON 检查报告，返回文件路径 */
async function makeReport(extraArgs = []) {
	const res = spawnSync(
		process.execPath,
		[CLI, "--posts", EXAMPLES, "--check", "--format", "json", ...extraArgs],
		{ cwd: ROOT, encoding: "utf8" },
	);
	assert.ok(res.stdout, `CLI 未产出报告：${res.stderr}`);
	return tmpFile("report.json", res.stdout);
}

/** 生成一份基线文件，返回路径 */
async function makeBaseline() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdkg-bl-"));
	const file = path.join(dir, "baseline.json");
	const res = spawnSync(process.execPath, [CLI, "--posts", EXAMPLES, "--update-baseline", file], {
		cwd: ROOT,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `生成基线失败：${res.stderr}`);
	return file;
}

describe("scripts/action-report.mjs", () => {
	it("把 JSON 报告转成 GitHub 注解", async () => {
		const r = await adapter(await makeReport());
		assert.equal(r.code, 0);
		assert.ok(r.stdout.includes("::error "), "应输出 error 注解");
		assert.ok(r.stdout.includes("::warning "), "应输出 warning 注解");
	});

	it("写 GITHUB_OUTPUT 供后续步骤使用", async () => {
		const r = await adapter(await makeReport());
		assert.match(r.githubOutput, /errors=5/);
		assert.match(r.githubOutput, /warnings=6/);
		assert.match(r.githubOutput, /known=0/);
	});

	it("应用基线后 errors/warnings 归零、known 反映忽略数", async () => {
		const baseline = await makeBaseline();
		const reportPath = await makeReport(["--baseline", baseline]);
		const r = await adapter(reportPath);

		assert.match(r.githubOutput, /errors=0/);
		assert.match(r.githubOutput, /warnings=0/);
		assert.match(r.githubOutput, /known=11/);
		assert.ok(!r.stdout.includes("::error"), "已知问题不该出现在注解里");
	});

	it("报告文件不存在时报错退出 2", async () => {
		const r = await adapter("/tmp/definitely-not-a-report.json");
		assert.equal(r.code, 2);
		assert.ok(r.stderr.includes("无法读取检查报告"));
	});

	it("报告不是合法 JSON 时报错退出 2", async () => {
		const bad = await tmpFile("bad.json", "{ nope");
		const r = await adapter(bad);
		assert.equal(r.code, 2);
		assert.ok(r.stderr.includes("无法读取检查报告"));
	});
});
