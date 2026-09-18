'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeResults,
  pickEffectiveRounds,
  formatScore,
  intDiv,
  roundHalfUp,
  awardForPosition,
  TIEBREAK_WEIGHTS,
} = require('../src/scoring');

/**
 * 便捷构造。
 *
 * @param {Array} specs 每场一个：{ scores, contestantId?, name? }
 *        scores[维度下标][票序号] = 分数。每场的票数 = scores[0].length。
 *        各场的票数**可以不同** —— 这正是自适应去分要处理的情况。
 * @param {Array<number>} weights 各维度权重，合计须为 100
 */
function scene(specs, weights) {
  const dimensions = weights.map((w, i) => ({ id: i + 1, seq: i + 1, name: `D${i + 1}`, weight: w }));

  const rounds = specs.map((s, i) => ({
    id: i + 1,
    seq: i + 1,
    contestantId: s.contestantId === undefined ? i + 1 : s.contestantId,
    contestantSeq: i + 1,
    contestantName: s.name || `C${i + 1}`,
    contestantProject: 'P',
  }));

  const ballots = [];
  specs.forEach((s, i) => {
    const roundId = i + 1;
    const n = s.scores[0].length;
    for (let b = 0; b < n; b += 1) {
      ballots.push(
        s.scores.map((dim, di) => ({ round_id: roundId, dimension_id: di + 1, value: dim[b] }))
      );
    }
  });

  return { rounds, dimensions, ballots };
}

/** 《评选方案》默认的五个维度与权重 */
const W5 = [30, 25, 20, 15, 10];

/** 按 roundId 取行（r.rounds 已按名次排过，下标不可靠） */
const byId = (r, id) => r.rounds.find((x) => x.roundId === id);

/* ------------------------------ 精确整数 ------------------------------ */

test('intDiv / roundHalfUp：整除与四舍五入都用整数算，不经过浮点', () => {
  assert.equal(intDiv(80380, 760), 105);
  assert.equal(intDiv(80180, 760), 105);

  assert.equal(roundHalfUp(205, 2), 103); // 102.5 → 进位
  assert.equal(roundHalfUp(204, 2), 102);
  assert.equal(roundHalfUp(5, 2), 3); // 2.5 → 进位
  assert.equal(roundHalfUp(1, 2), 1); // 0.5 → 进位
  assert.equal(roundHalfUp(0, 2), 0);

  // 这就是不能写 `Math.round(x * 100)` 的理由：浮点会把 1.005 判成 100 而不是 101，
  // 一场比赛里出现一次就是名次错位。
  assert.equal(Math.round(1.005 * 100), 100);
  assert.equal(roundHalfUp(1005, 10), 101);
});

/* --------------------------- 按评委总分去分 --------------------------- */

