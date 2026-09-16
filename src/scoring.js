'use strict';

/**
 * 计分算法（PLAN §4）—— 纯函数，不碰数据库，便于单测。
 *
 * 规则：
 *   N = 实际提交的有效选票数（不是计划评委数）
 *   每个单元格 (c, d) 收集 N 个 1..5 的整数分
 *   一律去掉一个最小值和一个最大值，k = N - 2（不再按 N 分档）
 *   m_cd    = sum(S') / k
 *   U_c     = Σ_d ( w_d × sum(S'_cd) )        ← 整数，排名只能用它比较
 *   Total_c = U_c / (100 × k)                 ← 仅用于展示
 *
 * ⚠️ 2026-09-16 变更：原先 N < 6 时不去分（旧 PLAN §4.4 保底规则）已按需求**删除**。
 *    现在无论多少票都去一高一低。边界后果（已确认接受，不做特判）：
 *      N = 1 → k = -1，S' 为空，全员 0.00 并列第 1
 *      N = 2 → k =  0，S' 为空，0/0 = NaN → 序列化成 null，页面显示「—」，全员并列第 1
 *      N = 3 → k =  1，只剩 1 个分数，等于由单个评委决定名次
 *    N = 0（一张票都没有）仍返回「数据不足」—— 那是没有数据，不是去分规则。
 */

const WEIGHT_TOTAL = 100;

const cellKey = (contestantId, dimensionId) => `${contestantId}:${dimensionId}`;

function assertWeights(dimensions) {
  if (!dimensions.length) throw new Error('维度为空，无法计分');

  let sum = 0;
  for (const d of dimensions) {
    if (!Number.isInteger(d.weight)) {
      throw new Error(`维度「${d.name}」权重必须是整数，当前为 ${d.weight}`);
    }
    sum += d.weight;
  }
  if (sum !== WEIGHT_TOTAL) {
    throw new Error(`维度权重合计必须等于 ${WEIGHT_TOTAL}，当前为 ${sum}`);
  }
}

/**
 * @param {object}   input
 * @param {Array}    input.contestants  参赛者 [{ id, seq, name, project }]
 * @param {Array}    input.dimensions   维度    [{ id, seq, name, weight }]
 * @param {Array<Array<{contestant_id:number, dimension_id:number, value:number}>>} input.ballots
 *        每张选票一个数组，元素为该票的所有评分行
 */
function computeResults({ contestants, dimensions, ballots }) {
  assertWeights(dimensions);

  const n = ballots.length;

  // N = 0 → 看板显示「数据不足」，不排名（没有数据，与去分规则无关）
  if (n === 0) {
    return {
      n: 0,
      k: 0,
      trimmed: false,
      insufficient: true,
      rows: contestants.map((c) => ({
        contestantId: c.id,
        seq: c.seq,
        name: c.name,
        project: c.project,
        margins: {},
        u: 0,
        total: null,
        rank: null,
      })),
    };
  }

  // 一律去一高一低。k 对所有单元格一致 —— §4.5 的整数排名依赖这一点。
  const k = n - 2;
  const trimmed = true;

  // 收集每个单元格的原始分
  const buckets = new Map();
  for (const c of contestants) {
    for (const d of dimensions) buckets.set(cellKey(c.id, d.id), []);
  }

  for (const ballot of ballots) {
    for (const s of ballot) {
      const bucket = buckets.get(cellKey(s.contestant_id, s.dimension_id));
      if (!bucket) continue; // 配置改动后残留的孤儿行，不计入
      bucket.push(s.value);
    }
  }

  // PLAN §4.3：不允许弃权 ⇒ 每个单元格的有效票数恒等于 N
  for (const c of contestants) {
    for (const d of dimensions) {
      const bucket = buckets.get(cellKey(c.id, d.id));
      if (bucket.length !== n) {
        throw new Error(
          `数据不一致：参赛者「${c.name}」× 维度「${d.name}」有 ${bucket.length} 个分数，` +
            `但有效选票数为 ${n}。不允许弃权的约束被破坏了，拒绝出结果。`
        );
      }
    }
  }

  const rows = contestants.map((c) => {
    const margins = {};
    let u = 0;

    for (const d of dimensions) {
      const raw = buckets.get(cellKey(c.id, d.id));
      // 升序排序后切掉首尾各一个 —— 恰好去掉一个最小值和一个最大值（各一个，不是去所有极值）
      const kept = raw.slice().sort((a, b) => a - b).slice(1, -1);
      const sum = kept.reduce((acc, v) => acc + v, 0);
      margins[d.id] = sum / k;
      u += d.weight * sum; // 整数运算
    }

    return {
      contestantId: c.id,
      seq: c.seq,
      name: c.name,
      project: c.project,
      margins,
      u,
      total: u / (WEIGHT_TOTAL * k),
      rank: null,
    };
  });

  // PLAN §4.5：排名按整数 U_c 降序；并列名次相同，下一名跳号（标准竞赛排名）
  const ranked = rows.slice().sort((a, b) => b.u - a.u || a.seq - b.seq);
  ranked.forEach((row, i) => {
    row.rank = i > 0 && row.u === ranked[i - 1].u ? ranked[i - 1].rank : i + 1;
  });

  return { n, k, trimmed, insufficient: false, rows: ranked };
}

/** 展示用：保留 2 位小数的字符串 */
const formatScore = (value) => (value === null || value === undefined ? '—' : value.toFixed(2));

module.exports = { computeResults, assertWeights, formatScore, WEIGHT_TOTAL };
