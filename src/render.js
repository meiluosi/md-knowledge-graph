/**
 * 输出渲染：Mermaid 文本 与 自包含 HTML。
 *
 * 设计约束：HTML 产物必须**离线可用**——不引 CDN、不引外部字体、
 * 不引任何 JS 库。别人 clone 下来双击就能看到图，这是本项目
 * 「10 分钟可复现」的一部分。
 *
 * @module render
 */

/** 节点类型 → 颜色 */
const COLORS = {
	category: "#e8590c",
	tag: "#1c7ed6",
	post: "#2f9e44",
};

/** 边类型 → 颜色（link 用暖色，与「归属」类边区分开） */
const EDGE_COLORS = {
	category: "rgba(232,89,12,0.45)",
	tag: "rgba(28,126,214,0.40)",
	link: "rgba(214,51,132,0.75)",
};

/**
 * 生成 Mermaid 图文本。
 * 这类输出可以直接贴进支持 Mermaid 的 README，无需截图。
 *
 * post→post 的引用边用虚线，和 post→tag / post→category 的实线区分开。
 *
 * @param {{nodes: Array<{id: string, label: string, type: string}>, edges: Array<{source: string, target: string, type?: string}>}} graph
 * @returns {string}
 */
export function toMermaid(graph) {
	/** 转义 Mermaid 标签里会造成语法问题的字符 */
	const esc = (s) => String(s).replace(/"/g, "&quot;").replace(/[[\]{}()]/g, " ");
	const lines = ["graph LR"];

	for (const node of graph.nodes) {
		const shape = node.type === "post" ? ["[", "]"] : node.type === "tag" ? ["(", ")"] : ["{{", "}}"];
		lines.push(`  ${node.id}${shape[0]}"${esc(node.label)}"${shape[1]}`);
	}
	for (const edge of graph.edges) {
		const arrow = edge.type === "link" ? "-.->" : "-->";
		lines.push(`  ${edge.source} ${arrow} ${edge.target}`);
	}

	return `${lines.join("\n")}\n`;
}

/**
 * 生成自包含的 HTML 图（内嵌数据 + 内嵌力导向布局实现）。
 *
 * 内嵌脚本刻意只用单引号与字符串拼接，避免与模板字面量冲突。
 *
 * @param {{nodes: Array<object>, edges: Array<object>, meta?: object}} graph
 * @param {object} [options]
 * @param {string} [options.title]
 * @returns {string}
 */
export function toHtml(graph, options = {}) {
	const title = options.title || "Knowledge Graph";
	// 转义 < 以防语料里出现 </script> 破坏文档结构
	const payload = JSON.stringify({ nodes: graph.nodes, edges: graph.edges, meta: graph.meta || {} }).replace(/</g, "\\u003c");

	const runtime = `
var DATA = JSON.parse(document.getElementById('graph-data').textContent);
var COLORS = ${JSON.stringify(COLORS)};
var EDGE_COLORS = ${JSON.stringify(EDGE_COLORS)};
var canvas = document.getElementById('c');
var ctx = canvas.getContext('2d');
var W = 0, H = 0, DPR = window.devicePixelRatio || 1;

function resize() {
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

var nodes = DATA.nodes.map(function (n, i) {
  var a = (i / Math.max(1, DATA.nodes.length)) * Math.PI * 2;
  var r = Math.min(W, H) * 0.32 || 200;
  return { id: n.id, label: n.label, type: n.type, count: n.count || 1,
           x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
});
var index = {};
nodes.forEach(function (n, i) { index[n.id] = i; });
var edges = DATA.edges.filter(function (e) { return index[e.source] !== undefined && index[e.target] !== undefined; });

function radius(n) { return n.type === 'post' ? 5 : 7 + Math.min(9, (n.count || 1) * 1.6); }

function simulate() {
  var ticks = 420;
  for (var t = 0; t < ticks; t++) {
    var k = 0.055 * (1 - t / ticks) + 0.006;
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i], b = nodes[j];
        var dx = b.x - a.x, dy = b.y - a.y;
        var d2 = dx * dx + dy * dy + 0.01;
        var d = Math.sqrt(d2);
        var f = 2200 / d2;
        var fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    for (var e = 0; e < edges.length; e++) {
      var s = nodes[index[edges[e].source]], tg = nodes[index[edges[e].target]];
      var ex = tg.x - s.x, ey = tg.y - s.y;
      var ed = Math.sqrt(ex * ex + ey * ey) + 0.01;
      var desired = 78;
      var ef = (ed - desired) * 0.045;
      var efx = (ex / ed) * ef, efy = (ey / ed) * ef;
      s.vx += efx; s.vy += efy; tg.vx -= efx; tg.vy -= efy;
    }
    for (var m = 0; m < nodes.length; m++) {
      var p = nodes[m];
      p.vx += -p.x * 0.012; p.vy += -p.y * 0.012;
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += p.vx * k * 12; p.y += p.vy * k * 12;
    }
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save(); ctx.translate(W / 2, H / 2);
  ctx.lineWidth = 1;
  for (var e = 0; e < edges.length; e++) {
    var s = nodes[index[edges[e].source]], t = nodes[index[edges[e].target]];
    var et = edges[e].type || 'tag';
    ctx.strokeStyle = EDGE_COLORS[et] || EDGE_COLORS.tag;
    ctx.lineWidth = et === 'link' ? 1.8 : 1;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
  }
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], r = radius(n);
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[n.type] || '#888'; ctx.fill();
  }
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (var j = 0; j < nodes.length; j++) {
    var m = nodes[j];
    if (m.type === 'post' && nodes.length > 60) continue;
    var label = m.label.length > 18 ? m.label.slice(0, 17) + '…' : m.label;
    ctx.fillStyle = 'rgba(128,138,148,0.95)';
    ctx.fillText(label, m.x, m.y + radius(m) + 3);
  }
  ctx.restore();
}

var drag = null;
function pick(mx, my) {
  var best = null, bd = 18 * 18;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], dx = mx - n.x, dy = my - n.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
canvas.addEventListener('pointerdown', function (ev) {
  var rect = canvas.getBoundingClientRect();
  drag = pick(ev.clientX - rect.left - W / 2, ev.clientY - rect.top - H / 2);
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', function (ev) {
  if (!drag) return;
  var rect = canvas.getBoundingClientRect();
  drag.x = ev.clientX - rect.left - W / 2;
  drag.y = ev.clientY - rect.top - H / 2;
  drag.vx = 0; drag.vy = 0;
  draw();
});
canvas.addEventListener('pointerup', function () { drag = null; });

resize();
simulate();
draw();
window.addEventListener('resize', function () { resize(); draw(); });
`;

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
         background: #ffffff; color: #1f2328; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } }
  header { padding: 14px 20px; border-bottom: 1px solid rgba(128,138,148,0.25);
           display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  .legend { display: flex; gap: 14px; font-size: 12px; opacity: .75; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
  .line { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 5px; }
  canvas { display: block; width: 100vw; height: calc(100vh - 52px); touch-action: none; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="legend">
    <span><i class="dot" style="background:${COLORS.post}"></i>post</span>
    <span><i class="dot" style="background:${COLORS.tag}"></i>tag</span>
    <span><i class="dot" style="background:${COLORS.category}"></i>category</span>
    <span><i class="line" style="background:${EDGE_COLORS.link}"></i>引用</span>
  </div>
</header>
<canvas id="c"></canvas>
<script type="application/json" id="graph-data">${payload}</script>
<script>${runtime}</script>
</body>
</html>
`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[c]));
}

export { COLORS, EDGE_COLORS };