test('自适应去分：按**评委加权总分**去一高一低，n=1/2/3/5/6', () => {
  const one = computeResults(scene([{ scores: [[4]] }], [100]));
  const r1 = one.rounds[0];
  assert.equal(r1.n, 1);
  assert.equal(r1.trim.keptCount, 1);
  assert.equal(r1.trim.trimmed, false);
  assert.equal(r1.trim.single, true); // 真的只有 1 票 → 页面标「仅 1 票」
  assert.equal(r1.trim.trimmedToOne, false);
  assert.equal(r1.margins[1], 4); // 原始平均分：不去分，直接用
  assert.equal(r1.total, 4);

  const two = computeResults(scene([{ scores: [[4, 5]] }], [100]));
  const r2 = two.rounds[0];
  assert.equal(r2.n, 2);
  assert.equal(r2.trim.keptCount, 2);
  assert.equal(r2.trim.trimmed, false);
  assert.equal(r2.margins[1], 4.5);
  assert.equal(r2.total, 4.5);
  assert.equal(r2.thin, true);

  const three = computeResults(scene([{ scores: [[4, 5, 5]] }], [100]));
  const r3 = three.rounds[0];
  assert.equal(r3.trim.keptCount, 1);
  assert.equal(r3.trim.trimmed, true);
  assert.equal(r3.total, 5); // 总分 [400,500,500] 去首尾 → 500
  // 原始平均分是三个分数的平均，与去分无关
  assert.equal(r3.margins[1], 14 / 3);
  assert.equal(r3.trim.trimmedToOne, true);

  const five = computeResults(scene([{ scores: [[1, 2, 3, 4, 5]] }], [100]));
  const r5 = five.rounds[0];
  assert.equal(r5.trim.keptCount, 3);
  assert.equal(r5.margins[1], 3); // 原始平均分 (1+2+3+4+5)/5
  assert.equal(r5.u, 900);
  assert.equal(r5.score100, 300);
  assert.equal(r5.total, 3);

  const six = computeResults(scene([{ scores: [[1, 2, 3, 4, 5, 5]] }], [100]));
  const r6 = six.rounds[0];
  assert.equal(r6.trim.keptCount, 4);
  assert.equal(r6.margins[1], 20 / 6); // 原始平均分
  assert.equal(r6.u, 1400);
  assert.equal(r6.score100, 350);
  assert.equal(r6.total, 3.5);
});

test('★ 回归：single 必须按「实际收到的票数」判断，不能按「去分后剩几票」', () => {
  // 曾经的 bug：`single: keptCount === 1`。
  // 3 位评委去一高一低之后正好剩 1 票，于是每一格都被标成「仅 1 票」——
  // 票数明明有 3 张，界面在说谎。判据必须是实际收到的票数，不是 keptCount。
  const cases = [
    { n: 1, votes: [4], single: true, trimmedToOne: false, keptCount: 1 },
    { n: 2, votes: [4, 5], single: false, trimmedToOne: false, keptCount: 2 },
    { n: 3, votes: [4, 5, 5], single: false, trimmedToOne: true, keptCount: 1 },
    { n: 4, votes: [4, 4, 5, 5], single: false, trimmedToOne: false, keptCount: 2 },
    { n: 5, votes: [3, 4, 4, 5, 5], single: false, trimmedToOne: false, keptCount: 3 },
    { n: 6, votes: [3, 4, 4, 5, 5, 5], single: false, trimmedToOne: false, keptCount: 4 },
  ];

  for (const c of cases) {
    const r = computeResults(scene([{ scores: [c.votes] }], [100]));
    const t = r.rounds[0].trim;
    assert.equal(r.rounds[0].n, c.n, `${c.n} 票的 n`);
    assert.equal(t.keptCount, c.keptCount, `${c.n} 票的 keptCount`);
    assert.equal(t.single, c.single, `${c.n} 票的 single（只有 1 票才是 true）`);
    assert.equal(t.trimmedToOne, c.trimmedToOne, `${c.n} 票的 trimmedToOne`);
  }
});

test('★ 去分的单位是**评委总分**，不是每个维度格子', () => {
  // 4 位评委，权重 50/50，每人给 (维度1, 维度2)：
  //   J1=(5,1) J2=(4,4) J3=(1,5) J4=(1,1)
  //
  // 新口径（按评委加权总分）：总分 [100,300,300,400] → 去掉 100 与 400 →
  //   留下 J1、J3 → (300+300)/2/100 = 3.00
  //
  // 旧口径（每个维度各自去一高一低）：
  //   维度1 [5,4,1,1] → 去掉 5 与 1 → [1,4] 和=5
  //   维度2 [1,4,5,1] → 去掉 5 与 1 → [1,4] 和=5
  //   → (50×5 + 50×5)/2/100 = 2.50
  //
  // 两者差 0.5 —— 这就是本次改口径必须做的证据。
  // 注意：两者只有在「某一位评委在所有维度上同时最低、另一位同时最高」时才恰好相等，
  // 那是特例不是通例，下面的断言把这个差异钉死。
  const r = computeResults(scene([{ scores: [[5, 4, 1, 1], [1, 4, 5, 1]] }], [50, 50]));

  assert.equal(r.rounds[0].trim.keptCount, 2);
  assert.equal(r.rounds[0].trim.sumKept, 600);
  assert.equal(r.rounds[0].total, 3); // 旧口径会是 2.5
  assert.equal(r.rounds[0].margins[1], 11 / 4); // 原始平均分，不去分
  assert.equal(r.rounds[0].margins[2], 11 / 4);
});

