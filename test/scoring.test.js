'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeResults } = require('../src/scoring');

/** 便捷构造：matrix[参赛者下标][维度下标] = 该单元格按票序排列的分数 */
function build(matrix) {
  const n = matrix[0][0].length;
  const ballots = [];
  for (let b = 0; b < n; b += 1) {
    const rows = [];
    matrix.forEach((dims, ci) => {
      dims.forEach((values, di) => {
        rows.push({ contestant_id: ci + 1, dimension_id: di + 1, value: values[b] });
      });
    });
    ballots.push(rows);
  }
  return ballots;
}

const contestantsFor = (k) =>
  Array.from({ length: k }, (_, i) => ({ id: i + 1, seq: i + 1, name: `C${i + 1}`, project: 'P' }));

const dims = (weights) =>
  weights.map((w, i) => ({ id: i + 1, seq: i + 1, name: `D${i + 1}`, weight: w }));

test('N=0 → 数据不足，不排名', () => {
  const r = computeResults({ contestants: contestantsFor(2), dimensions: dims([60, 40]), ballots: [] });
  assert.equal(r.n, 0);
  assert.equal(r.insufficient, true);
  assert.equal(r.k, 0);
  r.rows.forEach((row) => {
    assert.equal(row.rank, null);
    assert.equal(row.total, null);
  });
});

test('一律去分：N=5 与 N=6 都去一高一低（保底规则已删除）', () => {
  const matrix5 = [[[1, 2, 3, 4, 5]]];
  const five = computeResults({ contestants: contestantsFor(1), dimensions: dims([100]), ballots: build(matrix5) });
  assert.equal(five.trimmed, true);
  assert.equal(five.k, 3);
  // N=5 → k=3：sorted [1,2,3,4,5] → 切首尾 → [2,3,4] = 9 → U = 900，总分 900/300 = 3.00
  assert.equal(five.rows[0].u, 900);
  assert.equal(five.rows[0].total, 3);
  assert.equal(five.rows[0].margins[1], 3);

  const matrix6 = [[[1, 2, 3, 4, 5, 5]]];
  const six = computeResults({ contestants: contestantsFor(1), dimensions: dims([100]), ballots: build(matrix6) });
  assert.equal(six.trimmed, true);
  assert.equal(six.k, 4);
  // 去分：sorted [1,2,3,4,5,5] → 切首尾 → [2,3,4,5] = 14 → U = 1400，总分 1400/400 = 3.50
  assert.equal(six.rows[0].u, 1400);
  assert.equal(six.rows[0].total, 3.5);
  assert.equal(six.rows[0].margins[1], 3.5);
});

test('边界后果（已确认接受，不做特判）：N=1 全员 0.00；N=2 结果为空；N=3 只剩 1 个分数', () => {
  // N=1 → k = -1，去分后什么都不剩
  const one = computeResults({
    contestants: contestantsFor(2),
    dimensions: dims([100]),
    ballots: build([[[4]], [[5]]]),
  });
  assert.equal(one.k, -1);
  assert.equal(one.trimmed, true);
  assert.ok(one.rows.every((r) => r.u === 0));
  assert.ok(one.rows.every((r) => r.total === 0)); // 0 / -100 得 -0，展示上与 0 等价
  assert.deepEqual(one.rows.map((r) => r.rank), [1, 1]);

  // N=2 → k = 0，0/0 = NaN；JSON 序列化成 null，页面显示「—」
  const two = computeResults({
    contestants: contestantsFor(1),
    dimensions: dims([100]),
    ballots: build([[[4, 5]]]),
  });
  assert.equal(two.k, 0);
  assert.ok(Number.isNaN(two.rows[0].total));
  assert.ok(Number.isNaN(two.rows[0].margins[1]));
  assert.equal(JSON.parse(JSON.stringify({ v: two.rows[0].total })).v, null);

  // N=3 → k = 1，只剩中间那个分数，等于由单个评委决定名次
  const three = computeResults({
    contestants: contestantsFor(1),
    dimensions: dims([100]),
    ballots: build([[[3, 4, 5]]]),
  });
  assert.equal(three.k, 1);
  assert.equal(three.rows[0].margins[1], 4);
  assert.equal(three.rows[0].total, 4);
});

