'use strict';

/**
 * 计分算法（PLAN §6）—— 纯函数，不碰数据库，便于单测。
 *
 * ⚠️ 2026-09-18 变更：计分口径改为**完全对齐活动方《Dify工作流竞赛作品评选方案》**。
 *
 *   上一版口径：对每个 (场次, 维度) 单元格**各自**去一高一低。
 *   现口径：按每位评委的**加权总分**去一高一低。
 *
 *   两者结果不同。多维度下「各维度各自去分」≠「按评委总分去分」——
 *   一个「某维度给高、另一维度给低」的评委，在旧口径下被两个维度分别当成极值处理，
 *   在新口径下他只是**一个总分**。方案第四顺位写的是「全部评委（**不去最高、最低**）
 *   的加权总分」，只有去分发生在评委总分层面这句话才讲得通。
 *
 * 方案原文：
 *   取分规则：去掉 1 个最高总分、1 个最低总分，剩余总分求平均，
 *            四舍五入保留 2 位小数，作为该项目的最终得分。
 *   同分细则：① 现有业务流程契合度（30%）原始平均分 ② 长期重复使用价值（25%）
 *            ③ 完整性与可用性（15%） ④ 全部评委不去分的加权总分 ⑤ 评委组无记名投票
 *
 * 去分仍然**自适应票数**（这一条没变 —— 管理员可随时切场，弃权是常态）：
 *
 *    n >= 3  →  升序排序，去掉首尾各一个（各一个，不是去所有极值），其余取平均
 *    n == 2  →  两个都保留（去分会把票去光，反而丢失全部信息）
 *    n == 1  →  保留这个总分，标记 single
 *    n == 0  →  该场不计分（整行 blank）
 *
 * **每一场都必须产出结果**，票数再少也不抛错、不阻塞导出。
 *
 * 什么算一张**有效票**：必须覆盖全部当前维度，且只属于这一场。
 * 没写全的选票（`incomplete`，单位「张」）与指向已删场次/维度的残留行
 * （`orphans`，单位「行」）都**不计分**，但分开计数上报 —— 成因不同，混在一起会查错方向。
 * 按评委总分去分要求每张票的总分是完整的，残缺票的总分是残的，
 * 拿去和完整票一起「去掉最高最低」等于把去分保护用在一个错误的数上。
 * （正常情况下写不出残缺票：投票接口校验维度齐全、写入走事务，
 *  且开赛后维度集合被冻结。所以这条是防御性的。）
 *
 * 全部比较仍是**精确整数**（PLAN §6.3 的立场不变，禁止退回浮点比较）：
 *
 *    L        = LCM(所有出现过的 keptCount)
 *    uScaled  = sumKept × (L / keptCount)      ← 整数
 *    score100 = round(uScaled / L)             ← 排名主键 =「最终得分 × 100」
 *    total    = score100 / 100                 ← 展示用，1.00–5.00
 *
 * ⚠️ `total` 是**取整后的最终得分**，不是精确值 —— 方案规定的排名依据就是取整后的分数。
 *    排名看 score100、展示看 total，两者由同一个整数导出，
 *    所以页面上不会出现「两个都显示 4.63 却名次不同还看不出为什么」的错位。
 *    精确值另存在 `totalExact` 里，只供审计。
 *
 * 同分顺位要的是**不去分**的原始平均分，分母是各场的有效票数而不是 keptCount，
 * 所以另立一个缩放基准 Lraw = LCM(所有 n)，顺位键同样是精确整数。
 */

const WEIGHT_TOTAL = 100;

/** 评委人数设计上限。LCM 量级证明依赖它（PLAN §6.3）。 */
const MAX_JUDGES = 20;

/** LCM(1..20) = 232,792,560 —— 评委 ≤20 时 L 与 Lraw 都不可能超过它。 */
const LCM_LIMIT = 232792560;

/**
 * 同分顺位①②③（《评选方案》同分细则）—— 按**权重**去认维度。
 *
 * 不按名字、也不按 seq：名字可能被后台改、seq 可能被调，而权重在开赛后是**冻结**的，
 * 并且方案原文自己就是用权重标注这三条顺位的。
 * 找不到对应权重的维度就跳过该顺位（维度配置可能与默认不同）。
 *
 * ⚠️ 刻意是 30 / 25 / 15 —— **跳过了 20% 的「效率提升价值」**。
 *    这是方案原文的顺序，不是笔误，实现时不要「顺手修正」成按权重降序。
 */
const TIEBREAK_WEIGHTS = [30, 25, 15];

