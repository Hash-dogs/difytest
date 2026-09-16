'use strict';

/**
 * 评委端（PLAN §7.2）
 *
 * ⚠️ 两条不能碰的红线：
 *   1. 评分控件绝不预填默认值（PLAN §9.2）—— 一旦有默认值，「必须全部打分」的校验就是假的
 *   2. 草稿只存在本机 localStorage，服务端不存半成品（PLAN §3 决策 2）
 */

(function () {
  const CODE = (() => {
    const m = location.pathname.match(/^\/v\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : '';
  })();

  const DRAFT_KEY = `pfxt:draft:${CODE}`;
  const SUBMITTED_KEY = `pfxt:submitted:${CODE}`;
  const POS_KEY = `pfxt:pos:${CODE}`;
  const DRAFT_DEBOUNCE_MS = 300;

  const state = {
    activityName: '',
    dimensions: [],
    contestants: [],
    draft: {}, // { [contestantId]: { [dimensionId]: 1..5 } }
    index: 0,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  /* ---------------------------- localStorage ---------------------------- */

  const lsGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 隐私模式下可能失败，不影响本次打分 */
    }
  };
  const lsDel = (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* 同上 */
    }
  };

  let saveTimer = null;
  function saveDraftSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => lsSet(DRAFT_KEY, JSON.stringify(state.draft)), DRAFT_DEBOUNCE_MS);
  }
  function saveDraftNow() {
    clearTimeout(saveTimer);
    lsSet(DRAFT_KEY, JSON.stringify(state.draft));
  }

  function readDraft() {
    const raw = lsGet(DRAFT_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function readSubmittedMarker() {
    const raw = lsGet(SUBMITTED_KEY);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { submitted: true };
    } catch {
      return { submitted: true };
    }
  }

  /* -------------------------------- 屏幕 -------------------------------- */

  const SCREENS = ['screen-loading', 'screen-blocked', 'screen-intro', 'screen-score', 'screen-done'];
  function showScreen(id) {
    for (const s of SCREENS) $(s).hidden = s !== id;
  }

  function showBlocked(icon, title, desc) {
    $('blocked-icon').textContent = icon;
    $('blocked-title').textContent = title;
    $('blocked-desc').textContent = desc;
    showScreen('screen-blocked');
  }

  /* -------------------------------- 弹窗 -------------------------------- */

  function closeModal() {
    document.querySelectorAll('.modal-backdrop').forEach((n) => n.remove());
    document.body.style.overflow = '';
  }

  function openModal({ title, bodyHtml, actions }) {
    closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      `<div class="modal-head"><h3 class="modal-title">${esc(title)}</h3></div>` +
      `<div class="modal-body">${bodyHtml}</div>` +
      '<div class="modal-foot"></div>' +
      '</div>';

    const foot = backdrop.querySelector('.modal-foot');
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (action.className || '');
      btn.textContent = action.label;
      btn.disabled = Boolean(action.disabled);
      btn.addEventListener('click', () => action.onClick && action.onClick(backdrop));
      foot.appendChild(btn);
    }

    document.getElementById('modal-root').appendChild(backdrop);
    document.body.style.overflow = 'hidden';
    return backdrop;
  }

  function showAlert(title, message, onClose) {
    openModal({
      title,
      bodyHtml: `<p style="color:var(--text-dim)">${esc(message)}</p>`,
      actions: [
        {
          label: '知道了',
          className: 'btn-primary',
          onClick: () => {
            closeModal();
            if (onClose) onClose();
          },
        },
      ],
    });
  }

  /* ------------------------------ 打分状态 ------------------------------ */

  const cellOf = (contestantId, dimensionId) => (state.draft[contestantId] || {})[dimensionId];

  function isContestantComplete(contestantId) {
    return state.dimensions.every((d) => Number.isInteger(cellOf(contestantId, d.id)));
  }

  function findMissing() {
    const missing = [];
    state.contestants.forEach((c, index) => {
      for (const d of state.dimensions) {
        if (!Number.isInteger(cellOf(c.id, d.id))) {
          missing.push({ index, contestantId: c.id, dimensionId: d.id, cName: c.name, dName: d.name });
        }
      }
    });
    return missing;
  }

  function setScore(contestantId, dimensionId, value) {
    const cells = state.draft[contestantId] || (state.draft[contestantId] = {});
    if (cells[dimensionId] === value) return; // 不允许取消，也就没有「弃权」这个状态
    cells[dimensionId] = value;
    saveDraftSoon();
  }

  /* ------------------------------ 渲染：说明 ---------------------------- */

  function renderIntro(hasDraft) {
    $('intro-activity').textContent = state.activityName;

    const total = state.contestants.length * state.dimensions.length;
    $('intro-count').textContent =
      `${state.contestants.length} 位参赛者 × ${state.dimensions.length} 个维度 = ${total}`;

    $('intro-dims').innerHTML = state.dimensions
      .map(
        (d) => `
        <li>
          <div class="dim-brief-head">
            <span class="dim-brief-name">${esc(d.name)}</span>
            <span class="dim-brief-weight">${esc(d.weight)}%</span>
          </div>
          ${d.detail ? `<p class="dim-brief-detail">${esc(d.detail)}</p>` : ''}
        </li>`
      )
      .join('');

    const hint = $('intro-resume-hint');
    if (hasDraft) {
      const doneCount = state.contestants.filter((c) => isContestantComplete(c.id)).length;
      hint.textContent = `检测到未提交的草稿（已完成 ${doneCount} / ${state.contestants.length} 人），将从上次的进度继续。`;
      hint.hidden = false;
      $('btn-start').textContent = '继续打分';
    } else {
      hint.hidden = true;
      $('btn-start').textContent = '开始打分';
    }

    showScreen('screen-intro');
  }

  /* ------------------------------ 渲染：打分 ---------------------------- */

  function renderCard() {
    const c = state.contestants[state.index];
    const isLast = state.index === state.contestants.length - 1;
    const introText = (c.intro || '').trim();
    const longIntro = introText.length > 90;

    const rows = state.dimensions
      .map((d) => {
        const current = cellOf(c.id, d.id);
        const buttons = [1, 2, 3, 4, 5]
          .map(
            (v) =>
              `<button type="button" class="score-btn${current === v ? ' is-active' : ''}"
                 data-value="${v}" aria-pressed="${current === v}"
                 aria-label="${esc(d.name)} ${v} 分">${v}</button>`
          )
          .join('');

        return `
          <div class="dim-row" data-dimension-id="${d.id}">
            <div class="dim-row-head">
              <span class="dim-row-name">${esc(d.name)}</span>
              <span class="dim-row-weight">${esc(d.weight)}%</span>
            </div>
            ${d.detail ? `<p class="dim-row-detail">${esc(d.detail)}</p>` : ''}
            <div class="scale" role="group" aria-label="${esc(d.name)}">${buttons}</div>
            <div class="scale-hint"><span>1 分 · 低</span><span>5 分 · 高</span></div>
          </div>`;
      })
      .join('');

    $('card-host').innerHTML = `
      <article class="card" data-contestant-id="${c.id}">
        <header class="card-head">
          <div class="card-index">第 ${state.index + 1} / ${state.contestants.length} 位</div>
          <h2 class="card-name">${esc(c.name)}</h2>
          <div class="card-project">${esc(c.project)}</div>
          ${
            introText
              ? `<p class="card-intro${longIntro ? ' is-collapsed' : ''}" data-intro>${esc(introText)}</p>` +
                (longIntro ? '<button type="button" class="intro-toggle" data-intro-toggle>展开全部 ⌄</button>' : '')
              : ''
          }
        </header>
        ${rows}
      </article>`;

    const nextBtn = $('btn-next');
    nextBtn.textContent = isLast ? '提交' : '下一位 ›';
    nextBtn.classList.toggle('btn-primary', true);
    $('btn-prev').disabled = state.index === 0;

    updateProgress();
  }

  function updateProgress() {
    const total = state.contestants.length;
    const done = state.contestants.filter((c) => isContestantComplete(c.id)).length;

    $('progress-text').textContent = `已完成 ${done} / ${total} 人`;

    const fill = $('progress-fill');
    const pct = total ? Math.round((done / total) * 100) : 0;
    fill.style.width = pct + '%';
    fill.classList.toggle('is-complete', total > 0 && done === total);

    // 全部打完时，给一个直达末位的入口（提交按钮始终只在最后一位上）
    const jump = $('btn-jump-submit');
    const isLast = state.index === total - 1;
    jump.hidden = !(total > 0 && done === total && !isLast);
  }

  function goTo(index) {
    state.index = Math.max(0, Math.min(state.contestants.length - 1, index));
    lsSet(POS_KEY, String(state.index));
    renderCard();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* -------------------------------- 提交 -------------------------------- */

  function showMissingModal(missing) {
    const shown = missing.slice(0, 12);
    const rest = missing.length - shown.length;

    const body =
      '<p style="color:var(--text-dim);margin-bottom:12px">' +
      `还有 <strong style="color:var(--danger)">${missing.length}</strong> 项没有打分。` +
      '点击任意一项可直接跳到该位置补分。</p>' +
      '<ul class="missing-list">' +
      shown
        .map(
          (m) => `
          <li>
            <button type="button" class="missing-item" data-goto-index="${m.index}" data-goto-dim="${m.dimensionId}">
              <span><strong>${esc(m.cName)}</strong> · ${esc(m.dName)}</span>
              <span class="missing-go">去补分 ›</span>
            </button>
          </li>`
        )
        .join('') +
      '</ul>' +
      (rest > 0 ? `<p class="hint" style="margin-top:10px">还有 ${rest} 项未列出。</p>` : '');

    const backdrop = openModal({
      title: '还不能提交',
      bodyHtml: body,
      actions: [{ label: '返回继续打分', className: 'btn-primary', onClick: closeModal }],
    });

    backdrop.querySelectorAll('[data-goto-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.gotoIndex);
        const dimensionId = Number(btn.dataset.gotoDim);
        closeModal();
        goTo(index);
        highlightDimension(dimensionId);
      });
    });
  }

  function highlightDimension(dimensionId) {
    const row = document.querySelector(`.dim-row[data-dimension-id="${dimensionId}"]`);
    if (!row) return;
    row.classList.add('is-missing');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => row.classList.remove('is-missing'), 2400);
  }

  function showConfirmModal() {
    const total = state.contestants.length * state.dimensions.length;
    openModal({
      title: '确认提交',
      bodyHtml:
        '<div class="notice notice-danger" style="margin-bottom:12px">' +
        '<span class="notice-icon">⚠️</span>' +
        '<span><strong>提交后无法修改，也没有撤销入口。</strong>请确认所有评分都已核对无误。</span>' +
        '</div>' +
        `<p style="color:var(--text-dim)">共 ${state.contestants.length} 位参赛者、${total} 个评分点，` +
        '全部已打分。</p>',
      actions: [
        { label: '再检查一下', onClick: closeModal },
        { label: '确认提交', className: 'btn-primary', onClick: () => doSubmit() },
      ],
    });
  }

  function buildPayload() {
    const scores = [];
    for (const c of state.contestants) {
      for (const d of state.dimensions) {
        scores.push({ contestantId: c.id, dimensionId: d.id, value: cellOf(c.id, d.id) });
      }
    }
    return scores;
  }

  async function doSubmit() {
    const buttons = document.querySelectorAll('.modal-foot .btn');
    buttons.forEach((b) => (b.disabled = true));

    try {
      const res = await fetch(`/api/v/${CODE}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scores: buildPayload() }),
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data && data.ok) {
        const snapshot = { submitted: true, at: Date.now(), scores: state.draft };
        lsSet(SUBMITTED_KEY, JSON.stringify(snapshot));
        clearTimeout(saveTimer);
        lsDel(DRAFT_KEY);
        lsDel(POS_KEY);
        closeModal();
        renderDone(snapshot);
        return;
      }

      closeModal();
      handleSubmitFailure(res.status, data);
    } catch {
      closeModal();
      showAlert('提交失败', '网络异常，未能连上服务器。你的评分仍保存在本机，可稍后重试。');
    }
  }

  function handleSubmitFailure(status, data) {
    const error = (data && data.error) || '';
    const message = (data && data.message) || '';

    if (error === 'already_submitted') {
      // PLAN §7.2 边界：本地记录被清了，但服务端已经收过这张票
      lsSet(SUBMITTED_KEY, JSON.stringify({ submitted: true, at: Date.now() }));
      clearTimeout(saveTimer);
      lsDel(DRAFT_KEY);
      showBlocked('✅', '本链接已提交过', '系统记录显示这个链接已经提交过选票，无需重复提交。若您确认没有提交过，请联系组织者。');
      return;
    }
    if (error === 'revoked') {
      showBlocked('🚫', '链接已作废', '该链接已被组织者作废，无法提交。请向组织者索取新的链接。');
      return;
    }
    if (error === 'not_found') {
      showBlocked('❓', '链接无效', '找不到这个链接，请向组织者确认地址是否完整。');
      return;
    }
    if (error === 'closed') {
      showAlert('投票已结束', '本次投票已经封盘，无法再提交。');
      return;
    }
    showAlert('提交失败', message || '服务器拒绝了这次提交，请稍后重试或联系组织者。');
  }

  /* ------------------------------ 渲染：完成 ---------------------------- */

  function renderDone(snapshot) {
    const host = $('done-summary');
    const scores = snapshot && snapshot.scores;

    if (!scores || !state.contestants.length) {
      host.innerHTML = '';
      showScreen('screen-done');
      return;
    }

    // 只读回显：给评委留一份自己打过的分（不改变「已提交」这个事实）
    host.className = 'done-summary';
    host.innerHTML =
      '<h2 class="section-title" style="margin:26px 0 10px">您提交的评分</h2>' +
      state.contestants
        .map((c) => {
          const cells = scores[c.id] || {};
          const chips = state.dimensions
            .map(
              (d) =>
                `<span class="summary-chip">${esc(d.name)} <b>${esc(cells[d.id] ?? '—')}</b></span>`
            )
            .join('');
          return `
            <div class="summary-card">
              <div class="summary-name">${esc(c.name)} <span>· ${esc(c.project)}</span></div>
              <div class="summary-scores">${chips}</div>
            </div>`;
        })
        .join('');

    showScreen('screen-done');
  }

  /* -------------------------------- 绑定 -------------------------------- */

  function bindEvents() {
    $('btn-start').addEventListener('click', () => {
      const saved = Number(lsGet(POS_KEY));
      state.index = Number.isInteger(saved) && saved >= 0 && saved < state.contestants.length ? saved : 0;
      renderCard();
      window.scrollTo({ top: 0, behavior: 'auto' });
      showScreen('screen-score');
    });

    $('card-host').addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-intro-toggle]');
      if (toggle) {
        const intro = $('card-host').querySelector('[data-intro]');
        const collapsed = intro.classList.toggle('is-collapsed');
        toggle.textContent = collapsed ? '展开全部 ⌄' : '收起 ⌃';
        return;
      }

      const btn = event.target.closest('.score-btn');
      if (!btn) return;

      const card = btn.closest('.card');
      const row = btn.closest('.dim-row');
      if (!card || !row) return;

      const contestantId = Number(card.dataset.contestantId);
      const dimensionId = Number(row.dataset.dimensionId);
      const value = Number(btn.dataset.value);

      setScore(contestantId, dimensionId, value);
      row.querySelectorAll('.score-btn').forEach((b) => {
        const active = Number(b.dataset.value) === value;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      row.classList.remove('is-missing');
      updateProgress();
    });

    $('btn-prev').addEventListener('click', () => goTo(state.index - 1));

    $('btn-next').addEventListener('click', () => {
      if (state.index === state.contestants.length - 1) {
        if (findMissing().length) showMissingModal(findMissing());
        else showConfirmModal();
      } else {
        goTo(state.index + 1);
      }
    });

    $('btn-jump-submit').addEventListener('click', () => goTo(state.contestants.length - 1));

    // 关闭页面前把草稿落盘（防抖窗口内可能还没写）
    window.addEventListener('pagehide', () => {
      if (Object.keys(state.draft).length) saveDraftNow();
    });
  }

  /* --------------------------------- 启动 -------------------------------- */

  async function init() {
    if (!CODE) {
      showBlocked('❓', '链接无效', '地址里没有短码，请向组织者索取完整的投票链接。');
      return;
    }

    let res;
    let data;
    try {
      res = await fetch(`/api/v/${CODE}/data`, { headers: { Accept: 'application/json' } });
      data = await res.json().catch(() => null);
    } catch {
      showBlocked('📡', '连接失败', '连不上服务器。请确认手机和电脑连的是同一个 WiFi，然后刷新重试。');
      return;
    }

    const marker = readSubmittedMarker();

    if (!res.ok || !data || !data.ok) {
      const error = (data && data.error) || '';
      if (error === 'revoked') {
        showBlocked('🚫', '链接已作废', '该链接已被组织者作废。如有疑问，请联系组织者索取新链接。');
      } else if (error === 'not_found') {
        showBlocked('❓', '链接无效', '找不到这个链接，请向组织者确认地址是否完整。');
      } else {
        showBlocked('⚠️', '无法打开', (data && data.message) || '服务返回了异常状态，请稍后重试。');
      }
      return;
    }

    state.activityName = data.activityName;
    state.dimensions = data.dimensions || [];
    state.contestants = data.contestants || [];

    if (!state.dimensions.length || !state.contestants.length) {
      showBlocked('🛠️', '活动尚未配置', '组织者还没有配置参赛者或评分维度，请联系组织者。');
      return;
    }

    // 已提交：本地有快照就回显，没有就给一句友好说明（PLAN §7.2 边界）
    if (data.status === 'submitted' || marker) {
      if (marker && marker.scores) renderDone(marker);
      else if (data.status === 'submitted') {
        showBlocked('✅', '本链接已提交过', '这个链接的选票已经在服务器上记录，无需重复提交。');
      } else {
        renderDone(marker);
      }
      return;
    }

    if (data.phase !== 'open') {
      showBlocked('🔒', '投票已结束', '本次投票已经封盘，无法再打分。感谢关注。');
      return;
    }

    const draft = readDraft();
    const hasDraft = Boolean(draft && Object.keys(draft).length);
    if (hasDraft) {
      state.draft = draft;
      // 清掉配置里已经不存在的参赛者/维度留下的残留
      for (const cid of Object.keys(state.draft)) {
        if (!state.contestants.some((c) => String(c.id) === String(cid))) delete state.draft[cid];
      }
    }

    bindEvents();
    renderIntro(hasDraft);
  }

  init();
})();