test('手算核对：2 参赛者 × 2 维度（60/40），N=6', () => {
  // 排序后切首尾各一个
  const matrix = [
    [
      [1, 2, 3, 4, 5, 5], // → [2,3,4,5] = 14
      [2, 2, 3, 3, 4, 4], // → [2,3,3,4] = 12
    ],
    [
      [1, 1, 1, 5, 5, 5], // → [1,1,5,5] = 12
      [3, 3, 3, 3, 3, 3], // → [3,3,3,3] = 12
    ],
  ];
  const r = computeResults({ contestants: contestantsFor(2), dimensions: dims([60, 40]), ballots: build(matrix) });

  assert.equal(r.n, 6);
  assert.equal(r.k, 4);

  const [first, second] = r.rows;
  // C1: 60×14 + 40×12 = 1320 → 1320 / (100×4) = 3.30
  assert.equal(first.u, 1320);
  assert.equal(first.total, 3.3);
  assert.equal(first.margins[1], 3.5);
  assert.equal(first.margins[2], 3);
  assert.equal(first.rank, 1);

  // C2: 60×12 + 40×12 = 1200 → 3.00
  assert.equal(second.u, 1200);
  assert.equal(second.total, 3);
  assert.equal(second.margins[1], 3);
  assert.equal(second.rank, 2);
});

test('并列名次跳号：[1, 2, 2, 4]（PLAN §4.5 用例）', () => {
  const matrix = [
    [[1, 2, 3, 4, 5, 5]], // [2,3,4,5] = 14 → 1400
    [[1, 1, 2, 3, 4, 5]], // [1,2,3,4] = 10 → 1000
    [[1, 1, 2, 3, 4, 5]], // 同上   = 10 → 1000
    [[1, 1, 1, 2, 3, 4]], // [1,1,2,3] =  7 →  700
  ];
  const r = computeResults({ contestants: contestantsFor(4), dimensions: dims([100]), ballots: build(matrix) });

  assert.deepEqual(r.rows.map((x) => x.u), [1400, 1000, 1000, 700]);
  assert.deepEqual(r.rows.map((x) => x.rank), [1, 2, 2, 4]);
  // 展示同分的人，总分也必须完全相等（整数比较，无浮点误差）
  assert.equal(r.rows[1].total, r.rows[2].total);
});

test('全部并列 → 所有人名次都是 1', () => {
  const same = [3, 3, 3, 3, 3, 4];
  const r = computeResults({
    contestants: contestantsFor(3),
    dimensions: dims([100]),
    ballots: build([[same], [same], [same]]),
  });
  assert.deepEqual(r.rows.map((x) => x.rank), [1, 1, 1]);
});

test('单元格票数不等于 N → 抛错（弃权约束被破坏）', () => {
  const ballots = build([[[1, 2, 3, 4, 5, 5]]]);
  ballots[0] = ballots[0].slice(0, 0); // 人为抽掉一张票的部分数据
  assert.throws(
    () => computeResults({ contestants: contestantsFor(1), dimensions: dims([100]), ballots }),
    /数据不一致/
  );
});

test('权重合计不等于 100 → 抛错；权重非整数 → 抛错', () => {
  const ballots = build([[[3, 3, 3, 3, 3, 3]]]);
  assert.throws(
    () => computeResults({ contestants: contestantsFor(1), dimensions: dims([60, 30]), ballots }),
    /合计必须等于 100/
  );
  assert.throws(
    () =>
      computeResults({
        contestants: contestantsFor(1),
        dimensions: [{ id: 1, seq: 1, name: 'D1', weight: 100.5 }],
        ballots,
      }),
    /必须是整数/
  );
});
