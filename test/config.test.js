/**
 * 配置文件测试。
 *
 * 重点是两条设计原则：
 *   1. 拼错的东西必须报错，不能静默失效（未知字段、未知规则名）
 *   2. 优先级必须是 CLI > 配置文件 > 默认值
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
	CONFIG_FILENAME,
	CONFIG_SCHEMA_VERSION,
	describeRuleOverrides,
	findConfigFile,
	parseConfig,
} from "../src/config.js";
import { RULE_CODES, runChecks } from "../src/check.js";
import { buildGraph } from "../src/graph.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.js");

async function tmp() {
	return fs.mkdtemp(path.join(os.tmpdir(), "mdkg-config-"));
}

/** 跑 CLI，返回 {code, stdout, stderr} */
function mdkg(args, options = {}) {
	const res = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", ...options });
	return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("parseConfig —— 合法配置", () => {
	it("空对象可接受（等于全用默认值）", () => {
		assert.deepEqual(parseConfig("{}"), {});
	});

	it("接受全部已知字段", () => {
		const cfg = parseConfig(
			JSON.stringify({
				schemaVersion: CONFIG_SCHEMA_VERSION,
				posts: "content",
				minTagCount: 3,
				maxNodes: 50,
				linkEdges: false,
				anchorCheck: false,
				assetRoot: "public",
				postUrl: "/posts/{id}/",
				tagUrl: "/tags/{slug}/",
				categoryUrl: "/categories/{slug}/",
				relatedTop: 3,
				relatedMinScore: 2,
				rules: { untagged: "off", "singleton-tag": "warn" },
			}),
		);
		assert.equal(cfg.posts, "content");
		assert.deepEqual(cfg.rules, { untagged: "off", "singleton-tag": "warn" });
	});

	it("rules 的三种级别都接受", () => {
		for (const level of ["error", "warn", "off"]) {
			assert.doesNotThrow(() => parseConfig(JSON.stringify({ rules: { untagged: level } })));
		}
	});
});

describe("parseConfig —— 拼错必须报错（不能静默失效）", () => {
	it("非法 JSON 报错", () => {
		assert.throws(() => parseConfig("{ nope"), /不是合法 JSON/);
	});

	it("顶层不是对象时报错", () => {
		assert.throws(() => parseConfig("[]"), /顶层应为对象/);
		assert.throws(() => parseConfig("null"), /顶层应为对象/);
	});

	it("schemaVersion 不匹配报错", () => {
		assert.throws(() => parseConfig('{"schemaVersion": 99}'), /schemaVersion 不匹配/);
	});

	it("**未知顶层字段报错**（拼错一个字段却毫无效果最难排查）", () => {
		assert.throws(() => parseConfig('{"postsDir": "content"}'), /未知字段「postsDir」/);
		assert.throws(() => parseConfig('{"mintagcount": 3}'), /未知字段/);
	});

	it("**未知规则名报错**（否则用户以为关掉了，实际没关）", () => {
		assert.throws(() => parseConfig('{"rules": {"untaged": "off"}}'), /未知规则「untaged」/);
	});

	it("非法规则级别报错", () => {
		assert.throws(() => parseConfig('{"rules": {"untagged": "ignore"}}'), /值应为 error \/ warn \/ off/);
	});

	it("类型不对报错", () => {
		assert.throws(() => parseConfig('{"minTagCount": "2"}'), /minTagCount 应为数字/);
		assert.throws(() => parseConfig('{"posts": 123}'), /posts 应为字符串/);
		assert.throws(() => parseConfig('{"anchorCheck": "yes"}'), /anchorCheck 应为布尔值/);
		assert.throws(() => parseConfig('{"rules": []}'), /rules 应为对象/);
	});

	it("错误信息里带上文件名，便于定位", () => {
		try {
			parseConfig('{"zzz": 1}', "/some/path/mdkg.config.json");
			assert.fail("应当抛错");
		} catch (err) {
			assert.ok(err.message.includes("/some/path/mdkg.config.json"), "错误信息应含文件路径");
			assert.ok(err.message.includes("zzz"), "错误信息应含出问题的字段");
		}
	});
});

describe("findConfigFile", () => {
	it("在 cwd 里找", async () => {
		const dir = await tmp();
		await fs.writeFile(path.join(dir, CONFIG_FILENAME), "{}");
		assert.equal(findConfigFile({ cwd: dir }), path.join(dir, CONFIG_FILENAME));
	});

	it("在语料目录里找", async () => {
		const dir = await tmp();
		const posts = path.join(dir, "content");
		await fs.mkdir(posts);
		await fs.writeFile(path.join(posts, CONFIG_FILENAME), "{}");
		assert.equal(findConfigFile({ cwd: dir, postsDir: posts }), path.join(posts, CONFIG_FILENAME));
	});

	it("cwd 优先于语料目录", async () => {
		const dir = await tmp();
		const posts = path.join(dir, "content");
		await fs.mkdir(posts);
		await fs.writeFile(path.join(dir, CONFIG_FILENAME), "{}");
		await fs.writeFile(path.join(posts, CONFIG_FILENAME), "{}");
		assert.equal(findConfigFile({ cwd: dir, postsDir: posts }), path.join(dir, CONFIG_FILENAME));
	});

	it("都没有时返回 null", async () => {
		assert.equal(findConfigFile({ cwd: await tmp() }), null);
	});

	it("不向上递归找", async () => {
		const parent = await tmp();
		const child = path.join(parent, "deep", "deeper");
		await fs.mkdir(child, { recursive: true });
		await fs.writeFile(path.join(parent, CONFIG_FILENAME), "{}");
		assert.equal(findConfigFile({ cwd: child }), null);
	});
});

describe("describeRuleOverrides", () => {
	it("没有规则覆盖时返回空串", () => {
		assert.equal(describeRuleOverrides(null), "");
		assert.equal(describeRuleOverrides({}), "");
		assert.equal(describeRuleOverrides({ rules: {} }), "");
	});

	it("列出每条覆盖", () => {
		assert.equal(
			describeRuleOverrides({ rules: { untagged: "off", orphan: "error" } }),
			"untagged=off, orphan=error",
		);
	});
});

describe("规则覆盖对检查结果的影响", () => {
	const posts = [
		{ id: "a", title: "A", tags: ["x", "only"], category: "C", content: "[没了](./gone.md)", hasFrontmatter: true },
	];
	const scan = (rules) => {
		const graph = buildGraph(posts, { minTagCount: 2 });
		return runChecks({ posts, skipped: [], graph, minTagCount: 2, rules });
	};

	it("off 让整组消失，且不计入错误/警告数", () => {
		const before = scan(undefined);
		const after = scan({ "singleton-tag": "off" });
		assert.ok(before.groups.some((g) => g.code === "singleton-tag"));
		assert.ok(!after.groups.some((g) => g.code === "singleton-tag"));
		assert.ok(after.warnings < before.warnings, "关掉后警告数应减少");
	});

	it("off 关掉错误级规则后，退出判定也会变", () => {
		const after = scan({ "broken-link": "off" });
		assert.equal(after.errors, 0, "关掉唯一错误后 errors 应为 0");
	});

	it("warn 可以把错误降级", () => {
		const after = scan({ "broken-link": "warn" });
		assert.equal(after.errors, 0, "降级后不该再有错误");
		const group = after.groups.find((g) => g.code === "broken-link");
		assert.ok(group, "降级不该让整组消失");
		assert.equal(group.severity, "warn");
		// 不硬编码总数：这份语料里还有别的警告，断言口径要跟着结果走
		assert.ok(after.warnings >= group.items.length, "降级下来的条目应计入警告");
	});

	it("error 可以把警告升级", () => {
		const after = scan({ "singleton-tag": "error" });
		assert.ok(after.errors > 0);
		assert.ok(!after.groups.some((g) => g.code === "singleton-tag" && g.severity === "warn"));
	});

	it("未覆盖的规则保持默认级别", () => {
		const after = scan({ "singleton-tag": "off" });
		const broken = after.groups.find((g) => g.code === "broken-link");
		assert.equal(broken.severity, "error");
	});
});

describe("规则登记表的完整性", () => {
	it("源码里 add() 的每个 code 都在 RULES 表里登记", async () => {
		// 结构测试：新增检查项时如果忘了登记，它既不会出现在 --list-rules，
		// 也无法被配置关闭——属于"悄悄多了一条不可控规则"。
		const src = await fs.readFile(path.join(ROOT, "src", "check.js"), "utf8");
		const emitted = [...src.matchAll(/\n\tadd\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
		assert.ok(emitted.length >= 10, `只找到 ${emitted.length} 处 add()，正则可能失效了`);
		for (const code of emitted) {
			assert.ok(RULE_CODES.includes(code), `检查项「${code}」没有登记在 RULES 表里`);
		}
	});

	it("RULES 表里没有多余项（每个都真的被用到）", async () => {
		const src = await fs.readFile(path.join(ROOT, "src", "check.js"), "utf8");
		const emitted = new Set([...src.matchAll(/\n\tadd\(\s*"([a-z-]+)"/g)].map((m) => m[1]));
		for (const code of RULE_CODES) {
			assert.ok(emitted.has(code), `RULES 里的「${code}」没有任何地方产出它`);
		}
	});

	it("每个 code 都有 title 与合法的默认级别", async () => {
		const { RULES } = await import("../src/check.js");
		for (const rule of RULES) {
			assert.ok(rule.title && rule.title.length > 0, `${rule.code} 缺 title`);
			assert.ok(["error", "warn"].includes(rule.severity), `${rule.code} 默认级别不合法`);
		}
	});

	it("RULES 里的 code 不重复", () => {
		assert.equal(new Set(RULE_CODES).size, RULE_CODES.length, "有重复的规则代码");
	});
});

describe("CLI 的配置优先级", () => {
	async function setup() {
		const dir = await tmp();
		const corpusDir = path.join(dir, "content");
		await fs.mkdir(corpusDir);
		await fs.writeFile(
			path.join(corpusDir, "a.md"),
			"---\ntitle: A\ntags: [x, only]\ncategory: C\n---\n[没了](./gone.md)\n",
			"utf8",
		);
		return { dir, corpusDir };
	}

	it("配置文件可以指定 posts", async () => {
		const { dir, corpusDir } = await setup();
		await fs.writeFile(
			path.join(dir, CONFIG_FILENAME),
			JSON.stringify({ posts: corpusDir }),
			"utf8",
		);
		const r = mdkg(["--check"], { cwd: dir });
		assert.ok(r.stderr.includes("读取配置"), "应说明读到了配置");
		assert.ok(r.stderr.includes(corpusDir));
	});

	it("**命令行覆盖配置文件**", async () => {
		const { dir, corpusDir } = await setup();
		const other = path.join(dir, "other");
		await fs.mkdir(other);
		await fs.writeFile(path.join(other, "z.md"), "# Z\n", "utf8");
		await fs.writeFile(
			path.join(dir, CONFIG_FILENAME),
			JSON.stringify({ posts: corpusDir }),
			"utf8",
		);
		const r = mdkg(["--check", "--posts", other], { cwd: dir });
		assert.ok(r.stderr.includes(other), "命令行给的目录应生效");
		assert.ok(!r.stderr.includes(`读取语料：${corpusDir}`), "配置里的目录应被覆盖");
	});

	it("配置文件里关掉的规则不再报出", async () => {
		const { dir, corpusDir } = await setup();
		await fs.writeFile(
			path.join(dir, CONFIG_FILENAME),
			JSON.stringify({ posts: corpusDir, rules: { "singleton-tag": "off" } }),
			"utf8",
		);
		const r = mdkg(["--check"], { cwd: dir });
		assert.ok(!r.stdout.includes("只出现一次的标签"), "被关掉的规则不该出现");
		assert.ok(r.stderr.includes("singleton-tag=off"), "应说明做了覆盖");
	});

	it("--config 指定不存在的文件时报错", () => {
		const r = mdkg(["--posts", path.join(ROOT, "examples"), "--check", "--config", "/nope/x.json"]);
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("指定的配置文件不存在"));
	});

	it("配置文件坏掉时报错，而不是静默忽略", async () => {
		const { dir, corpusDir } = await setup();
		await fs.writeFile(path.join(dir, CONFIG_FILENAME), '{"rules": {"typo-rule": "off"}}', "utf8");
		const r = mdkg(["--check", "--posts", corpusDir], { cwd: dir });
		assert.equal(r.code, 1);
		assert.ok(r.stderr.includes("未知规则"));
	});

	it("--list-rules 列出全部规则并标出被关掉的", async () => {
		const { dir, corpusDir } = await setup();
		await fs.writeFile(
			path.join(dir, CONFIG_FILENAME),
			JSON.stringify({ posts: corpusDir, rules: { untagged: "off" } }),
			"utf8",
		);
		const r = mdkg(["--list-rules"], { cwd: dir });
		assert.equal(r.code, 0);
		for (const code of RULE_CODES) {
			assert.ok(r.stdout.includes(code), `--list-rules 应列出 ${code}`);
		}
		assert.match(r.stdout, /· untagged\s+off/, "被关掉的规则应标为 ·");
	});
});
