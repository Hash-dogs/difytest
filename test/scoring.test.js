'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeResults, pickEffectiveRounds, formatScore } = require('../src/scoring');

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

/* ------------------------------ 自适应去分 ------------------------------ */

test('自适应去分：n=1/2/3/5/6 各自的 keptCount 与 margin', () => {
  const one = computeResults(scene([{ scores: [[4]] }], [100]));
  const r1 = one.rounds[0];
  assert.equal(r1.n, 1);
  assert.equal(r1.details[1].keptCount, 1);
  assert.equal(r1.details[1].trimmed, false);
  assert.equal(r1.details[1].single, true); // 只有 1 票 → 页面必须标「仅 1 票」
  assert.equal(r1.margins[1], 4); // 旧实现这里会算出 0.00，现在直接用
  assert.equal(r1.total, 4);

  const two = computeResults(scene([{ scores: [[4, 5]] }], [100]));
  const r2 = two.rounds[0];
  assert.equal(r2.n, 2);
  assert.equal(r2.details[1].keptCount, 2);
  assert.equal(r2.details[1].trimmed, false);
  assert.equal(r2.margins[1], 4.5); // 旧实现这里是 NaN，现在取平均
  assert.equal(r2.total, 4.5);
  assert.equal(r2.thin, true);

  const three = computeResults(scene([{ scores: [[4, 5, 5]] }], [100]));
  const r3 = three.rounds[0];
  assert.equal(r3.details[1].keptCount, 1);
  assert.equal(r3.details[1].trimmed, true);
  assert.equal(r3.margins[1], 5); // 去 4 和 5，剩 5

  const five = computeResults(scene([{ scores: [[1, 2, 3, 4, 5]] }], [100]));
  const r5 = five.rounds[0];
  assert.equal(r5.details[1].keptCount, 3);
  assert.equal(r5.margins[1], 3); // [2,3,4] = 9 / 3
  assert.equal(r5.u, 900);
  assert.equal(r5.total, 3);

  const six = computeResults(scene([{ scores: [[1, 2, 3, 4, 5, 5]] }], [100]));
  const r6 = six.rounds[0];
  assert.equal(r6.details[1].keptCount, 4);
  assert.equal(r6.margins[1], 3.5); // [2,3,4,5] = 14 / 4
  assert.equal(r6.u, 1400);
  assert.equal(r6.total, 3.5);
});

test('★ 跨场次混合去分：11 票与 2 票同场竞技，L = LCM(9,2) = 18', () => {
  // 第 1 场 11 票：sorted [1,2,3,3,3,3,3,4,5,5,5] → 去首尾 → 9 个，和 = 31
  // 第 2 场  2 票：不去分 → [4,5]，和 = 9，keptCount = 2
  const r = computeResults(
    scene(
      [
        { scores: [[1, 2, 3, 3, 3, 3, 3, 4, 5, 5, 5]] },
        { scores: [[4, 5]] },
      ],
      [100]
    )
  );

  // 注意 r.rounds 已按分数降序，用 roundId 取而不是下标
  const eleven = r.rounds.find((x) => x.roundId === 1);
  const two = r.rounds.find((x) => x.roundId === 2);

  assert.equal(r.lcm, 18);
  assert.equal(eleven.details[1].keptCount, 9);
  assert.equal(two.details[1].keptCount, 2);

  // 缩放后两边分母都是 18
  assert.equal(eleven.u, 100 * 31 * (18 / 9)); // 6200
  assert.equal(two.u, 100 * 9 * (18 / 2)); // 8100

  assert.ok(r.rounds.every((x) => Number.isSafeInteger(x.u)));
  assert.equal(eleven.total, 6200 / 1800);
  assert.equal(two.total, 4.5);

  // 2 票的那场反而分高，排名第 1
  assert.deepEqual(r.rounds.map((x) => x.name), ['C2', 'C1']);
  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 2]);
});

