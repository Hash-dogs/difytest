'use strict';

/**
 * 计分算法（PLAN §6）—— 纯函数，不碰数据库，便于单测。
 *
 * ⚠️ 2026-09-18 变更：从「一次性打完所有人」改成「一场一投」后，**旧规则的前提没了**。
 *
 *   旧算法靠「不允许弃权」——所有评委都给每一格打了分，所以每格票数恒等于 N，
 *   于是 k = N - 2 对**所有单元格是同一个常数**，U_c = Σ(w_d × sum) 是整数，
 *   旧 §4.5 才敢规定「排名只能比较整数，禁止比较浮点数」。
 *
 *   现在管理员可以随时切场，弃权是常态，**每一场的票数都可能不同**，k 不再是常数。
 *
 * 新规则（自适应去分）—— 对每个 (场次, 维度) 单元格，设实际收到的分数为 raw：
 *
 *    raw.length >= 3  →  升序排序，去掉首尾各一个，其余取平均
 *    raw.length == 2  →  两个分数直接取平均（去分会让它归零，所以不去）
 *    raw.length == 1  →  直接用这个分数，标记 single，页面显示「仅 1 票」
 *    raw.length == 0  →  该场不计分（整行 blank）
 *
 * **每一场都必须产出结果**，票数再少也不抛错、不阻塞导出。
 *
 * 排名仍然只比较整数（PLAN §6.3）：把各格不同的分母统一到
 *   L = LCM(所有出现过的 keptCount)
 * 于是
 *   uScaled = Σ_d  w_d × sum_d × (L / keptCount_d)      ← 整数
 *   total   = uScaled / (WEIGHT_TOTAL × L)              ← 仅用于展示
 *
 * 这个式子在「所有场次票数相同」时**精确退化成旧公式**（此时 L = keptCount，
 * 每项都乘 1），所以新算法是旧算法的严格推广，不是另起一套。
 */

const WEIGHT_TOTAL = 100;

/** 评委人数设计上限。LCM 量级证明依赖它（PLAN §6.3）。 */
const MAX_JUDGES = 20;

/** LCM(1..20) = 232,792,560 —— 评委 ≤20 时 L 不可能超过它。 */
const LCM_LIMIT = 232792560;

const cellKey = (roundId, dimensionId) => `${roundId}:${dimensionId}`;

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

const gcd = (a, b) => {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
};

/** 最小公倍数。忽略非正数，便于直接喂 keptCount 集合。 */
function lcm(values) {
  let out = 1;
  for (const v of values) {
    if (!Number.isInteger(v) || v <= 0) continue;
    out = (out / gcd(out, v)) * v;
  }
  return out;
}

/**
 * 同一演讲者只保留 seq 最大的那一场（PLAN §5.4 重开场景）。
 * @param {Array} rounds 全部场次
 * @returns {{ effective: Array, supersededIds: Set<number> }}
 */
function pickEffectiveRounds(rounds) {
  const best = new Map(); // contestantId -> round
  for (const r of rounds) {
    const prev = best.get(r.contestantId);
    if (!prev || r.seq > prev.seq) best.set(r.contestantId, r);
  }
  const supersededIds = new Set();
  for (const r of rounds) if (best.get(r.contestantId) !== r) supersededIds.add(r.id);
  const effective = [...best.values()].sort((a, b) => a.seq - b.seq || a.id - b.id);
  return { effective, supersededIds };
}

/**
 * @param {object} input
 * @param {Array}  input.rounds      本场活动的**有效场次**（已剔除 superseded），元素：
 *                                   { id, seq, contestantId, contestantSeq,
 *                                     contestantName, contestantProject }
 * @param {Array}  input.dimensions  维度 [{ id, seq, name, weight }]
 * @param {Array<Array<{round_id:number, dimension_id:number, value:number}>>} input.ballots
 *        每张选票一个数组，元素为该票的所有评分行
 */