test('★ 跨场次混合去分：11 票与 2 票同场竞技，L = LCM(9,2) = 18', () => {
  const r = computeResults(
    scene([{ scores: [[1, 2, 3, 3, 3, 3, 3, 4, 5, 5, 5]] }, { scores: [[4, 5]] }], [100])
  );

  const eleven = byId(r, 1);
  const two = byId(r, 2);

  assert.equal(r.lcm, 18);
  assert.equal(eleven.trim.keptCount, 9);
  assert.equal(two.trim.keptCount, 2);

  // 缩放后两边分母都是 18
  assert.equal(eleven.u, 100 * 31 * (18 / 9)); // 6200
  assert.equal(two.u, 100 * 9 * (18 / 2)); // 8100

  assert.ok(r.rounds.every((x) => Number.isSafeInteger(x.u)));

  // total 是**四舍五入后的最终得分**，精确值另存在 totalExact
  assert.equal(eleven.totalExact, 6200 / 1800);
  assert.equal(eleven.score100, 344); // roundHalfUp(6200, 18)
  assert.equal(eleven.total, 3.44);
  assert.equal(two.total, 4.5);

  // 2 票的那场反而分高，排名第 1
  assert.deepEqual(r.rounds.map((x) => x.name), ['C2', 'C1']);
  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 2]);
});

test('溢出上界：keptCount 覆盖 1..20 时 L 达到 2.33e8，u 仍是安全整数', () => {
  // 20 场，keptCount 分别取 1..20 —— n=1,2 时不去分，n≥3 时 keptCount = n-2
  const specs = [];
  for (let k = 1; k <= 20; k += 1) {
    const n = k <= 2 ? k : k + 2;
    specs.push({ scores: [new Array(n).fill(5)] });
  }

  const r = computeResults(scene(specs, [100]));

  assert.equal(r.lcm, 232792560); // LCM(1..20)
  assert.equal(r.lcmRaw, 232792560); // 票数同样是 1..22，质因子已被覆盖
  assert.ok(r.lcm * 500 <= Number.MAX_SAFE_INTEGER);
  for (const row of r.rounds) {
    assert.ok(Number.isSafeInteger(row.u), `场次 ${row.roundId} 的 u=${row.u} 不是安全整数`);
    assert.ok(Number.isSafeInteger(row.score100));
    assert.ok(row.keys.every((k) => Number.isSafeInteger(k)), '顺位键必须是安全整数');
  }
});

/* --------------------------- 最终得分与同分 --------------------------- */

