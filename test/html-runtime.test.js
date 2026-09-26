/**
 * 生成物测试：把 toHtml 产出的内嵌脚本在一个最小 DOM stub 下真正执行一遍。
 *
 * 为什么值得写：HTML 是**生成出来的**，语法正确不等于能跑。
 * 一个 NaN 坐标或一个漏掉的 canvas 方法，都会让用户拿到一张白屏，
 * 而这类错误在 CI 里如果只做语法检查是抓不到的。
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import { buildGraph, readPosts } from "../src/graph.js";
import { toHtml } from "../src/render.js";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

const ORIGINAL_DOCUMENT = globalThis.document;
const ORIGINAL_WINDOW = globalThis.window;

afterEach(() => {
	globalThis.document = ORIGINAL_DOCUMENT;
	globalThis.window = ORIGINAL_WINDOW;
});

/**
 * 搭一个最小 DOM stub，执行 HTML 里的内嵌脚本，返回可断言的调用记录。
 * @param {string} html
 */
function runEmbedded(html) {
	const jsonMatch = html.match(/<script type="application\/json" id="graph-data">([\s\S]*?)<\/script>/);
	assert.ok(jsonMatch, "HTML 里应有 graph-data 数据块");
	const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
	assert.ok(scriptMatch, "HTML 里应有运行时脚本");

	/** @type {{arc: number[][], fillText: (string|number)[][]}} */
	const calls = { arc: [], fillText: [] };

	const ctx = new Proxy(
		{},
		{
			get(_, prop) {
				if (prop === "arc") return (x, y, r) => calls.arc.push([x, y, r]);
				if (prop === "fillText") return (t, x, y) => calls.fillText.push([t, x, y]);
				return () => {};
			},
			set() {
				return true;
			},
		},
	);

	const canvas = {
		clientWidth: 900,
		clientHeight: 600,
		width: 0,
		height: 0,
		getContext: () => ctx,
		addEventListener: () => {},
		setPointerCapture: () => {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
	};

	/** @type {Record<string, Function>} */
	const listeners = {};

	globalThis.document = {
		getElementById: (id) => (id === "graph-data" ? { textContent: jsonMatch[1] } : canvas),
	};
	globalThis.window = {
		devicePixelRatio: 2,
		addEventListener: (name, fn) => {
			listeners[name] = fn;
		},
	};

	new Function(scriptMatch[1])();

	return { calls, canvas, listeners };
}

describe("toHtml 生成物的运行时", () => {
	it("在 stub DOM 下执行不抛错，且每个节点都被绘制一次", async () => {
		const posts = await readPosts(EXAMPLES);
		const graph = buildGraph(posts, { minTagCount: 1 });
		const html = toHtml(graph, { title: "t" });

		const { calls, canvas } = runEmbedded(html);

		assert.equal(calls.arc.length, graph.nodes.length, "arc 调用次数应等于节点数");
		assert.equal(calls.fillText.length, graph.nodes.length, "每个节点一个标签");
		assert.equal(canvas.width, 1800, "画布宽度应按 DPR 放大");
		assert.equal(canvas.height, 1200, "画布高度应按 DPR 放大");
	});

	it("所有绘制坐标都是有限值（没有 NaN / Infinity）", async () => {
		const posts = await readPosts(EXAMPLES);
		const graph = buildGraph(posts, { minTagCount: 1 });
		const { calls } = runEmbedded(toHtml(graph));

		const badNodes = calls.arc.filter(([x, y, r]) => !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r));
		const badLabels = calls.fillText.filter(([, x, y]) => !Number.isFinite(x) || !Number.isFinite(y));

		assert.deepEqual(badNodes, [], `出现非有限坐标的节点：${JSON.stringify(badNodes.slice(0, 3))}`);
		assert.deepEqual(badLabels, [], `出现非有限坐标的标签：${JSON.stringify(badLabels.slice(0, 3))}`);
	});

	it("空图不会崩（0 节点 0 边）", () => {
		const { calls } = runEmbedded(toHtml({ nodes: [], edges: [], meta: {} }));
		assert.equal(calls.arc.length, 0);
	});

	it("注册了 resize 监听", async () => {
		const posts = await readPosts(EXAMPLES);
		const { listeners } = runEmbedded(toHtml(buildGraph(posts, { minTagCount: 1 })));
		assert.equal(typeof listeners.resize, "function");
	});
});
