#!/usr/bin/env node
/**
 * GitHub Action 的报告转接器。
 *
 * 输入：`--check --format json` 产出的报告文件
 * 输出：① stdout 上的 GitHub 注解  ② $GITHUB_OUTPUT 里的计数
 *
 * 为什么单独有这么一层：action 里不该重新实现一遍转义规则。
 * 转接器直接复用 `src/check.js` 的 formatGithubAnnotations，
 * 保证「CLI 里看到的注解」和「action 里发出的注解」永远一致。
 *
 * 只跑一次 CLI —— 注解与计数都来自同一份 JSON 报告，
 * 不会出现两次运行结果不一致的情况。
 */

import fs from "node:fs";
import { formatGithubAnnotations } from "../src/check.js";

const reportPath = process.argv[2];
if (!reportPath) {
	process.stderr.write("用法: action-report.mjs <report.json>\n");
	process.exit(2);
}

let raw;
try {
	raw = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (err) {
	process.stderr.write(`无法读取检查报告 ${reportPath}：${err.message}\n`);
	process.exit(2);
}

// JSON 报告是稳定的对外契约；这里把它适配成 formatGithubAnnotations 需要的形状
const result = {
	groups: (raw.groups ?? []).map((g) => ({ ...g, knownCount: g.knownIgnored ?? 0 })),
	errors: raw.summary?.errors ?? 0,
	warnings: raw.summary?.warnings ?? 0,
	knownTotal: raw.summary?.knownIgnored ?? 0,
	stale: raw.stale ?? [],
};

process.stdout.write(formatGithubAnnotations(result));

if (process.env.GITHUB_OUTPUT) {
	fs.appendFileSync(
		process.env.GITHUB_OUTPUT,
		`errors=${result.errors}\nwarnings=${result.warnings}\nknown=${result.knownTotal}\n`,
	);
}

if (process.env.GITHUB_STEP_SUMMARY) {
	const lines = [
		"## md-knowledge-graph",
		"",
		`| | |`,
		`|---|---|`,
		`| 新增错误 | **${result.errors}** |`,
		`| 新增警告 | ${result.warnings} |`,
		`| 已知（基线忽略） | ${result.knownTotal} |`,
		"",
	];
	if (result.errors === 0 && result.warnings === 0) lines.push("✓ 没有新增问题");
	for (const g of result.groups) {
		lines.push(`### ${g.severity === "error" ? "✗" : "⚠"} ${g.title} —— ${g.items.length} 项`, "");
		for (const item of g.items.slice(0, 20)) lines.push(`- \`${item.message}\``);
		if (g.items.length > 20) lines.push(`- … 另有 ${g.items.length - 20} 项`);
		lines.push("");
	}
	fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