test('★ 最终得分四舍五入到 2 位小数：取整后相同即同分，交给顺位分高下', () => {
  // 第 1 场 21 票 → keptCount 19，kept 总分和 = 2000
  // 第 2 场 22 票 → keptCount 20，kept 总分和 = 2100
  // L = LCM(19,20) = 380
  //   u1 = 2000 × 20 = 40000  → 40000/380 = 105.263…  → 105
  //   u2 = 2100 × 19 = 39900  → 39900/380 = 105.0     → 105
  const a = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 5]; // 21 个
  const b = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 5]; // 22 个

  const r = computeResults(scene([{ scores: [a] }, { scores: [b] }], [100]));

  assert.equal(r.lcm, 380);
  assert.equal(r.rounds[0].u, 40000);
  assert.equal(r.rounds[1].u, 39900);

  // ⚠️ 与旧实现相反：旧实现靠未取整的整数 u 把两者分开；
  //    新口径按方案「四舍五入保留 2 位小数」排名，两者都是 1.05 → **同分**。
  assert.equal(r.rounds[0].score100, 105);
  assert.equal(r.rounds[1].score100, 105);
  assert.equal(r.rounds[0].total, 1.05);
  assert.equal(r.rounds[1].total, 1.05);
  assert.notEqual(r.rounds[0].u, r.rounds[1].u); // 精确值仍不同，但不再决定名次

  // 名次靠顺位分出来。本场权重是 [100]，没有 30/25/15 的维度，
  // ①②③ 全部跳过，由第四顺位「全部评委不去分的加权总分」定高下。
  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 2]);
  assert.deepEqual(r.rounds.map((x) => x.tieBreakLevel), [4, 4]);
  assert.ok(r.rounds.every((x) => x.tied === false && x.needsVote === false));
});

test('顺位①②③ 按权重 30 / 25 / 15 取维度，**刻意跳过 20% 的「效率提升价值」**', () => {
  assert.deepEqual(TIEBREAK_WEIGHTS, [30, 25, 15]);

  const r = computeResults(scene([{ scores: [[4], [4], [4], [4], [4]] }], W5));
  assert.deepEqual(
    r.tieBreak.map((c) => `${c.level}:${c.weight}:${c.name}`),
    ['1:30:D1', '2:25:D2', '3:15:D4'] // 注意是 D4，不是 20% 的 D3
  );
  assert.ok(!r.tieBreak.some((c) => c.weight === 20), '20% 的维度不得出现在顺位链里');
});

test('★ 同分顺位：总分相同，依次比 ①②③④', () => {
  // 基准场：两位评委都给 (4,4,4,4,4) → 总分 [400,400]，最终得分 4.00
  const base = [[4, 4], [4, 4], [4, 4], [4, 4], [4, 4]]; // 维度为行、评委为列

  // 每一场都构造成「总分和 = 800、最终得分 = 4.00」，只在该顺位对应的维度上不同，
  // 于是只有目标顺位能分出高下 —— 用例本身即是「顺位是唯一判据」的证明。
  const cases = [
    // 评委 (5,4,4,4,4) 与 (4,4,4,2,4)：总分 430 + 370
    { level: 1, why: '契合度(30%) 原始均分 9 > 8', scores: [[5, 4], [4, 4], [4, 4], [4, 2], [4, 4]] },
    // 评委 (4,5,4,3,5) 与 (4,4,3,4,4)：总分 420 + 380
    { level: 2, why: '复用价值(25%) 原始均分 9 > 8', scores: [[4, 4], [5, 4], [4, 3], [3, 4], [5, 4]] },
    // 评委 (4,4,3,5,4) 与 (4,4,4,5,3)：总分 395 + 405
    { level: 3, why: '完整性(15%) 原始均分 10 > 8', scores: [[4, 4], [4, 4], [3, 4], [5, 5], [4, 3]] },
  ];

  for (const c of cases) {
    const r = computeResults(scene([{ scores: base }, { scores: c.scores }], W5));
    const a = byId(r, 1);
    const b = byId(r, 2);

    assert.equal(a.score100, b.score100, `顺位${c.level}：两场最终得分必须相同`);
    assert.equal(b.rank, 1, `顺位${c.level}：挑战场应当排第 1（${c.why}）`);
    assert.equal(b.tieBreakLevel, c.level, `顺位${c.level}：应当由第 ${c.level} 顺位判定`);
    assert.equal(a.rank, 2);
    assert.ok(!a.needsVote && !b.needsVote, '被顺位分开了就不该再标「待投票」');
  }
});