test('★ 浮点陷阱：显示相同（都是 1.05）但整数 u 不同 → 名次必须分开', () => {
  // 第 1 场 21 票 → keptCount 19，kept 和 = 20
  // 第 2 场 22 票 → keptCount 20，kept 和 = 21
  // L = LCM(19,20) = 380
  //   u1 = 100 × 20 × 20 = 40000  → 40000/38000 = 1.052631…  → toFixed(2) = "1.05"
  //   u2 = 100 × 21 × 19 = 39900  → 39900/38000 = 1.05        → toFixed(2) = "1.05"
  const a = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 5]; // 21 个
  const b = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 5]; // 22 个

  const r = computeResults(scene([{ scores: [a] }, { scores: [b] }], [100]));

  assert.equal(r.lcm, 380);
  assert.equal(r.rounds[0].u, 40000);
  assert.equal(r.rounds[1].u, 39900);

  // 展示层看不出差别……
  assert.equal(formatScore(r.rounds[0].total), '1.05');
  assert.equal(formatScore(r.rounds[1].total), '1.05');

  // ……但名次必须分开。这正是 PLAN §6.3 坚持用整数比较的理由。
  assert.notEqual(r.rounds[0].u, r.rounds[1].u);
  assert.deepEqual(r.rounds.map((x) => x.rank), [1, 2]);
});

test('★ 退化等价：所有场次票数相同时，新公式精确等于旧公式 Σ(w×sum)', () => {
  // 旧实现：k 是常数，U = Σ_d (w_d × sum_d)
  // 新实现：L = k，每项乘 (L/keptCount) = 1 → 同一个值
  const r = computeResults(
    scene(
      [
        { scores: [[1, 2, 3, 4, 5, 5], [2, 2, 3, 3, 4, 4]] },
        { scores: [[1, 1, 1, 5, 5, 5], [3, 3, 3, 3, 3, 3]] },
      ],
      [60, 40]
    )
  );

  assert.equal(r.lcm, 4); // 都是 6 票 → keptCount 4
  assert.equal(r.rounds[0].u, 60 * 14 + 40 * 12); // 1320
  assert.equal(r.rounds[0].total, 3.3);
  assert.equal(r.rounds[1].u, 60 * 12 + 40 * 12); // 1200
  assert.equal(r.rounds[1].total, 3);
});

test('溢出上界：keptCount 覆盖 1..20 时 L 达到 2.33e8，u 仍是安全整数', () => {
  // 20 场，keptCount 分别取 1..20 —— n=1,2 时不去分，n≥3 时 keptCount = n-2
  //   要拿到 keptCount = k，取 n = k（k ≤ 2）或 n = k + 2（k ≥ 3）
  const specs = [];
  for (let k = 1; k <= 20; k += 1) {
    const n = k <= 2 ? k : k + 2;
    // 全部给 5 分，把 u 推到可能的最大值
    specs.push({ scores: [new Array(n).fill(5)] });
  }

  const r = computeResults(scene(specs, [100]));

  assert.equal(r.lcm, 232792560); // LCM(1..20)
  assert.ok(r.lcm * 500 <= Number.MAX_SAFE_INTEGER);
  for (const row of r.rounds) {
    assert.ok(Number.isSafeInteger(row.u), `场次 ${row.roundId} 的 u=${row.u} 不是安全整数`);
    assert.ok(row.u > 0);
  }
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
  assert.equal(r.rounds.find((x) => x.roundId === 2).details[1].keptCount, 2);
  assert.equal(r.rounds.find((x) => x.roundId === 1).details[1].keptCount, 3);
  assert.equal(r.orphans, 0);
});

test('空白场次：0 票 → blank，排末尾，不阻塞其它场次出结果', () => {
  const r = computeResults(
    scene([{ scores: [[1, 2, 3, 4, 5]] }, { scores: [[]] }], [100])
  );

  const blankRow = r.rounds.find((x) => x.roundId === 2);
  assert.equal(blankRow.blank, true);
  assert.equal(blankRow.total, null);
  assert.equal(blankRow.rank, null);
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
});

test('pickEffectiveRounds：同一演讲者只保留 seq 最大的那一场', () => {
  const rounds = [
    { id: 1, contestantId: 7, seq: 3 },
    { id: 2, contestantId: 7, seq: 8 }, // 重开后的那场
    { id: 3, contestantId: 9, seq: 4 },
  ];

  const { effective, supersededIds } = pickEffectiveRounds(rounds);

  assert.deepEqual(effective.map((r) => r.id), [3, 2]); // 按 seq 排序：9→4，7→8
  assert.deepEqual([...supersededIds], [1]);
  assert.ok(!effective.some((r) => r.id === 1));
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
  assert.throws(
    () => computeResults({ rounds: [], dimensions: [], ballots: [] }),
    /维度为空/
  );
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