/** 奖级名额（《评选方案》评奖）：一等奖 2 名、二等奖 3 名，其余三等奖。 */
const AWARD_QUOTA = [
  { name: '一等奖', count: 2 },
  { name: '二等奖', count: 3 },
];
const LAST_AWARD = '三等奖';

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

/** 最小公倍数。忽略非正数，便于直接喂 keptCount / 票数集合。 */
function lcm(values) {
  let out = 1;
  for (const v of values) {
    if (!Number.isInteger(v) || v <= 0) continue;
    out = (out / gcd(out, v)) * v;
  }
  return out;
}

/**
 * 精确整除（a、b 为非负整数，b > 0）。
 *
 * ⚠️ 不能写成 `Math.floor(a / b)`：a 最大到 ~4.7e12，除法在整数边界上可能落成
 *    `x.9999999`，floor 之后少 1 —— 排名就会悄悄错一位。取余是精确的，先减掉余数再除。
 */
const intDiv = (a, b) => (a - (a % b)) / b;

/** 四舍五入（half-up）num/den 的精确整数结果，num ≥ 0、den > 0。 */
const roundHalfUp = (num, den) => intDiv(2 * num + den, 2 * den);

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
 * 按名次表里的**位置**分配奖级（一等奖 2 名、二等奖 3 名、其余三等奖）。
 * 用位置而不是名次：方案给的是名额数，并列跳号后名次会跳，按名次发会多发。
 */
function awardForPosition(position) {
  let acc = 0;
  for (const q of AWARD_QUOTA) {
    acc += q.count;
    if (position < acc) return q.name;
  }
  return LAST_AWARD;
}

/**
 * @param {object} input
 * @param {Array}  input.rounds      本场活动的**有效场次**（已剔除 superseded），元素：
 *                                   { id, seq, contestantId, contestantSeq,
 *                                     contestantName, contestantProject }
 * @param {Array}  input.dimensions  维度 [{ id, seq, name, weight }]
 * @param {Array<Array<{round_id:number, dimension_id:number, value:number}>>} input.ballots
 *        每张选票一个数组，元素为该票的所有评分行。
 *        一张选票 = 一位评委对**一位演讲者**的一次提交（只属于一场）。
 */