test('★ 同分顺位④：前三顺位全同，比全部评委不去分的加权总分', () => {
  // 两场都是 4 位评委，去首尾后留下的都是中间两位、总分和都是 800 → 最终得分都是 4.00。
  // 差异只在被去掉的那张票上：A 的极值票总分 100+500=600，B 是 100+480=580。
  // 前三顺位看的 30/25/15 三个维度原始均分都是 14，分不出来，落到第四顺位。
  const A = [[1, 4, 4, 5], [1, 4, 4, 5], [1, 4, 4, 5], [1, 4, 4, 5], [1, 4, 4, 5]];
  const B = [[5, 4, 4, 1], [5, 4, 4, 1], [5, 4, 4, 1], [5, 4, 4, 1], [3, 4, 4, 1]];

  const r = computeResults(scene([{ scores: A }, { scores: B }], W5));
  const a = byId(r, 1);
  const b = byId(r, 2);

  assert.equal(a.score100, 400);
  assert.equal(b.score100, 400);
  assert.equal(a.trim.sumKept, b.trim.sumKept); // 前三顺位判据完全相同
  assert.deepEqual(a.keys.slice(0, 3), b.keys.slice(0, 3));

  assert.equal(a.keys[3] > b.keys[3], true, '第四顺位：A 的不去分加权总分更高');
  assert.equal(a.rank, 1);
  assert.equal(a.tieBreakLevel, 4);
  assert.equal(b.tieBreakLevel, 4);
});

test('★ 四顺位全同 → 并列 + needsVote（第五顺位由评委组投票，系统不代劳）', () => {
  // 两场的分数分布不同，但最终得分与四条顺位判据**完全**相同：
  //   A: 两位评委都 (4,4,4,4,4)
  //   B: (5,3,4,4,4) 与 (3,5,4,4,4) —— 30% 与 25% 两个维度上互相交换，其余相同
  const A = [[4, 4], [4, 4], [4, 4], [4, 4], [4, 4]];
  const B = [[5, 3], [3, 5], [4, 4], [4, 4], [4, 4]];
  const C = [[2, 2], [2, 2], [2, 2], [2, 2], [2, 2]];

  const r = computeResults(scene([{ scores: A }, { scores: B }], W5));

  for (const row of r.rounds) {
    assert.equal(row.score100, 400);
    assert.equal(row.rank, 1, '四条顺位全同 → 真并列');
    assert.equal(row.tied, true);
    assert.equal(row.needsVote, true, '必须标出「待评委组投票」，不能悄悄按上场顺序定名次');
    assert.equal(row.tieBreakLevel, null);
  }
  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 1]);

  // 并列、下一名跳号：加一场低分的，名次应当跳到 3
  const r2 = computeResults(scene([{ scores: A }, { scores: B }, { scores: C }], W5));
  assert.deepEqual(r2.rounds.map((x) => x.rank), [1, 1, 3]);
});

test('★ 奖级：按名次表里的位置分配，一等奖 2 名、二等奖 3 名、其余三等奖', () => {
  assert.equal(awardForPosition(0), '一等奖');
  assert.equal(awardForPosition(1), '一等奖');
  assert.equal(awardForPosition(2), '二等奖');
  assert.equal(awardForPosition(4), '二等奖');
  assert.equal(awardForPosition(5), '三等奖');
  assert.equal(awardForPosition(99), '三等奖');

  // 7 场，两位评委都给 (x, y)，x+y 从 10 递减到 4 → 最终得分 5.00 … 2.00，严格递减
  const specs = [];
  for (let sum = 10; sum >= 4; sum -= 1) {
    const x = Math.min(5, sum - 1);
    const y = sum - x;
    specs.push({ scores: [[x, x], [y, y]] });
  }
  const r = computeResults(scene(specs, [50, 50]));

  assert.deepEqual(
    r.rounds.map((x) => x.score100),
    [500, 450, 400, 350, 300, 250, 200]
  );
  assert.deepEqual(
    r.rounds.map((x) => x.rank),
    [1, 2, 3, 4, 5, 6, 7]
  );
  assert.deepEqual(
    r.rounds.map((x) => x.award),
    ['一等奖', '一等奖', '二等奖', '二等奖', '二等奖', '三等奖', '三等奖']
  );
  assert.ok(r.rounds.every((x) => x.awardPending === null));
});

