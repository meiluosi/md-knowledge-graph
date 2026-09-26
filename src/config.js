/**
 * 配置文件（`mdkg.config.json`）。
 *
 * 为什么需要它：检查项已经有 10 条。不做配置的话，用户遇到**一条不适用的规则**
 * 时，唯一的选择是关掉整个门禁——而那正是本项目花最大力气避免的结局。
 *
 * 两条设计原则都来自本项目已有的教训：
 *
 * 1. **拼错的东西必须报错，不能静默失效。**
 *    写成 `{"rules": {"untaged": "off"}}` 却毫无效果，是典型的静默错误——
 *    用户以为关掉了，实际没有。所以未知的规则名、未知的顶层字段一律报错。
 *
 * 2. **配置被读到这件事必须说出来。**
 *    "为什么这条规则不报？" 如果没有答案，用户会怀疑工具坏了。
 *
 * @module config
 */

import fs from "node:fs";
import path from "node:path";
import { RULE_CODES } from "./check.js";

/** 默认文件名 */
export const CONFIG_FILENAME = "mdkg.config.json";

/** 配置文件的 schema 版本 */
export const CONFIG_SCHEMA_VERSION = 1;

/** 规则可取的值 */
export const RULE_SEVERITIES = ["error", "warn", "off"];

/** 顶层可配置项及其类型 */
const OPTION_TYPES = {
	schemaVersion: "number",
	posts: "string",
	minTagCount: "number",
	maxNodes: "number",
	linkEdges: "boolean",
	anchorCheck: "boolean",
	assetRoot: "string",
	postUrl: "string",
	tagUrl: "string",
	categoryUrl: "string",
	relatedTop: "number",
	relatedMinScore: "number",
	rules: "object",
};

/**
 * 在若干候选目录里找配置文件。
 *
 * 顺序：当前工作目录 → 语料目录。不递归向上找——
 * 一个藏在祖先目录里的配置会让"为什么行为不同"变得极难排查。
 *
 * @param {object} input
 * @param {string} input.cwd
 * @param {string} [input.postsDir]
 * @returns {string|null} 找到的绝对路径
 */
export function findConfigFile({ cwd, postsDir }) {
	const candidates = [path.join(cwd, CONFIG_FILENAME)];
	if (postsDir) candidates.push(path.join(postsDir, CONFIG_FILENAME));
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

/**
 * 解析并校验配置。任何不明之处都抛错，不静默忽略。
 *
 * @param {string} text
 * @param {string} [source] 文件名，用于错误信息
 * @returns {object}
 */
export function parseConfig(text, source = CONFIG_FILENAME) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (err) {
		throw new Error(`配置文件不是合法 JSON：${source}\n${/** @type {Error} */ (err).message}`);
	}

	if (data == null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`配置文件顶层应为对象：${source}`);
	}

	if (data.schemaVersion !== undefined && data.schemaVersion !== CONFIG_SCHEMA_VERSION) {
		throw new Error(
			`配置文件 schemaVersion 不匹配：${source} 是 ${data.schemaVersion}，期望 ${CONFIG_SCHEMA_VERSION}。`,
		);
	}

	// 未知顶层字段：拼错一个字段却毫无效果，是最难排查的一类问题
	for (const key of Object.keys(data)) {
		if (!(key in OPTION_TYPES)) {
			throw new Error(
				`配置文件里有未知字段「${key}」：${source}\n` +
					`  可用字段：${Object.keys(OPTION_TYPES).join("、")}`,
			);
		}
	}

	// 类型检查
	for (const [key, type] of Object.entries(OPTION_TYPES)) {
		if (!(key in data)) continue;
		const value = data[key];
		if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
			throw new Error(`配置项 ${key} 应为数字，实际是 ${JSON.stringify(value)}（${source}）`);
		}
		if (type === "string" && typeof value !== "string") {
			throw new Error(`配置项 ${key} 应为字符串，实际是 ${JSON.stringify(value)}（${source}）`);
		}
		if (type === "boolean" && typeof value !== "boolean") {
			throw new Error(`配置项 ${key} 应为布尔值，实际是 ${JSON.stringify(value)}（${source}）`);
		}
		if (type === "object" && (value == null || typeof value !== "object" || Array.isArray(value))) {
			throw new Error(`配置项 ${key} 应为对象（${source}）`);
		}
	}

	// 规则覆盖：未知规则名必须报错
	if (data.rules !== undefined) {
		for (const [code, severity] of Object.entries(data.rules)) {
			if (!RULE_CODES.includes(code)) {
				throw new Error(
					`配置文件里有未知规则「${code}」：${source}\n` +
						`  可用规则见：mdkg --list-rules`,
				);
			}
			if (!RULE_SEVERITIES.includes(severity)) {
				throw new Error(
					`规则 ${code} 的值应为 ${RULE_SEVERITIES.join(" / ")}，实际是 ${JSON.stringify(severity)}（${source}）`,
				);
			}
		}
	}

	return data;
}

/**
 * 从文件加载配置。文件不存在时返回 null。
 * @param {string} file
 * @returns {object|null}
 */
export function loadConfig(file) {
	if (!fs.existsSync(file)) return null;
	return parseConfig(fs.readFileSync(file, "utf8"), file);
}

/**
 * 描述配置对规则做了什么，用于在 stderr 上说明"配置被读到了"。
 *
 * @param {object|null} config
 * @returns {string} 没有规则覆盖时返回空串
 */
export function describeRuleOverrides(config) {
	const rules = config?.rules;
	if (!rules || Object.keys(rules).length === 0) return "";
	return Object.entries(rules)
		.map(([code, severity]) => `${code}=${severity}`)
		.join(", ");
}