function computeResults({ rounds, dimensions, ballots }) {
  assertWeights(dimensions);

  const roundIds = new Set(rounds.map((r) => r.id));

  // 每格一个桶（含 0 票的格子，这样空白场次也能走同一条路径）
  const buckets = new Map();
  for (const r of rounds) for (const d of dimensions) buckets.set(cellKey(r.id, d.id), []);

  const ballotCount = new Map();
  for (const r of rounds) ballotCount.set(r.id, 0);

  // 孤儿行：指向不存在的场次或维度（配置改动后的残留）。计数上报，不抛错。
  let orphans = 0;

  for (const rows of ballots) {
    if (!rows.length) continue;
    const roundId = rows[0].round_id;
    if (!roundIds.has(roundId)) {
      orphans += rows.length;
      continue;
    }
    ballotCount.set(roundId, ballotCount.get(roundId) + 1);
    for (const s of rows) {
      const bucket = buckets.get(cellKey(s.round_id, s.dimension_id));
      if (!bucket) {
        orphans += 1; // 维度已不存在
        continue;
      }
      bucket.push(s.value);
    }
  }

  // 第一遍：定出每格的 keptCount，收集起来求 LCM
  const perCell = new Map();
  const keptCounts = new Set();

  for (const r of rounds) {
    for (const d of dimensions) {
      const raw = buckets.get(cellKey(r.id, d.id));
      const sorted = raw.slice().sort((a, b) => a - b);
      // 恰好去掉一个最小值和一个最大值（各一个，不是去所有极值）。
      // 3 票以下不去分：去分会把分数全部去光，反而丢失信息。
      const kept = raw.length >= 3 ? sorted.slice(1, -1) : sorted;
      const sum = kept.reduce((acc, v) => acc + v, 0);

      perCell.set(cellKey(r.id, d.id), { raw, sorted, kept, sum });
      if (kept.length > 0) keptCounts.add(kept.length);
    }
  }

  const L = lcm([...keptCounts]);

  // PLAN §6.3 量级证明：评委 ≤20 时 keptCount ∈ [1,20]，L ≤ LCM(1..20) = 2.33e8。
  //   单项上界 = w_d(≤100) × sum_d(≤5×20=100) × L/1 ≈ 2.33e12
  //   5 维求和 ≤ 1.2e13  ≪ Number.MAX_SAFE_INTEGER(9.007e15)
  // 超过这个界说明评委人数或票数分布超出了设计前提，宁可拒绝出结果也不要算出
  // 一个悄悄丢精度的排名。
  if (L > LCM_LIMIT) {
    throw new Error(
      `票数分布超出设计上界（LCM=${L} > ${LCM_LIMIT}）。` +
        `本项目按评委人数 ≤ ${MAX_JUDGES} 设计，请检查场次票数是否异常。`
    );
  }

  const rows = rounds.map((r) => {
    const n = ballotCount.get(r.id);
    const blank = n === 0;

    const margins = {};
    const details = {};
    let u = 0;

    for (const d of dimensions) {
      const { raw, sorted, kept, sum } = perCell.get(cellKey(r.id, d.id));
      const keptCount = kept.length;
      const margin = keptCount > 0 ? sum / keptCount : null;

      margins[d.id] = margin;
      if (keptCount > 0) u += d.weight * sum * (L / keptCount);

      const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const v of raw) counts[v] += 1;

      details[d.id] = {
        counts,
        // 没去分时（票数 ≤2），这两项就是首尾本身，不代表「被去掉」
        removedLow: sorted.length ? sorted[0] : null,
        removedHigh: sorted.length ? sorted[sorted.length - 1] : null,
        trimmed: raw.length >= 3,
        keptCount,
        sum,
        margin,
        single: keptCount === 1,
      };
    }

    if (!Number.isSafeInteger(u)) {
      throw new Error(
        `场次 ${r.id} 的加权分超出安全整数范围（u=${u}）。` +
          `这是实现缺陷而非数据问题，请检查 LCM 缩放逻辑。`
      );
    }

    return {
      roundId: r.id,
      contestantId: r.contestantId,
      seq: r.contestantSeq,
      name: r.contestantName,
      project: r.contestantProject || '',
      n,
      thin: n > 0 && n <= 2, // 票数少到结论不可靠，页面需要标注
      blank,
      margins,
      details,
      u: blank ? null : u,
      total: blank ? null : u / (WEIGHT_TOTAL * L),
      rank: null,
    };
  });

  // PLAN §6.3：排名按整数 u 降序；blank 行排末尾；并列名次相同、下一名跳号。
  const ranked = rows.slice().sort((a, b) => {
    if (a.blank !== b.blank) return a.blank ? 1 : -1;
    if (!a.blank && a.u !== b.u) return b.u - a.u;
    return a.seq - b.seq; // 同分或都空白时，按上场顺序
  });

  ranked.forEach((row, i) => {
    if (row.blank) {
      row.rank = null;
      return;
    }
    const prev = ranked[i - 1];
    row.rank = i > 0 && prev && !prev.blank && prev.u === row.u ? prev.rank : i + 1;
  });

  return { rounds: ranked, lcm: L, orphans, insufficient: ranked.every((r) => r.blank) };
}

/** 展示用：保留 2 位小数的字符串 */
const formatScore = (value) => (value === null || value === undefined ? '—' : value.toFixed(2));

module.exports = {
  computeResults,
  pickEffectiveRounds,
  assertWeights,
  formatScore,
  lcm,
  WEIGHT_TOTAL,
  MAX_JUDGES,
};