function computeResults({ rounds, dimensions, ballots }) {
  assertWeights(dimensions);

  const roundIds = new Set(rounds.map((r) => r.id));
  const dimIds = new Set(dimensions.map((d) => d.id));

  // 每场一个桶：有效票的加权总分 + 每个维度的原始求和与票数直方图
  const buckets = new Map();
  for (const r of rounds) {
    buckets.set(r.id, { totals: [], rawSum: new Map(), counts: new Map() });
  }

  // 孤儿行：指向不存在的场次或维度、或同一维度重复打分（配置改动后的残留）。
  // 残缺票：没覆盖全部当前维度的选票。两者成因不同，**分开计数**——
  // 前者是「配置对不上」，后者是「票没写全」，混在一起会让人往错的方向查。
  let orphans = 0; // 单位是**行**
  let incomplete = 0; // 单位是**张**

  for (const rows of ballots) {
    if (!rows.length) continue;
    const roundId = rows[0].round_id;

    const bucket = buckets.get(roundId);
    if (!bucket) {
      orphans += rows.length;
      continue;
    }

    const byDim = new Map();
    let orphaned = false;
    for (const s of rows) {
      if (s.round_id !== roundId || !dimIds.has(s.dimension_id) || byDim.has(s.dimension_id)) {
        orphaned = true;
        break;
      }
      byDim.set(s.dimension_id, s.value);
    }
    if (orphaned) {
      orphans += rows.length;
      continue;
    }

    // 一张选票必须**覆盖全部当前维度**才算有效票。
    // 残缺票的加权总分是残的，拿它去和完整票一起排序再「去掉最高最低」，
    // 等于把去分保护用在一个错误的数上。所以整票不计分，单独计数上报。
    if (byDim.size !== dimensions.length) {
      incomplete += 1;
      continue;
    }

    let t = 0;
    for (const d of dimensions) {
      const v = byDim.get(d.id);
      t += d.weight * v; // 方案口径：评委的**加权总分**

      bucket.rawSum.set(d.id, (bucket.rawSum.get(d.id) || 0) + v);

      let c = bucket.counts.get(d.id);
      if (!c) bucket.counts.set(d.id, (c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }));
      c[v] += 1;
    }
    bucket.totals.push(t);
  }

  // 第一遍：每场按评委加权总分去分，定出 keptCount 求 LCM
  const perRound = new Map();
  const keptCounts = new Set();

  for (const r of rounds) {
    const { totals } = buckets.get(r.id);
    const sorted = totals.slice().sort((a, b) => a - b);
    // 恰好去掉一个最低总分和一个最高总分（各一个）。
    // 3 票以下不去分：去分会把票去光，反而丢失全部信息。
    const kept = sorted.length >= 3 ? sorted.slice(1, -1) : sorted;
    const sumKept = kept.reduce((acc, v) => acc + v, 0);

    perRound.set(r.id, { sorted, kept, sumKept });
    if (kept.length > 0) keptCounts.add(kept.length);
  }

  const L = lcm([...keptCounts]);

  // PLAN §6.3 量级证明：评委 ≤20 时 keptCount ∈ [1,20]，L ≤ LCM(1..20) = 2.33e8。
  //   sumKept ≤ 500 × 20 = 10^4；uScaled ≤ 10^4 × 2.33e8 ≈ 2.33e12
  //   2·uScaled + L ≤ 4.7e12  ≪ Number.MAX_SAFE_INTEGER(9.007e15)
  // 超过这个界说明评委人数或票数分布超出了设计前提，宁可拒绝出结果也不要算出
  // 一个悄悄丢精度的排名。
  if (L > LCM_LIMIT) {
    throw new Error(
      `票数分布超出设计上界（LCM=${L} > ${LCM_LIMIT}）。` +
        `本项目按评委人数 ≤ ${MAX_JUDGES} 设计，请检查场次票数是否异常。`
    );
  }

  // 同分顺位用的是**不去分**的原始平均分，分母是各场有效票数 n（不是 keptCount），
  // 所以另立一个缩放基准。上界同样是 LCM(1..20)。
  const Lraw = lcm(rounds.map((r) => buckets.get(r.id).totals.length));
  if (Lraw > LCM_LIMIT) {
    throw new Error(
      `有效票数分布超出设计上界（Lraw=${Lraw} > ${LCM_LIMIT}）。` +
        `本项目按评委人数 ≤ ${MAX_JUDGES} 设计，请检查场次票数是否异常。`
    );
  }

  // 同分顺位①②③：按权重认维度，外加一条④兜底。level 是方案里的顺位号，用于页面提示。
  const chain = TIEBREAK_WEIGHTS.map((w, i) => {
    const d = dimensions.find((x) => x.weight === w);
    return d ? { level: i + 1, weight: w, dimensionId: d.id, name: d.name } : null;
  }).filter(Boolean);
  const keyLevels = [...chain.map((c) => c.level), 4];

  const rows = rounds.map((r) => {
    const bucket = buckets.get(r.id);
    const { sorted, kept, sumKept } = perRound.get(r.id);

    const n = bucket.totals.length;
    const blank = n === 0;
    const keptCount = kept.length;

    const u = keptCount > 0 ? sumKept * (L / keptCount) : 0;
    const score100 = keptCount > 0 ? roundHalfUp(u, L) : null;

    // 每格（场次 × 维度）的**原始**统计 —— 只用于展示与同分顺位，不参与主分
    const dimStats = {};
    const margins = {};
    for (const d of dimensions) {
      const counts = bucket.counts.get(d.id) || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      const rawSum = bucket.rawSum.get(d.id) || 0;
      const rawAvg = n > 0 ? rawSum / n : null;
      dimStats[d.id] = { counts, rawSum, rawAvg };
      margins[d.id] = rawAvg;
    }

    // 同分顺位键：全部精确整数。①②③ 是各维度原始平均分，④ 是全部评委不去分的加权总分。
    // ④ 取的是**平均**而不是总和：n 相同时两者等价，n 不同时比总和会偏袒票多的场次。
    const rawScale = n > 0 ? Lraw / n : 0;
    const keys = chain.map((c) => (bucket.rawSum.get(c.dimensionId) || 0) * rawScale);
    const rawWeightedSum = dimensions.reduce(
      (acc, d) => acc + d.weight * (bucket.rawSum.get(d.id) || 0),
      0
    );
    keys.push(rawWeightedSum * rawScale);

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
      dimStats,
      trim: {
        trimmed: sorted.length >= 3,
        keptCount,
        sumKept,
        // 没去分时（票数 ≤2），这两项就是首尾本身，不代表「被去掉」
        removedLow: sorted.length ? sorted[0] : null,
        removedHigh: sorted.length ? sorted[sorted.length - 1] : null,
        // ⚠️ 判据是**实际收到的票数**（n === 1），**不是**去分后剩下的票数。
        //    3 票去一高一低之后也只剩 1 票，用 keptCount 判断会把 3 票的场次
        //    全标成「仅 1 票」，而票数明明有 3 张。那种情况走 trimmedToOne。
        single: n === 1,
        trimmedToOne: n > 1 && keptCount === 1,
      },
      u: blank ? null : u,
      // 展示与排名同源：total 就是取整后的最终得分
      total: blank ? null : score100 / 100,
      // 未经取整的精确值，只供审计
      totalExact: blank ? null : u / (WEIGHT_TOTAL * L),
      score100,
      keys,
      rank: null,
      tied: false,
      needsVote: false,
      tieBreakLevel: null,
      award: null,
      awardPending: null,
    };
  });

  for (const row of rows) {
    if (row.blank) continue;
    if (!Number.isSafeInteger(row.u)) {
      throw new Error(
        `场次 ${row.roundId} 的加权分超出安全整数范围（u=${row.u}）。` +
          `这是实现缺陷而非数据问题，请检查 LCM 缩放逻辑。`
      );
    }
  }

  // 《评选方案》：按最终得分降序；同分依次比四条顺位；四条全同才是真并列。
  const cmp = (a, b) => {
    if (a.blank !== b.blank) return a.blank ? 1 : -1;
    if (a.blank) return a.seq - b.seq;

    if (a.score100 !== b.score100) return b.score100 - a.score100;
    for (let i = 0; i < a.keys.length; i += 1) {
      if (a.keys[i] !== b.keys[i]) return b.keys[i] - a.keys[i];
    }
    return a.seq - b.seq; // 五元组全同，只按上场顺序稳定显示，名次仍然并列
  };

  const ranked = rows.slice().sort(cmp);

  const sameKey = (a, b) => {
    if (a.score100 !== b.score100 || a.keys.length !== b.keys.length) return false;
    return a.keys.every((k, i) => k === b.keys[i]);
  };

  // 名次：五元组完全相同 → 并列，下一名跳号
  for (let i = 0; i < ranked.length; i += 1) {
    const row = ranked[i];
    if (row.blank) {
      row.rank = null;
      continue;
    }
    const prev = ranked[i - 1];
    if (i > 0 && prev && !prev.blank && sameKey(prev, row)) {
      row.rank = prev.rank;
      row.tied = true;
      prev.tied = true;
    } else {
      row.rank = i + 1;
    }
  }

  // 四条顺位全同 → 第五顺位由评委组无记名投票，系统不代劳，只如实标注
  for (const row of ranked) if (row.tied) row.needsVote = true;

  // 同分但被顺位分开了的行：记下是第几顺位定的。
  // 现场要能解释「两个都显示 4.63，为什么他排前面」——否则看着像排错了。
  const byScore = new Map();
  for (const row of ranked) {
    if (row.blank) continue;
    let g = byScore.get(row.score100);
    if (!g) byScore.set(row.score100, (g = []));
    g.push(row);
  }
  for (const group of byScore.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const other = group.find((o) => o !== row);
      if (!other) continue;
      const at = row.keys.findIndex((k, i) => k !== other.keys[i]);
      row.tieBreakLevel = at === -1 ? null : keyLevels[at];
    }
  }

  // 奖级按名次表里的**位置**分配（一等奖 2 名、二等奖 3 名、其余三等奖）
  const scored = ranked.filter((r) => !r.blank);
  scored.forEach((row, position) => {
    row.award = awardForPosition(position);
  });

  // 跨等平分：某个「四顺位全同」的并列组横跨了奖级边界时，**不替评委组拍板**。
  // 照位置各发一个奖级会凭空替他们做了决定，也会让「一等奖 2 名」的名额落空。
  const pending = new Map();
  for (const row of scored) {
    if (!row.needsVote) continue;
    let g = pending.get(row.rank);
    if (!g) pending.set(row.rank, (g = []));
    g.push(row);
  }
  for (const group of pending.values()) {
    const tiers = [...new Set(group.map((r) => r.award))];
    if (tiers.length < 2) continue; // 没跨等，照常显示
    const label = `${tiers.join(' / ')} 待投票`;
    for (const row of group) row.awardPending = label;
  }

  return {
    rounds: ranked,
    lcm: L,
    lcmRaw: Lraw,
    orphans,
    incomplete,
    insufficient: ranked.every((r) => r.blank),
    tieBreak: chain,
  };
}

/** 展示用：保留 2 位小数的字符串 */
const formatScore = (value) => (value === null || value === undefined ? '—' : value.toFixed(2));

module.exports = {
  computeResults,
  pickEffectiveRounds,
  assertWeights,
  awardForPosition,
  formatScore,
  intDiv,
  roundHalfUp,
  lcm,
  WEIGHT_TOTAL,
  MAX_JUDGES,
  TIEBREAK_WEIGHTS,
  AWARD_QUOTA,
  LAST_AWARD,
};