test('★ 跨等平分：并列组横跨奖级边界时，不替评委组拍板', () => {
  // 名次 1 / 2 / 2 / 4 → 位置 0/1/2/3
  //   位置 0 → 一等奖，位置 1 → 一等奖，位置 2 → 二等奖
  // 并列的第 2 名横跨「一等奖/二等奖」边界，必须标成待投票，而不是各发一个奖。
  const five = (s) => [[s, s], [s, s], [s, s], [s, s], [s, s]];
  const r = computeResults(
    scene([{ scores: five(5) }, { scores: five(4) }, { scores: five(4) }, { scores: five(3) }], W5)
  );

  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 2, 2, 4]);
  assert.equal(byId(r, 1).award, '一等奖');
  assert.equal(byId(r, 1).awardPending, null);

  for (const row of [byId(r, 2), byId(r, 3)]) {
    assert.equal(row.needsVote, true);
    assert.equal(row.awardPending, '一等奖 / 二等奖 待投票');
  }
  assert.equal(byId(r, 4).award, '二等奖'); // 边界之后照常
  assert.equal(byId(r, 4).awardPending, null);
});

/* ------------------------------ 弃权与空白 ------------------------------ */

test('弃权：某场少一张票不影响其它场次，且不抛错', () => {
  const r = computeResults(
    scene(
      [
        { scores: [[1, 2, 3, 4, 5]] }, // 5 票
        { scores: [[1, 2, 3, 4]] }, //    4 票 —— 有人没交
        { scores: [[1, 2, 3, 4, 5]] }, // 5 票
      ],
      [100]
    )
  );

  assert.deepEqual(r.rounds.map((x) => x.n).sort(), [4, 5, 5]);
  assert.equal(byId(r, 2).trim.keptCount, 2);
  assert.equal(byId(r, 1).trim.keptCount, 3);
  assert.equal(r.orphans, 0);
  assert.equal(r.incomplete, 0);
});

test('空白场次：0 票 → blank，排末尾，不阻塞其它场次出结果', () => {
  const r = computeResults(scene([{ scores: [[1, 2, 3, 4, 5]] }, { scores: [[]] }], [100]));

  const blankRow = byId(r, 2);
  assert.equal(blankRow.blank, true);
  assert.equal(blankRow.total, null);
  assert.equal(blankRow.rank, null);
  assert.equal(blankRow.score100, null);
  assert.equal(blankRow.award, null);
  // 空白场次不得在顺位键里产生 NaN / Infinity —— 那会让整个结果页 500
  assert.ok(blankRow.keys.every((k) => Number.isSafeInteger(k)), 'blank 的顺位键必须是安全整数');
  assert.equal(r.rounds[1].roundId, 2); // 排在最后
  assert.equal(r.insufficient, false);
  assert.equal(r.rounds[0].rank, 1);
});

test('全部场次都空白 → insufficient', () => {
  const r = computeResults(scene([{ scores: [[]] }, { scores: [[]] }], [100]));
  assert.equal(r.insufficient, true);
  assert.ok(r.rounds.every((x) => x.rank === null && x.total === null));
});

test('孤儿行：指向不存在的场次 → 计入 orphans，不抛错、不影响排名', () => {
  const built = scene([{ scores: [[1, 2, 3, 4, 5]] }], [100]);
  built.ballots.push([{ round_id: 999, dimension_id: 1, value: 5 }]);

  const r = computeResults(built);
  assert.equal(r.orphans, 1);
  assert.equal(r.rounds[0].n, 5);
  assert.equal(r.rounds[0].rank, 1);
});

