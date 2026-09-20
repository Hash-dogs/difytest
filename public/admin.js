'use strict';

/**
 * 管理后台（PLAN §7.3）
 * 结果区常驻横幅是 PLAN §7.4 的强制缓解措施：投票期间管理员能看到分数，
 * 必须把「请勿对外透露」钉在眼前，否则评审群里一句话就会污染剩余选票。
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  const REFRESH_MS = 20000;

  const state = {
    activeTab: 'rounds',
    configDraft: { activityName: '', contestants: [], dimensions: [], judgeCount: 11 },
    // 开赛后维度与权重锁死（PLAN §8.2）
    started: false,
    results: null,
    rounds: null,
    detail: null,
    timer: null,
  };

  /* ------------------------------ 通用工具 ------------------------------ */

  class ApiError extends Error {
    constructor(status, payload) {
      super((payload && payload.message) || `请求失败（${status}）`);
      this.status = status;
      this.payload = payload;
    }
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (res.status === 401) {
      showLogin();
      throw new ApiError(401, payload);
    }
    if (!res.ok || !payload || payload.ok === false) throw new ApiError(res.status, payload);
    return payload;
  }

  function toast(message, isError) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' is-error' : '');
    el.textContent = message;
    $('toast-root').appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  function closeModal() {
    document.querySelectorAll('.modal-backdrop').forEach((n) => n.remove());
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
      btn.addEventListener('click', () => action.onClick && action.onClick());
      foot.appendChild(btn);
    }
    $('modal-root').appendChild(backdrop);
    return backdrop;
  }

  function confirmModal(title, message, confirmLabel, onConfirm) {
    openModal({
      title,
      bodyHtml: `<p style="color:var(--text-dim)">${esc(message)}</p>`,
      actions: [
        { label: '取消', onClick: closeModal },
        {
          label: confirmLabel,
          className: 'btn-primary',
          onClick: () => {
            closeModal();
            onConfirm();
          },
        },
      ],
    });
  }

  /**
   * ⚠️ navigator.clipboard 只在安全上下文可用。
   * 评委/管理员走的是 http://<局域网IP>:3000，不是 https 也不是 localhost，
   * 那里 navigator.clipboard 是 undefined —— 必须准备 execCommand 回退。
   */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* 落到回退方案 */
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  const fmtTime = (ts) =>
    ts
      ? new Date(ts).toLocaleString('zh-CN', {
          hour12: false,
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';

  const fmt2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');

  /* -------------------------------- 登录 -------------------------------- */

  function showLogin() {
    $('app-screen').hidden = true;
    $('login-screen').hidden = false;
    if (state.timer) clearInterval(state.timer);
  }

  function showApp() {
    $('login-screen').hidden = true;
    $('app-screen').hidden = false;
    if (!state.timer) state.timer = setInterval(autoRefresh, REFRESH_MS);
  }

  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('login-password').value;
    const errorBox = $('login-error');
    const submit = $('login-submit');
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
      $('login-password').value = '';
      showApp();
      await bootApp();
    } catch (err) {
      errorBox.textContent = err.message || '登录失败';
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '登录';
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } catch {
      /* 忽略 */
    }
    showLogin();
  });

  /* -------------------------------- 标签页 ------------------------------ */

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
    if (tab === 'invites') loadInvites();
    if (tab === 'rounds') loadRounds();
    if (tab === 'results') loadResults();
    if (tab === 'detail') loadDetail();
  }

  $('tabs').addEventListener('click', (event) => {
    const btn = event.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  function autoRefresh() {
    if (document.hidden || $('app-screen').hidden) return;
    // 场次页要跟着现场走，刷新要比别处勤 —— 主持人盯着它决定什么时候切下一位
    if (state.activeTab === 'rounds') loadRounds();
    else if (state.activeTab === 'results') loadResults();
  }

  /* -------------------------------- 配置 -------------------------------- */

  function setLockNotice() {
    const locked = state.started;
    $('config-lock-notice').hidden = !locked;
    if (locked) {
      $('config-lock-text').textContent =
        '比赛已经开始，评分维度与权重已锁定 —— 否则改权重会让已经打完的场次被追溯性改变分值。' +
        '姓名、项目名、简介仍可修改；可以中途加人，但已经上过场的不能删。';
    }
    // 锁定时把维度的权重输入框和增删按钮禁用掉，别让人白填一遍再被拒
    document.querySelectorAll('#dim-table .cell-input[data-field="weight"]').forEach((el) => {
      el.disabled = locked;
    });
    $('btn-add-dim').disabled = locked;
    document.querySelectorAll('#dim-table .row-del').forEach((el) => {
      el.disabled = locked;
    });
  }

  function renderConfig() {
    $('config-activity').value = state.configDraft.activityName;
    $('config-judge-count').value = state.configDraft.judgeCount;
    renderDimRows();
    renderContestantRows();
    updateWeightSum();
    setLockNotice();
  }

  function renderDimRows() {
    const tbody = document.querySelector('#dim-table tbody');
    const rows = state.configDraft.dimensions;
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">还没有评分维度</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (d, i) => `
        <tr>
          <td class="col-seq">${i + 1}</td>
          <td><input class="cell-input" data-kind="dim" data-index="${i}" data-field="name" value="${esc(d.name)}" placeholder="维度名称" /></td>
          <td><input class="cell-input cell-input-sm" data-kind="dim" data-index="${i}" data-field="weight" inputmode="numeric" value="${esc(d.weight)}" placeholder="0" /></td>
          <td><input class="cell-input" data-kind="dim" data-index="${i}" data-field="detail" value="${esc(d.detail)}" placeholder="核心评价内容（会展示给评委）" /></td>
          <td class="col-op"><button type="button" class="row-del" data-action="del-dim" data-index="${i}">删除</button></td>
        </tr>`
      )
      .join('');
    // 重渲染会把输入框的禁用态冲掉，这里补回来（开赛后权重锁定，PLAN §8.2）
    setLockNotice();
  }

  function renderContestantRows() {
    const tbody = document.querySelector('#contestant-table tbody');
    const rows = state.configDraft.contestants;
    if (!rows.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">还没有参赛者</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(
        (c, i) => `
        <tr>
          <td class="col-seq">${i + 1}</td>
          <td><input class="cell-input" data-kind="contestant" data-index="${i}" data-field="name" value="${esc(c.name)}" placeholder="姓名" /></td>
          <td><input class="cell-input" data-kind="contestant" data-index="${i}" data-field="project" value="${esc(c.project)}" placeholder="项目名" /></td>
          <td><input class="cell-input" data-kind="contestant" data-index="${i}" data-field="intro" value="${esc(c.intro)}" placeholder="简介（选填）" /></td>
          <td class="col-op"><button type="button" class="row-del" data-action="del-contestant" data-index="${i}">删除</button></td>
        </tr>`
      )
      .join('');
  }

  function readWeight(value) {
    const raw = String(value ?? '').trim();
    if (raw === '') return NaN;
    return Number(raw);
  }

  function updateWeightSum() {
    let sum = 0;
    let bad = 0;
    for (const d of state.configDraft.dimensions) {
      const v = readWeight(d.weight);
      if (!Number.isInteger(v) || v < 0 || v > 100) bad += 1;
      else sum += v;
    }

    const el = $('weight-sum');
    const ok = bad === 0 && sum === 100;
    el.className = 'weight-sum ' + (ok ? 'is-ok' : 'is-bad');
    el.textContent = bad > 0 ? `合计 ${sum}（有 ${bad} 项权重不合法）` : `合计 ${sum} ${ok ? '✓' : '✗ 必须等于 100'}`;

    document.querySelectorAll('#dim-table input[data-field="weight"]').forEach((input) => {
      const v = readWeight(input.value);
      input.classList.toggle('is-invalid', !(Number.isInteger(v) && v >= 0 && v <= 100));
    });
  }

  function bindConfigTable(tableId, collection) {
    const table = $(tableId);

    table.addEventListener('input', (event) => {
      const t = event.target;
      if (!t.dataset || t.dataset.kind !== collection) return;
      const item = state.configDraft[collection === 'dim' ? 'dimensions' : 'contestants'][Number(t.dataset.index)];
      if (!item) return;
      item[t.dataset.field] = t.value;
      if (collection === 'dim' && t.dataset.field === 'weight') updateWeightSum();
    });

    table.addEventListener('click', (event) => {
      const btn = event.target.closest('.row-del');
      if (!btn) return;
      const list = collection === 'dim' ? 'dimensions' : 'contestants';
      state.configDraft[list].splice(Number(btn.dataset.index), 1);
      if (collection === 'dim') {
        renderDimRows();
        updateWeightSum();
      } else {
        renderContestantRows();
      }
    });
  }

  bindConfigTable('dim-table', 'dim');
  bindConfigTable('contestant-table', 'contestant');

  $('btn-add-dim').addEventListener('click', () => {
    state.configDraft.dimensions.push({ id: null, name: '', weight: 0, detail: '' });
    renderDimRows();
    updateWeightSum();
  });


  $('btn-add-contestant').addEventListener('click', () => {
    state.configDraft.contestants.push({ id: null, name: '', project: '', intro: '' });
    renderContestantRows();
  });

  function parseImport(text) {
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.includes('\t') ? trimmed.split('\t') : trimmed.split(/[,，]/);
      const name = (parts[0] || '').trim();
      if (!name) continue;
      out.push({
        id: null,
        name,
        project: (parts[1] || '').trim(),
        intro: parts.slice(2).join(' ').trim(),
      });
    }
    return out;
  }

  function doImport(replace) {
    const parsed = parseImport($('import-text').value);
    if (!parsed.length) return toast('没有解析到任何一行，请检查格式', true);

    if (replace) state.configDraft.contestants = parsed;
    else state.configDraft.contestants.push(...parsed);

    renderContestantRows();
    $('import-text').value = '';
    const missingProject = parsed.filter((c) => !c.project).length;
    toast(
      `已导入 ${parsed.length} 位参赛者` + (missingProject ? `，其中 ${missingProject} 位缺项目名，请补齐后再保存` : '')
    );
  }

  $('btn-import-append').addEventListener('click', () => doImport(false));
  $('btn-import-replace').addEventListener('click', () => {
    confirmModal('替换现有列表', '当前的参赛者列表会被导入内容整体替换，确定吗？', '替换', () => doImport(true));
  });

  $('btn-save-config').addEventListener('click', async () => {
    const payload = {
      activityName: $('config-activity').value.trim(),
      judgeCount: Number($('config-judge-count').value),
      dimensions: state.configDraft.dimensions.map((d) => ({
        id: d.id ?? null,
        name: String(d.name || '').trim(),
        weight: readWeight(d.weight),
        detail: String(d.detail || '').trim(),
      })),
      contestants: state.configDraft.contestants.map((c) => ({
        id: c.id ?? null,
        name: String(c.name || '').trim(),
        project: String(c.project || '').trim(),
        intro: String(c.intro || '').trim(),
      })),
    };

    const btn = $('btn-save-config');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const saved = await api('/api/admin/config', { method: 'PUT', body: JSON.stringify(payload) });
      state.configDraft = {
        activityName: saved.activityName,
        judgeCount: saved.judgeCount,
        contestants: saved.contestants.map((c) => ({ ...c })),
        dimensions: saved.dimensions.map((d) => ({ ...d })),
      };
      state.started = saved.started;
      renderConfig();
      $('brand-activity').textContent = saved.activityName || '管理后台';
      toast('配置已保存');
    } catch (err) {
      toast(err.message || '保存失败', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '保存配置';
    }
  });

  /* ------------------------------ 投票链接 ------------------------------ */

  async function loadInvites() {
    try {
      const data = await api('/api/admin/invites');
      renderInvites(data.invites);
      loadEntry();
    } catch (err) {
      toast(err.message || '加载失败', true);
    }
  }

  /* ---------------------------- 扫码入口 ---------------------------- */

  let entryUrls = [];

  async function loadEntry() {
    try {
      const data = await api('/api/admin/entry');
      entryUrls = data.urls || [];

      const select = $('entry-ip-select');
      const warn = $('entry-warn');

      if (!entryUrls.length) {
        select.innerHTML = '<option>未检测到局域网地址</option>';
        select.disabled = true;
        $('entry-url').value = '';
        $('entry-qr-img').removeAttribute('src');
        warn.hidden = false;
        warn.textContent = '没有检测到局域网 IPv4 地址，评委手机可能访问不到。请确认电脑已连上内网。';
        return;
      }

      select.disabled = false;
      const previous = select.value;
      // 带上网卡名：Linux 上常有 docker0 / virbr0 之类的虚拟网卡混在里面
      select.innerHTML = entryUrls
        .map((u) => {
          const label = `${u.ip}  (${u.name})${u.virtual ? ' — 虚拟网卡' : ''}`;
          return `<option value="${esc(u.ip)}">${esc(label)}</option>`;
        })
        .join('');
      select.value = entryUrls.some((u) => u.ip === previous) ? previous : entryUrls[0].ip;

      warn.hidden = entryUrls.length === 1;
      if (entryUrls.length > 1) {
        warn.textContent =
          '这台电脑有多个内网地址。请选一个评委手机能访问到的（通常是真实网卡、且和手机同网段的那个），二维码会跟着变。';
      }
      if (entryUrls[0] && entryUrls[0].virtual) {
        warn.hidden = false;
        warn.textContent =
          '⚠️ 默认选中的是虚拟网卡（如 docker0 / virbr0），评委手机访问不到。请改选真实网卡的地址。';
      }

      applyEntry();
    } catch (err) {
      toast(err.message || '二维码加载失败', true);
    }
  }

  function applyEntry() {
    const ip = $('entry-ip-select').value;
    const target = entryUrls.find((u) => u.ip === ip) || entryUrls[0];
    if (!target) return;
    $('entry-url').value = target.url;
    $('entry-qr-img').src = `/api/admin/qrcode.svg?ip=${encodeURIComponent(target.ip)}`;
  }

  $('entry-ip-select').addEventListener('change', applyEntry);

  $('btn-copy-entry').addEventListener('click', async () => {
    const url = $('entry-url').value;
    if (!url) return toast('没有可复制的地址', true);
    const ok = await copyText(url);
    toast(ok ? '已复制入口地址' : '复制失败，请手动选中复制', !ok);
  });

  function renderInvites(invites) {
    const tbody = document.querySelector('#invite-table tbody');
    if (!invites.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">还没有生成任何登录码</td></tr>';
      return;
    }
    tbody.innerHTML = invites
      .map((inv, i) => {
        const used = (inv.rounds_submitted || 0) > 0;
        // 交过票就不能作废 —— 选票已与身份脱钩，无法定位该删哪张票
        const revokeBtn = used
          ? `<button type="button" class="btn btn-sm" disabled
               title="已提交过评分的登录码不可作废：选票已与身份脱钩，无法定位该删哪张票">不可作废</button>`
          : inv.revoked
            ? '<span class="hint">—</span>'
            : `<button type="button" class="btn btn-sm btn-danger" data-action="revoke" data-code="${esc(inv.code)}">作废</button>`;

        return `
          <tr>
            <td class="col-seq">${i + 1}</td>
            <td class="col-code"><b>${esc(inv.code)}</b></td>
            <td>${inv.revoked ? '已作废' : '可用'}</td>
            <td class="num-cell">${inv.rounds_submitted || 0}</td>
            <td>${esc(fmtTime(inv.last_submitted_at))}</td>
            <td class="col-op" style="width:200px">
              <button type="button" class="btn btn-sm" data-action="copy" data-code="${esc(inv.code)}">复制登录码</button>
              ${revokeBtn}
            </td>
          </tr>`;
      })
      .join('');
  }

  $('invite-table').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    const code = btn.dataset.code;

    if (btn.dataset.action === 'copy') {
      // 评委是在统一入口页**手输**这个码的，所以复制的就是码本身
      const ok = await copyText(code);
      toast(ok ? `已复制登录码 ${code}` : '复制失败，请手动选中复制', !ok);
      return;
    }

    if (btn.dataset.action === 'revoke') {
      confirmModal('作废登录码', `确定要作废 ${code} 吗？作废后这位评委将无法再进入评分页。`, '作废', async () => {
        try {
          await api(`/api/admin/invites/${encodeURIComponent(code)}/revoke`, { method: 'POST' });
          toast(`已作废 ${code}`);
          loadInvites();
        } catch (err) {
          toast(err.message || '作废失败', true);
        }
      });
    }
  });

  $('btn-generate').addEventListener('click', async () => {
    const count = Number($('invite-count').value);
    if (!Number.isInteger(count) || count < 1 || count > 500) return toast('生成数量必须是 1–500 的整数', true);

    const btn = $('btn-generate');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const data = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify({ count }) });
      toast(`已生成 ${data.created.length} 个登录码`);
      loadInvites();
    } catch (err) {
      toast(err.message || '生成失败', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '生成登录码';
    }
  });

  $('btn-refresh-invites').addEventListener('click', loadInvites);

  $('btn-copy-all').addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/invites');
      const usable = data.invites.filter((i) => !i.revoked);
      if (!usable.length) return toast('还没有可用的登录码', true);
      // 每行一个码，方便逐个粘给评委
      const text = usable.map((i) => i.code).join('\n');
      const ok = await copyText(text);
      toast(ok ? `已复制 ${usable.length} 个登录码` : '复制失败', !ok);
    } catch (err) {
      toast(err.message || '复制失败', true);
    }
  });

  /* ------------------------------ 场次控制 ------------------------------ */

  async function loadRounds() {
    try {
      const data = await api('/api/admin/rounds');
      state.rounds = data;
      state.started = data.rounds.length > 0;
      renderRounds(data);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) toast(err.message || '加载失败', true);
    }
  }

  let lastPhase = null;
  let lastRoundsSig = '';

  function renderRounds(data) {
    const judgeCount = data.judgeCount;
    const live = data.live;

    // ⚠️ 数据没变就**不要**重建 DOM。
    //    这个页面每 20 秒自动刷新一次，无条件重建会：
    //      · 把主持人正在选的「跳到指定演讲者」下拉框重置回第一项
    //      · 把正要点的「重开」按钮从手指底下换掉（点击落在被替换掉的节点上就丢了）
    const sig = JSON.stringify([
      data.live,
      data.rounds,
      data.judgeCount,
      data.anomalies,
      data.codes,
      data.unstartedContestants,
      data.phase,
      (state.configDraft.contestants || []).map((c) => [c.id, c.name]),
    ]);
    if (sig === lastRoundsSig) return;
    lastRoundsSig = sig;

    // ---- 顶部控制条：主持人盯着这一块决定什么时候切下一位 ----
    $('live-name').textContent = live ? `第 ${live.seq} 位 · ${live.name}` : '尚未开始';
    $('live-count').textContent = live
      ? `已收 ${live.submitted} / ${judgeCount} 位评委`
      : `共 ${data.rounds.length} 位已结束 · 应到 ${judgeCount} 位评委`;

    // 全部演讲者都上过场之后，advance 会返回 no_more_rounds —— 提前禁用并说明
    const advanceBtn = $('btn-advance');
    const exhausted = data.unstartedContestants === 0;
    advanceBtn.disabled = exhausted;
    advanceBtn.textContent = exhausted ? '名单已跑完' : live ? '开始下一位 ▶' : '开始第一位 ▶';

    // ---- 异常告警 ----
    const box = $('rounds-anomaly');
    box.hidden = data.anomalies.length === 0;
    if (data.anomalies.length) {
      $('rounds-anomaly-text').textContent =
        data.anomalies.join(' ') +
        ' 这通常意味着有人清掉浏览器缓存后又领到了新的登录码 —— 请当场核对。';
    }

    // ---- 跳到指定演讲者（应对临时调序 / 中途补位）----
    const opts = (state.configDraft.contestants || [])
      .map((c) => `<option value="${c.id}">${esc(c.seq + '. ' + c.name)}</option>`)
      .join('');
    $('jump-contestant').innerHTML = opts || '<option value="">名单为空</option>';
    $('btn-jump').disabled = !opts;

    // ---- 登录码概况 ----
    $('codes-summary').textContent =
      `登录码 ${data.codes.total} 个（可用 ${data.codes.active}，已作废 ${data.codes.revoked}）`;

    // ---- 场次列表（倒序，最近的在上）----
    const tbody = document.querySelector('#round-table tbody');
    if (!data.rounds.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">还没有开始任何一场</td></tr>';
    } else {
      tbody.innerHTML = data.rounds
        .slice()
        .reverse()
        .map((r) => {
          const flags = [];
          if (r.over) flags.push('<b class="flag-danger">超员</b>');
          if (r.thin) flags.push('<span class="flag-warn">薄数据</span>');
          const reop =
            r.status === 'live'
              ? ''
              : `<button type="button" class="btn btn-sm" data-action="reopen" data-id="${r.roundId}" data-name="${esc(r.name)}">重开</button>`;
          return `
            <tr>
              <td class="col-seq">${r.seq}</td>
              <td><b>${esc(r.name)}</b> ${flags.join(' ')}</td>
              <td>${r.status === 'live' ? '<b class="flag-live">进行中</b>' : '已结束'}</td>
              <td class="num-cell">${r.submitted} / ${judgeCount}</td>
              <td class="col-op">${reop}</td>
            </tr>`;
        })
        .join('');
    }

    applyPhase(data.phase);
    lastPhase = data.phase;
  }

  function applyPhase(phase) {
    const chip = $('phase-chip');
    const isOpen = phase === 'open';
    chip.textContent = isOpen ? '投票进行中' : '已封盘';
    chip.className = 'phase-chip ' + (isOpen ? 'is-open' : 'is-closed');
    $('btn-phase').textContent = isOpen ? '封盘' : '重新开放';
  }

  $('btn-refresh-rounds').addEventListener('click', loadRounds);

  $('btn-advance').addEventListener('click', () => {
    const live = state.rounds && state.rounds.live;
    const name = live ? live.name : null;

    confirmModal(
      live ? '切到下一位' : '开始第一位',
      live
        ? `确定结束「${name}」这一场吗？还没提交的评委将记为弃权 —— 之后他们的评分不再计入这一场。`
        : '确定开始第一位演讲者的评分吗？所有已登录的评委会立即看到打分页。',
      live ? '开始下一位' : '开始',
      async () => {
        try {
          const data = await api('/api/admin/rounds/advance', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          toast(`已开始第 ${data.round.seq} 位：${data.round.name}`);
          loadRounds();
        } catch (err) {
          toast(err.message || '切换失败', true);
        }
      }
    );
  });

  $('btn-jump').addEventListener('click', () => {
    const sel = $('jump-contestant');
    const contestantId = Number(sel.value);
    if (!contestantId) return toast('请先选择一位演讲者', true);
    const label = sel.options[sel.selectedIndex].textContent;

    confirmModal(
      '跳到指定演讲者',
      `确定直接开始「${label}」这一场吗？当前进行中的场次会立即结束，未提交的评委记为弃权。`,
      '开始这一位',
      async () => {
        try {
          const data = await api('/api/admin/rounds/advance', {
            method: 'POST',
            body: JSON.stringify({ contestantId }),
          });
          toast(`已开始第 ${data.round.seq} 位：${data.round.name}`);
          loadRounds();
        } catch (err) {
          toast(err.message || '切换失败', true);
        }
      }
    );
  });

  document.querySelector('#round-table').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-action="reopen"]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const name = btn.dataset.name;

    confirmModal(
      '重开这一场',
      `确定重开「${name}」吗？会为他/她新开一场重新打分，` +
        '**原场次不再计分**，已经交过的评委需要重新打一次。',
      '重开',
      async () => {
        try {
          const data = await api(`/api/admin/rounds/${id}/reopen`, { method: 'POST', body: JSON.stringify({}) });
          toast(data.message || '已重开');
          loadRounds();
        } catch (err) {
          toast(err.message || '重开失败', true);
        }
      }
    );
  });

  $('btn-reset').addEventListener('click', () => {
    confirmModal(
      '清空演练数据',
      '会删掉**所有场次和选票**，用于彩排后重新开始。演讲者名单、评分维度、登录码都会保留，' +
        '登录码不会失效。此操作不可撤销。',
      '确认清空',
      async () => {
        try {
          const data = await api('/api/admin/reset', {
            method: 'POST',
            body: JSON.stringify({ confirm: 'RESET' }),
          });
          toast(data.message || '已清空');
          loadRounds();
        } catch (err) {
          toast(err.message || '清空失败', true);
        }
      }
    );
  });

  $('btn-phase').addEventListener('click', () => {
    if (lastPhase === 'open') {
      confirmModal(
        '封盘',
        '封盘后所有链接都不能再提交新选票，已提交的照常计票。确定现在封盘吗？',
        '确定封盘',
        async () => {
          try {
            await api('/api/admin/close', { method: 'POST' });
            toast('已封盘');
            loadProgress();
            if (state.activeTab === 'results') loadResults();
          } catch (err) {
            toast(err.message || '操作失败', true);
          }
        }
      );
    } else {
      confirmModal(
        '重新开放投票',
        '重新开放后，尚未提交的链接可以继续提交。确定要重新开放吗？',
        '确定重新开放',
        async () => {
          try {
            await api('/api/admin/reopen', { method: 'POST', body: JSON.stringify({ confirm: true }) });
            toast('已重新开放');
            loadProgress();
          } catch (err) {
            toast(err.message || '操作失败', true);
          }
        }
      );
    }
  });

  $('btn-backup').addEventListener('click', () => {
    // 走浏览器下载；服务端用 SQLite 在线备份 API 生成一致性快照
    window.location.href = '/api/admin/backup';
    toast('已开始下载数据库备份');
  });

  /* -------------------------------- 结果 -------------------------------- */

  async function loadResults() {
    try {
      const data = await api('/api/admin/results');
      state.results = data;
      renderResults(data);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        $('rank-table').querySelector('tbody').innerHTML =
          `<tr class="empty-row"><td>${esc(err.message || '加载失败')}</td></tr>`;
      }
    }
  }

  /**
   * 名次 → 徽章配色 class：前三名给金 / 银 / 铜。
   *
   * ⚠️ 这是**名次**配色，不是奖级 —— 奖级已从结果页撤掉。两者边界并不重合
   * （一等奖 2 名、二等奖 3 名，而这里是前三名），所以别再按奖级想这件事。
   * 颜色变量仍叫 --gold / --silver / --bronze，见 common.css。
   */
  function medalClass(r) {
    if (r.blank || r.needsVote) return '';
    return { 1: 'is-gold', 2: 'is-silver', 3: 'is-bronze' }[r.rank] || '';
  }

  /**
   * 这一行的名次是**怎么定下来的**。
   *
   * 《评选方案》规定最终得分四舍五入保留 2 位小数，所以同分是常态；
   * 两行都显示 4.63 却一前一后，不给说法现场就会以为排错了。
   */
  function tieNote(r, data) {
    if (r.blank) return '';
    if (r.needsVote) return '四条顺位全同，需评委组投票定名次（系统不代劳）';
    if (!r.tieBreakLevel) return '';
    const hit = (data.tieBreak || []).find((c) => c.level === r.tieBreakLevel);
    const what = hit ? `${hit.name}（${hit.weight}%）原始均分` : '全部评委不去分的加权总分';
    return `总分与另一位相同，按第 ${r.tieBreakLevel} 顺位「${what}」区分`;
  }

  function renderResults(data) {
    const rows = data.rows;
    const totalBallots = rows.reduce((s, r) => s + r.n, 0);

    // 横幅：只陈述当前状态，不再展开说明为什么不能提前公布。
    // 比赛没结束时名次只是**暂定** —— 后面还有作品上场，名次随时会变，得说清楚。
    const banner = $('result-banner');
    if (data.phase === 'open') {
      banner.className = 'result-banner is-live';
      banner.textContent = `比赛进行中（已收 ${totalBallots} 份评分）· 名次为暂定`;
    } else {
      banner.className = 'result-banner is-closed';
      banner.textContent = `投票已结束（共 ${totalBallots} 份评分）`;
    }

    // 一致性告警
    const integrity = data.integrity;
    $('integrity-warning').hidden = !integrity || integrity.ok;
    if (integrity && !integrity.ok) $('integrity-text').textContent = integrity.message;

    if (data.insufficient) {
      $('result-meta').innerHTML = '';
      $('rank-table').querySelector('thead').innerHTML = '';
      $('rank-table').querySelector('tbody').innerHTML =
        '<tr class="empty-row"><td>数据不足：还没有任何有效选票，无法排名。</td></tr>';
      return;
    }

    // 概要行：只呈现当前结果本身，不讲解计分规则（规则见 Excel 的「计分说明」页）。
    // ⚠️ 不再重复「有效评分 N 份」—— 份数已经在上面那条横幅里了，同一屏说两遍只是噪声。
    const thinList = rows.filter((r) => r.thin);
    const voteList = rows.filter((r) => r.needsVote);
    const sup = data.superseded || [];
    $('result-meta').innerHTML =
      `共 <b>${rows.length}</b> 位` +
      (thinList.length
        ? ` · <span class="flag-warn">⚠️ 第 ${thinList.map((r) => r.seq).join('、')} 位票数不超过 2 张，结论不可靠</span>`
        : '') +
      (voteList.length
        ? `<br /><span class="flag-warn">⚠️ 第 ${voteList.map((r) => r.seq).join('、')} 位四条顺位全同，需评委组投票定名次</span>`
        : '') +
      (sup.length
        ? `<br /><span class="hint">已作废（被重开顶掉）：第 ${sup.map((s) => s.seq).join('、')} 位，不计入排名。</span>`
        : '');

    // 名次表
    //
    // ⚠️ 只留**名次 + 演讲者 + 项目 + 加权总分**。不列五个维度各自的均分（会淹没名次），
    //    也不列奖级和票数 —— 现场公布要的是一眼看懂谁第几，其余都在「明细」页和 Excel 里。
    //    奖级仍然照《评选方案》算，只是不在这一页显示；Excel 的「汇总」工作表里还有。
    const thead = $('rank-table').querySelector('thead');
    thead.innerHTML =
      '<tr>' +
      '<th class="col-rank">名次</th>' +
      '<th class="name-cell">演讲者</th>' +
      '<th>项目</th>' +
      '<th class="num-cell">加权总分</th>' +
      '</tr>';

    const tbody = $('rank-table').querySelector('tbody');
    tbody.innerHTML = rows
      .map((r) => {
        const medal = medalClass(r);

        // 名次徽章：并列待投票的单独着色，其余前三名按金/银/铜着色
        const badge = ['rank-badge', r.blank ? '' : 'is-big', r.needsVote ? 'is-vote' : '', medal]
          .filter(Boolean)
          .join(' ');
        const rankCell = r.blank ? '<span class="rank-badge">—</span>' : `<span class="${badge}">${r.rank}</span>`;

        // 「这个分数只靠一两张票」原本挂在维度格上，维度列没了之后挪到演讲者这格 ——
        // 它们本来就是**场次级**的属性，挂在这里比挂在某一维度上更准确
        const flags = [];
        if (r.thin) {
          flags.push('<span class="flag-warn" title="本场有效票数不超过 2 张，去分保护失效，结论不可靠">薄数据</span>');
        }
        if (r.trim && r.trim.single) {
          flags.push('<span class="flag-warn" title="本场只收到 1 张票，等于由一位评委决定">仅1票</span>');
        }
        if (r.trim && r.trim.trimmedToOne) {
          flags.push(
            '<span class="flag-warn" title="本场收到 3 张票，去掉一个最高和一个最低总分后只剩中间那一位，等于由他一个人决定">去分后剩1票</span>'
          );
        }

        // 同分被顺位分开了：把「凭什么他排前面」写在分数旁边。
        // 最终得分取整到 2 位小数之后同分是常态，不说清楚现场会以为排错了。
        const note = tieNote(r, data);
        const scoreCell = r.blank
          ? '—'
          : `${fmt2(r.total)}${note ? ` <span class="tie-note" title="${esc(note)}">同分</span>` : ''}`;

        return `
          <tr${r.blank ? ' style="opacity:.55"' : ''}>
            <td class="col-rank">${rankCell}</td>
            <td class="name-cell">${esc(r.name)}${flags.length ? ' ' + flags.join(' ') : ''}</td>
            <td class="project-cell">${esc(r.project)}</td>
            <td class="total-cell">${scoreCell}</td>
          </tr>`;
      })
      .join('');
  }

  $('btn-refresh-results').addEventListener('click', loadResults);

  $('btn-export').addEventListener('click', () => {
    if (!state.results || state.results.insufficient) {
      return toast('还没有有效选票，无法导出', true);
    }
    // 走浏览器下载；Excel 由服务端生成，用带 Cookie 的同源请求即可
    window.location.href = '/api/admin/results.xlsx';
    toast('已开始下载 Excel');
  });

  /* ------------------------------ 评分明细 ------------------------------ */

  /**
   * 每位评委（登录码）× 每个维度的打分明细 —— 一张整宽的矩阵。
   *
   * ⚠️ 这张表之所以存在，是因为 2026-09-18 起选票带 code 列 —— 见 src/db.js 文件头。
   *    在此之前选票与登录码无任何关联键，这张表在结构上就画不出来。
   *
   * 布局：**一张表**吃掉整个页宽（不是一人一张小卡片并排）。每位演讲者一段：
   * 先一行跨列的「姓名 - 项目名」，随后是这位演讲者的评委行。
   * 行 = 登录码，列 = 维度，末列小计。
   *
   * 表头**钉在顶部**：整张表只有这一个滚动容器，滚轮走多远，「哪一列是哪个维度」
   * 都还在眼前 —— 这正是把所有人放进同一张表、而不是拆成多张各自滚动的原因。
   *
   * 刻意**不参与 20 秒自动刷新**：重建 DOM 会把滚动位置冲掉。主持人手动点「刷新」。
   */
  async function loadDetail() {
    try {
      const data = await api('/api/admin/results');
      state.detail = data;
      renderDetail(data);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        $('detail-table').querySelector('tbody').innerHTML =
          `<tr class="empty-row"><td>${esc(err.message || '加载失败')}</td></tr>`;
      }
    }
  }

  function renderDetail(data) {
    const dims = data.dimensions;
    const rounds = (data.rows || []).slice().sort((a, b) => a.seq - b.seq);
    const judges = data.judgeDetail || [];

    const thead = $('detail-table').querySelector('thead');
    const tbody = $('detail-table').querySelector('tbody');
    const span = dims.length + 2; // 登录码 + 各维度 + 小计

    if (!rounds.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr class="empty-row"><td>还没有开始任何一场。</td></tr>';
      return;
    }

    thead.innerHTML =
      '<tr><th class="dt-code">登录码</th>' +
      dims.map((d) => `<th class="dt-dim">${esc(d.name)}</th>`).join('') +
      '<th class="dt-sub">小计</th></tr>';

    // 每位评委的明细按 roundId 建索引，避免在演讲者的循环里反复 find
    const indexed = judges.map((j) => ({
      judge: j,
      byRound: new Map(j.rounds.map((x) => [x.roundId, x])),
    }));

    // 没有签发过任何登录码时，每位演讲者下面都要有一句交代，否则只有一行光秃秃的名字
    const noCodes = `<tr class="empty-row"><td colspan="${span}">还没有签发任何登录码。</td></tr>`;

    tbody.innerHTML = rounds
      .map((r) => {
        // 段首跨列行：姓名 - 项目名。跨整行，所以读的时候不会把它认成某一位评委
        const nameRow = `<tr class="dt-name-row"><td colspan="${span}"><span class="dt-name">${esc(
          r.name
        )}</span>${
          r.project
            ? `<span class="dt-dash"> - </span><span class="dt-project">${esc(r.project)}</span>`
            : ''
        }</td></tr>`;

        const body = indexed
          .map(({ judge: j, byRound }) => {
            const cell = byRound.get(r.roundId);

            // 这一行的加权总分如果是被「去掉一高一低」去掉的那两个之一，
            // 服务端会在 cell 上标出 trimmedAs（见 markTrimmedJudges）。
            // ⚠️ 标签挂在**登录码右侧**，但要放在「已作废」之前 —— 作废是码本身的状态，
            //    去分是这个码在这**一场**里的处境，读起来先人后事。
            const trimmedAs = cell && cell.trimmedAs;
            const trimTag = trimmedAs
              ? `<span class="dt-trim-tag"${
                  cell.trimTied
                    ? ' title="这一场有另一位评委的总分与它相同，去掉其中任何一位，结果都一样"'
                    : ''
                }>（${trimmedAs === 'high' ? '最高分' : '最低分'}）</span>`
              : '';

            // 登录码列只留码本身。原来还挂一行「已评 N 位」，在整宽表里每一个码下面
            // 都重复一遍，属于噪音；弃权与否看「—」就行
            let tds = `<td class="dt-code">${esc(j.code)}${trimTag}${
              j.revoked ? ' <span class="flag-warn">已作废</span>' : ''
            }</td>`;
            dims.forEach((d) => {
              const v = cell ? cell.scores[d.id] : undefined;
              tds +=
                v === undefined
                  ? '<td class="dt-cell dt-miss">—</td>'
                  : `<td class="dt-cell">${v}</td>`;
            });
            tds +=
              cell && cell.total !== null && cell.total !== undefined
                ? `<td class="dt-sub">${fmt2(cell.total)}</td>`
                : '<td class="dt-sub dt-miss">—</td>';

            // 被去掉的那一行整行画一条浅浅的横线，见 admin.css 的 .is-trimmed
            return `<tr${trimmedAs ? ' class="is-trimmed"' : ''}>${tds}</tr>`;
          })
          .join('');

        return nameRow + (body || noCodes);
      })
      .join('');
  }

  $('btn-refresh-detail').addEventListener('click', loadDetail);

  // 明细页导出的是**明细报表**（只有逐条打分），与结果页的**结果报表**是两份东西
  $('btn-export-detail').addEventListener('click', () => {
    if (!state.detail || !state.detail.rows || !state.detail.rows.length) {
      return toast('还没有开始任何一场，没有明细可导出', true);
    }
    window.location.href = '/api/admin/detail.xlsx';
    toast('已开始下载评分明细');
  });

  /* -------------------------------- 启动 -------------------------------- */

  async function bootApp() {
    const config = await api('/api/admin/config');
    state.configDraft = {
      activityName: config.activityName,
      contestants: config.contestants.map((c) => ({ ...c })),
      dimensions: config.dimensions.map((d) => ({ ...d })),
    };
    state.started = config.started;
    $('brand-activity').textContent = config.activityName || '管理后台';
    applyPhase(config.phase);
    lastPhase = config.phase;
    renderConfig();
    // 默认落在「场次」页 —— 比赛当天主持人的全部操作都在这一页
    switchTab('rounds');
  }

  (async () => {
    try {
      const session = await api('/api/admin/session');
      if (session.authed) {
        showApp();
        await bootApp();
        return;
      }
    } catch {
      /* 未登录或网络异常，走登录页 */
    }
    showLogin();
  })();
})();
