'use strict';

/**
 * 评委端状态机（PLAN §7.2 / §7.3）。
 *
 * 七种屏幕，全部由 `/api/v/<code>/state` 的返回驱动：
 *   loading   正在加载
 *   blocked   登录码无效 / 已作废 / 投票已结束 / 连不上
 *   waiting   已登录，当前没有正在进行的演讲者
 *   score     ★ 唯一的打分屏，**只显示当前这一位演讲者**
 *   submitted 本场已提交，等待下一位
 *
 * ⚠️ 「看不到其他演讲者」由三层保证（PLAN §7.2）：
 *   1. 服务端 /state 的响应体里只有当前这一位 —— 前端想显示别人也没有数据
 *   2. 前端没有上一位/下一位/跳转控件，也没有位置记忆
 *   3. 任何人的分数本来就不下发到评委端
 *
 * ⚠️ 用轮询而不是 WebSocket / SSE（PLAN §7.3）：企业微信内置浏览器对 ws:// 支持不佳，
 *   而当前部署是纯 HTTP，wss 无从谈起。轮询还能熬过「WebView 切后台」
 *   「链接改在系统浏览器打开」这类上下文切换。
 */
(function () {
  // 口令前缀，由 vote.html 内联注入（见 src/pages.js）。空串 = 未启用前缀。
  var BASE = window.PFXT_BASE || '';

  var CODE_KEY = 'pfxt:code';
  var DRAFT_PREFIX = 'pfxt:draft:';
  var POLL_MS = 3000;

  var el = {
    loading: document.getElementById('screen-loading'),
    blocked: document.getElementById('screen-blocked'),
    blockedIcon: document.getElementById('blocked-icon'),
    blockedTitle: document.getElementById('blocked-title'),
    blockedDesc: document.getElementById('blocked-desc'),
    blockedAction: document.getElementById('blocked-action'),
    waiting: document.getElementById('screen-waiting'),
    waitingTitle: document.getElementById('waiting-title'),
    waitingDesc: document.getElementById('waiting-desc'),
    score: document.getElementById('screen-score'),
    roundBadge: document.getElementById('round-badge'),
    roundName: document.getElementById('round-name'),
    roundProject: document.getElementById('round-project'),
    roundIntroWrap: document.getElementById('round-intro-wrap'),
    roundIntro: document.getElementById('round-intro'),
    dimHost: document.getElementById('dim-host'),
    scoreHint: document.getElementById('score-hint'),
    btnSubmit: document.getElementById('btn-submit'),
    submitted: document.getElementById('screen-submitted'),
    submittedDesc: document.getElementById('submitted-desc'),
    modalRoot: document.getElementById('modal-root'),
  };

  var SCREENS = ['loading', 'blocked', 'waiting', 'score', 'submitted'];

  var S = {
    code: '',
    screen: 'loading',
    roundId: null,
    dimensions: [],
    draft: {}, // { [dimensionId]: 1..5 }
    renderedRoundId: null, // 当前 DOM 是按哪一场渲染的
    submitting: false,
    fails: 0,
  };

  /* ------------------------------ 小工具 ------------------------------ */

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function lsGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }

  function lsSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* 隐私模式 / 企微偶发清空：写不进去也不能让打分中断 */
    }
  }

  function lsDel(k) {
    try {
      localStorage.removeItem(k);
    } catch (e) {
      /* 同上 */
    }
  }

  /**
   * 短码解析顺序：**URL 优先 → localStorage 兜底**（PLAN §7.3）。
   * 企微内置浏览器与系统浏览器是两个独立存储域，localStorage 也不一定留得住，
   * 所以 URL 里的码才是权威来源。
   */
  function codeFromUrl() {
    // 前缀要参与匹配：页面地址是 `/<口令>/v/<码>`，只认 `^/v/` 会解析不出码，
    // 于是每次刷新都退到 localStorage 兜底 —— 企微里 localStorage 恰好最不可靠。
    var m = location.pathname.match(/^\/v\/([^/]+)\/?$/);
    if (!m && BASE && location.pathname.indexOf(BASE + '/v/') === 0) {
      m = location.pathname.slice(BASE.length).match(/^\/v\/([^/]+)\/?$/);
    }
    return m ? decodeURIComponent(m[1]).toUpperCase() : '';
  }

  function codeFromStore() {
    return (lsGet(CODE_KEY) || '').toUpperCase();
  }

  function currentCode() {
    return codeFromUrl() || codeFromStore();
  }

  function show(name) {
    SCREENS.forEach(function (k) {
      el[k].hidden = k !== name;
    });
    S.screen = name;
  }

  function blocked(icon, title, desc, canReenter) {
    el.blockedIcon.textContent = icon;
    el.blockedTitle.textContent = title;
    el.blockedDesc.textContent = desc;
    el.blockedAction.hidden = !canReenter;
    show('blocked');
  }

  /* ------------------------------ 草稿 ------------------------------ */

  // 草稿按「短码 + 场次」隔离：换一位演讲者就是一份全新的草稿，
  // 上一场没交的草稿不会被下一场复用（那会张冠李戴）。
  function draftKey(roundId) {
    return DRAFT_PREFIX + S.code + ':' + roundId;
  }

  function loadDraft(roundId) {
    try {
      var raw = lsGet(draftKey(roundId));
      var obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveDraft() {
    if (S.roundId === null) return;
    lsSet(draftKey(S.roundId), JSON.stringify(S.draft));
  }

  function clearDraft(roundId) {
    lsDel(draftKey(roundId));
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function renderWaiting(data) {
    el.waitingTitle.textContent = '等待主持人开始下一位';
    el.waitingDesc.textContent = data.contestantCount
      ? '共 ' + data.contestantCount + ' 位演讲者。页面每 3 秒自动刷新，不用手动操作。'
      : '页面每 3 秒自动刷新，不用手动操作。';
    // 离开打分屏时把游标清掉，这样下一场会被当成「新的一场」重新渲染
    S.roundId = null;
    S.renderedRoundId = null;
    show('waiting');
  }

  function renderSubmitted(data) {
    var cur = data.current;
    el.submittedDesc.textContent =
      '第 ' + cur.seq + ' 位「' + cur.contestant.name + '」的评分已匿名记录，不可修改。';
    S.roundId = cur.roundId;
    show('submitted');
  }

  function buildScoreDom(data, notice) {
    var cur = data.current;

    el.roundBadge.textContent =
      '第 ' + cur.seq + ' 位' + (data.contestantCount ? ' · 共 ' + data.contestantCount + ' 位' : '');
    el.roundName.textContent = cur.contestant.name;
    el.roundProject.textContent = cur.contestant.project || '';

    var intro = (cur.contestant.intro || '').trim();
    el.roundIntroWrap.hidden = !intro;
    el.roundIntro.textContent = intro;

    // 「上一场没交就被切走了」的提示。只在换场时出现一次，不常驻。
    var old = el.score.querySelector('.round-notice');
    if (old) old.parentNode.removeChild(old);
    if (notice) {
      var n = document.createElement('div');
      n.className = 'notice notice-warn round-notice';
      var icon = document.createElement('span');
      icon.className = 'notice-icon';
      icon.textContent = '⚠️';
      var text = document.createElement('span');
      text.textContent = notice;
      n.appendChild(icon);
      n.appendChild(text);
      el.score.insertBefore(n, el.score.querySelector('.card'));
    }

    el.dimHost.innerHTML = S.dimensions
      .map(function (d) {
        var buttons = [1, 2, 3, 4, 5]
          .map(function (v) {
            var on = S.draft[d.id] === v ? ' is-active' : '';
            return (
              '<button type="button" class="score-btn' + on + '"' +
              ' data-dim="' + Number(d.id) + '" data-val="' + v + '"' +
              ' aria-label="' + esc(d.name) + ' 打 ' + v + ' 分">' + v + '</button>'
            );
          })
          .join('');

        return (
          '<div class="dim-row" data-dim="' + Number(d.id) + '">' +
          '<div class="dim-row-head"><span class="dim-row-name">' + esc(d.name) + '</span></div>' +
          (d.detail ? '<p class="dim-row-detail">' + esc(d.detail) + '</p>' : '') +
          '<div class="scale">' + buttons + '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  function renderScore(data) {
    var cur = data.current;
    S.dimensions = data.dimensions || [];

    if (S.renderedRoundId !== cur.roundId) {
      // 换场了。上一场若还有没提交的分数，明确告诉评委那一场记为弃权 —— 不能悄悄吞掉。
      var hadUnsaved = S.renderedRoundId !== null && Object.keys(S.draft).length > 0;
      S.roundId = cur.roundId;
      S.draft = loadDraft(cur.roundId);
      S.renderedRoundId = cur.roundId;
      buildScoreDom(data, hadUnsaved ? '上一场已经结束了，你没来得及提交，那一场记为弃权。' : null);
    } else {
      S.roundId = cur.roundId;
    }

    show('score');
    updateSubmitState();
  }

  function missingDims() {
    return S.dimensions.filter(function (d) {
      return !S.draft[d.id];
    });
  }

  function updateSubmitState() {
    var missing = missingDims().length;
    el.btnSubmit.disabled = missing > 0 || S.submitting;
    el.btnSubmit.textContent = S.submitting ? '提交中…' : '提交本场评分';
    el.scoreHint.textContent = missing
      ? '还有 ' + missing + ' 个维度没有打分'
      : '全部打完了，可以提交';
  }

  /* ---------------------------- 状态分发 ---------------------------- */

  function applyState(data) {
    // 已结束但本场还没交 → 直接告知结束；交过的人仍然显示「已提交」更友好
    if (data.phase !== 'open' && !(data.current && data.current.submitted)) {
      S.roundId = null;
      S.renderedRoundId = null;
      S.draft = {};
      blocked('🔒', '投票已结束', '主持人已经结束本次投票，感谢参与。', false);
      return;
    }
    if (!data.current) return renderWaiting(data);
    if (data.current.submitted) return renderSubmitted(data);
    return renderScore(data);
  }

  function poll() {
    S.code = currentCode();

    if (!S.code) {
      blocked('🔑', '需要登录码', '请从主持人发给你的入口进入，并输入登录码。', true);
      return;
    }

    fetch(BASE + '/api/v/' + encodeURIComponent(S.code) + '/state', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { status: r.status, data: d || {} };
        });
      })
      .then(function (res) {
        S.fails = 0;

        if (!res.data.ok) {
          if (res.data.error === 'revoked') {
            return blocked('🚫', '登录码已作废', '这个登录码已被主持人作废，请联系核对。', true);
          }
          return blocked('❓', '登录码无效', '请核对主持人发给你的那串字符。', true);
        }

        applyState(res.data);
      })
      .catch(function () {
        S.fails += 1;

        // 正在打分时**绝不替换界面**：草稿存在本机，网络恢复后会继续，
        // 贸然切屏会把评委正在打的分从眼前拿走。
        if (S.screen === 'score') {
          el.scoreHint.textContent = '网络不稳，正在自动重试…（已打的分数保存在本机，不会丢）';
          return;
        }
        if (S.fails >= 2 || S.screen === 'loading') {
          blocked('📶', '连不上服务器', '请检查手机网络后重试。', false);
        }
      });
  }

  /* ------------------------------ 交互 ------------------------------ */

  el.dimHost.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.score-btn') : null;
    if (!btn || S.submitting || S.screen !== 'score') return;

    var dimId = Number(btn.dataset.dim);
    var val = Number(btn.dataset.val);
    if (S.draft[dimId] === val) return; // 不允许取消 —— 没有「弃权」这个状态

    S.draft[dimId] = val;

    var row = btn.parentNode;
    Array.prototype.forEach.call(row.children, function (b) {
      b.classList.remove('is-active');
    });
    btn.classList.add('is-active');

    saveDraft();
    updateSubmitState();
  });

  function closeModal() {
    el.modalRoot.innerHTML = '';
  }

  function confirmModal() {
    var list = S.dimensions
      .map(function (d) {
        return (
          '<div class="confirm-row"><span>' +
          esc(d.name) +
          '</span><strong>' +
          S.draft[d.id] +
          ' 分</strong></div>'
        );
      })
      .join('');

    el.modalRoot.innerHTML =
      '<div class="modal-backdrop">' +
      '<div class="modal">' +
      '<div class="modal-head"><h3 class="modal-title">确认提交本场评分</h3></div>' +
      '<div class="modal-body">' +
      '<p class="hint">请核对。提交后<strong>不可修改</strong>。</p>' +
      '<div class="confirm-list">' + list + '</div>' +
      '</div>' +
      '<div class="modal-foot">' +
      '<button type="button" class="btn" data-act="cancel">再看看</button>' +
      '<button type="button" class="btn btn-primary" data-act="ok">确认提交</button>' +
      '</div></div></div>';

    el.modalRoot.addEventListener('click', function onModal(e) {
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (act) {
        el.modalRoot.removeEventListener('click', onModal);
        closeModal();
        if (act.dataset.act === 'ok') doSubmit();
        return;
      }
      // 点背板也能取消
      if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
        el.modalRoot.removeEventListener('click', onModal);
        closeModal();
      }
    });
  }

  function doSubmit() {
    if (S.submitting) return;
    S.submitting = true;
    updateSubmitState();

    var roundId = S.roundId;
    var payload = {
      roundId: roundId,
      scores: S.dimensions.map(function (d) {
        return { dimensionId: d.id, value: S.draft[d.id] };
      }),
    };

    fetch(BASE + '/api/v/' + encodeURIComponent(S.code) + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (d) {
          return { status: r.status, data: d || {} };
        });
      })
      .then(function (res) {
        S.submitting = false;

        if (res.data.ok) {
          clearDraft(roundId);
          S.draft = {};
          S.roundId = roundId;
          return poll(); // 立刻同步一次，由 poll 统一渲染「已提交」
        }

        // 本场已经结束了（主持人抢先切走）—— 这一场记为弃权，不能假装提交成功
        if (res.data.error === 'round_closed' || res.data.error === 'already_submitted') {
          clearDraft(roundId);
          S.draft = {};
          S.renderedRoundId = null;
          return poll();
        }

        updateSubmitState();
        alert(res.data.message || '提交失败，请重试。');
      })
      .catch(function () {
        S.submitting = false;
        updateSubmitState();
        alert('连不上服务器，评分没有提交。请检查网络后重试 —— 你打的分数还在本机。');
      });
  }

  el.btnSubmit.addEventListener('click', function () {
    if (missingDims().length) return;
    confirmModal();
  });

  // 息屏 / 切后台回来时立刻同步一次；移动浏览器会节流定时器
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  // 离开页面时把草稿落盘（saveDraft 是实时的，这里只是兜底）
  window.addEventListener('pagehide', saveDraft);

  show('loading');
  poll();
  setInterval(poll, POLL_MS);
})();