test('★ 残缺票：没写全维度的选票不计分，且单独计数、不混进 orphans', () => {
  // 按评委总分去分要求每张票的总分是完整的。残缺票的总分是残的，
  // 拿去和完整票一起排序再「去掉最高最低」，等于把去分保护用在一个错误的数上。
  const built = scene([{ scores: [[4, 4, 4], [2, 2, 2], [3, 3, 3]] }], [30, 30, 40]);
  built.ballots.push([{ round_id: 1, dimension_id: 1, value: 5 }]); // 只写了 1 个维度

  const r = computeResults(built);
  assert.equal(r.rounds[0].n, 3, '残缺票不计入有效票数');
  assert.equal(r.incomplete, 1, '残缺票单独计数');
  assert.equal(r.orphans, 0, '残缺票不是「孤儿行」，两者成因不同');
});

/* ------------------------------ 并列与重开 ------------------------------ */

test('并列名次跳号：[1, 2, 2, 4]', () => {
  const r = computeResults(
    scene(
      [
        { scores: [[1, 2, 3, 4, 5, 5]] }, // [2,3,4,5] = 14
        { scores: [[1, 1, 2, 3, 4, 5]] }, // [1,2,3,4] = 10
        { scores: [[1, 1, 2, 3, 4, 5]] }, // [1,2,3,4] = 10
        { scores: [[1, 1, 1, 2, 3, 4]] }, // [1,1,2,3] =  7
      ],
      [100]
    )
  );

  assert.deepEqual(r.rounds.map((x) => x.u), [1400, 1000, 1000, 700]);
  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 2, 2, 4]);
  assert.equal(r.rounds[1].total, r.rounds[2].total);

  // 第 2、3 场原始分布完全相同 → 四条顺位也分不开 → 真并列，待评委组投票
  assert.equal(r.rounds[1].needsVote, true);
  assert.equal(r.rounds[2].needsVote, true);
  assert.equal(r.rounds[0].needsVote, false);
});

test('pickEffectiveRounds：同一演讲者只保留 seq 最大的那一场', () => {
  const rounds = [
    { id: 1, contestantId: 7, seq: 3 },
    { id: 2, contestantId: 7, seq: 8 }, // 重开后的那场
    { id: 3, contestantId: 9, seq: 4 },
  ];

  const { effective, supersededIds } = pickEffectiveRounds(rounds);
  assert.deepEqual(effective.map((r) => r.id), [3, 2]);
  assert.deepEqual([...supersededIds], [1]);
});

/* ------------------------------ 参数校验 ------------------------------ */

test('权重合计不等于 100 → 抛错；权重非整数 → 抛错', () => {
  const built = scene([{ scores: [[3, 3, 3, 3, 3, 3]] }], [100]);
  assert.throws(
    () => computeResults({ ...built, dimensions: [{ id: 1, seq: 1, name: 'D1', weight: 60 }] }),
    /合计必须等于 100/
  );
  assert.throws(
    () =>
      computeResults({
        ...built,
        dimensions: [{ id: 1, seq: 1, name: 'D1', weight: 100.5 }],
      }),
    /必须是整数/
  );
});

test('维度为空 → 抛错', () => {
  assert.throws(() => computeResults({ rounds: [], dimensions: [], ballots: [] }), /维度为空/);
});

test('票数分布超出上界 → 拒绝出结果而不是悄悄丢精度', () => {
  // 必须是 23：21 = 3×7、22 = 2×11 的质因子 LCM(1..20) 里都已经有了，
  // 所以 LCM(1..21) 和 LCM(1..22) 仍等于 2.33e8，只有 23 这个新质数才会把 L 顶上去
  const specs = [];
  for (let k = 1; k <= 23; k += 1) {
    const n = k <= 2 ? k : k + 2;
    specs.push({ scores: [new Array(n).fill(5)] });
  }

  assert.throws(() => computeResults(scene(specs, [100])), /超出设计上界/);
});
