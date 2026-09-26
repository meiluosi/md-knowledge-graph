/**
 * 相关文章计算。
 *
 * 这是本工具「有理由被反复运行」的另一半：输出的产物能直接被博客消费
 * （「相关阅读」模块），而不是一个看完就丢的图。
 *
 * 打分基于三种信号：
 *   正文互相引用  —— 最强，是作者明确表达的关联
 *   共享标签      —— 主题相近
 *   同一分类      —— 弱信号，只作补充
 *
 * @module related
 */

/** 各信号的权重 */
const WEIGHT = {
	link: 3,
	backlink: 3,
	tag: 2,
	category: 1,
};

/**
 * 计算每篇文章的相关文章。
 *
 * @param {Array<{id: string, title: string, tags: string[], category: string}>} posts
 * @param {object} input
 * @param {Array<{from: string, to: string}>} input.linkEdges 已解析的 post→post 引用
 * @param {object} [options]
 * @param {number} [options.top=5] 每篇保留几个
 * @param {number} [options.minScore=1] 低于此分不输出
 * @returns {{schemaVersion: number, posts: Array<{id: string, title: string, related: Array<{id: string, title: string, score: number, reasons: string[]}>}>}}
 */
export function computeRelated(posts, { linkEdges }, options = {}) {
	const { top = 5, minScore = 1 } = options;

	const byId = new Map(posts.map((p) => [p.id, p]));
	const outbound = new Map();
	const inbound = new Map();
	for (const { from, to } of linkEdges) {
		if (!outbound.has(from)) outbound.set(from, new Set());
		outbound.get(from).add(to);
		if (!inbound.has(to)) inbound.set(to, new Set());
		inbound.get(to).add(from);
	}

	const result = [];
	for (const post of posts) {
		/** @type {Map<string, {score: number, reasons: Set<string>}>} */
		const scores = new Map();
		const bump = (otherId, points, reason) => {
			if (otherId === post.id || !byId.has(otherId)) return;
			if (!scores.has(otherId)) scores.set(otherId, { score: 0, reasons: new Set() });
			const entry = scores.get(otherId);
			entry.score += points;
			entry.reasons.add(reason);
		};

		// 正文引用：出链 + 入链
		for (const to of outbound.get(post.id) ?? []) bump(to, WEIGHT.link, "link");
		for (const from of inbound.get(post.id) ?? []) bump(from, WEIGHT.backlink, "backlink");

		// 共享标签
		const myTags = new Set(post.tags.map((t) => t.toLowerCase()));
		for (const other of posts) {
			if (other.id === post.id) continue;
			for (const tag of other.tags) {
				if (myTags.has(tag.toLowerCase())) bump(other.id, WEIGHT.tag, `tag:${tag}`);
			}
		}

		// 同一分类
		if (post.category) {
			for (const other of posts) {
				if (other.id !== post.id && other.category === post.category) {
					bump(other.id, WEIGHT.category, `category:${post.category}`);
				}
			}
		}

		const related = [...scores.entries()]
			.filter(([, v]) => v.score >= minScore)
			.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
			.slice(0, top)
			.map(([id, v]) => ({
				id,
				title: byId.get(id)?.title ?? "",
				score: v.score,
				reasons: [...v.reasons].sort(),
			}));

		result.push({ id: post.id, title: post.title, related });
	}

	return { schemaVersion: 1, posts: result };
}
