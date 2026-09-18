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
    $('live-name').textContent = live ? `第 ${live.seq} 场 · ${live.name}` : '尚未开始';
    $('live-count').textContent = live
      ? `已收 ${live.submitted} / ${judgeCount} 位评委`
      : `共 ${data.rounds.length} 场已结束 · 应到 ${judgeCount} 位评委`;

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
          toast(`已开始第 ${data.round.seq} 场：${data.round.name}`);
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
          toast(`已开始第 ${data.round.seq} 场：${data.round.name}`);
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

  function renderResults(data) {
    const dims = data.dimensions;
    const rows = data.rows;
    const scored = rows.filter((r) => !r.blank);
    const totalBallots = rows.reduce((s, r) => s + r.n, 0);

    // 横幅：只陈述当前状态，不再展开说明为什么不能提前公布
    const banner = $('result-banner');
    if (data.phase === 'open') {
      banner.className = 'result-banner is-live';
      banner.textContent = `比赛进行中（已收 ${totalBallots} 份评分）`;
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

    // 概要行：只呈现当前结果本身，不讲解计分规则（规则见 Excel 的「计分说明」页）
    const thinList = rows.filter((r) => r.thin);
    const sup = data.superseded || [];
    $('result-meta').innerHTML =
      `共 <b>${rows.length}</b> 场 · 有效评分 <b>${totalBallots}</b> 份` +
      (thinList.length
        ? ` · <span class="flag-warn">⚠️ 第 ${thinList.map((r) => r.seq).join('、')} 场票数不超过 2 张，结论不可靠</span>`
        : '') +
      (sup.length
        ? `<br /><span class="hint">已作废（被重开顶掉）：第 ${sup.map((s) => s.seq).join('、')} 场，不计入排名。</span>`
        : '');

    // 名次表
    const thead = $('rank-table').querySelector('thead');
    thead.innerHTML =
      '<tr>' +
      '<th class="col-rank">名次</th>' +
      '<th>演讲者</th>' +
      '<th>项目</th>' +
      dims.map((d) => `<th class="num-cell">${esc(d.name)}<br /><span style="font-weight:400">${esc(d.weight)}%</span></th>`).join('') +
      '<th class="num-cell">加权总分</th>' +
      '<th class="num-cell">本场票数</th>' +
      '</tr>';

    const tbody = $('rank-table').querySelector('tbody');
    tbody.innerHTML = rows
      .map((r) => {
        const tied = !r.blank && scored.filter((o) => o.u === r.u).length > 1;
        const rankCell = r.blank
          ? '<span class="rank-badge">—</span>'
          : `<span class="rank-badge ${tied ? 'is-tie' : r.rank === 1 ? 'is-top' : ''}">${r.rank}</span>`;

        const marginCells = dims
          .map((d) => {
            const info = r.details[d.id] || {};
            const mark = info.single
              ? ' <span class="flag-warn" title="这一维度只收到 1 票，等于由一位评委决定">仅1票</span>'
              : '';
            const v = r.margins[d.id];
            return `<td class="num-cell">${v === null || v === undefined ? '—' : fmt2(v)}${mark}</td>`;
          })
          .join('');

        return `
          <tr${r.blank ? ' style="opacity:.55"' : ''}>
            <td class="col-rank">${rankCell}</td>
            <td>${esc(r.name)}${r.thin ? ' <span class="flag-warn">薄数据</span>' : ''}</td>
            <td>${esc(r.project)}</td>
            ${marginCells}
            <td class="total-cell">${r.blank ? '—' : fmt2(r.total)}</td>
            <td class="num-cell">${r.n}${r.submitted !== r.n ? ' ⚠️' : ''}</td>
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
   * 每位评委（登录码）× 每场 × 每个维度的打分矩阵。
   *
   * ⚠️ 这张表之所以存在，是因为 2026-09-18 起选票带 code 列 —— 见 src/db.js 文件头。
   *    在此之前选票与登录码无任何关联键，这张表在结构上就画不出来。
   *
   * 刻意**不参与 20 秒自动刷新**：表格很宽，重建 DOM 会把横向滚动位置冲掉。
   * 主持人手动点「刷新」即可。
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

    if (!rounds.length) {
      thead.innerHTML = '';
      tbody.innerHTML = '<tr class="empty-row"><td>还没有开始任何一场。</td></tr>';
      return;
    }

    // 交替底色按「场次」分组，让相邻演讲者的列块一眼能分开
    const g = (i) => 'g' + (i % 2);

    // 表头两行：第一行按演讲者跨列合并，第二行是维度名
    let headTop = '<tr><th class="dt-code" rowspan="2">登录码</th>';
    let headBottom = '<tr>';
    rounds.forEach((r, i) => {
      headTop += `<th class="dt-group ${g(i)}" colspan="${dims.length + 1}">第 ${r.seq} 场 · ${esc(r.name)}</th>`;
      dims.forEach((d) => {
        headBottom += `<th class="dt-dim ${g(i)}">${esc(d.name)}</th>`;
      });
      headBottom += `<th class="dt-sub ${g(i)}">本场小计</th>`;
    });
    thead.innerHTML = headTop + '</tr>' + headBottom + '</tr>';

    const rowsHtml = judges
      .map((j) => {
        const perRound = new Map(j.rounds.map((x) => [x.roundId, x]));
        const meta = j.revoked
          ? '<span class="flag-warn">已作废</span>'
          : `已交 ${j.roundsSubmitted} 场`;

        let tds = `<td class="dt-code">${esc(j.code)}<br /><span class="dt-meta">${meta}</span></td>`;

        rounds.forEach((r, i) => {
          const cls = g(i);
          const cell = perRound.get(r.roundId);
          dims.forEach((d) => {
            const v = cell ? cell.scores[d.id] : undefined;
            tds +=
              v === undefined
                ? `<td class="dt-cell dt-miss ${cls}">—</td>`
                : `<td class="dt-cell ${cls}">${v}</td>`;
          });
          tds +=
            cell && cell.total !== null && cell.total !== undefined
              ? `<td class="dt-sub ${cls}">${fmt2(cell.total)}</td>`
              : `<td class="dt-sub dt-miss ${cls}">—</td>`;
        });

        return `<tr>${tds}</tr>`;
      })
      .join('');

    // 末行：去分后的均分，作为逐格对照的基准
    let avg = '<td class="dt-code dt-avg">去分后均分</td>';
    rounds.forEach((r, i) => {
      const cls = g(i);
      dims.forEach((d) => {
        const v = r.margins[d.id];
        avg += `<td class="dt-avg ${cls}">${v === null || v === undefined ? '—' : fmt2(v)}</td>`;
      });
      avg += `<td class="dt-avg dt-sub ${cls}">${r.blank ? '—' : fmt2(r.total)}</td>`;
    });

    tbody.innerHTML =
      (rowsHtml || '<tr class="empty-row"><td>还没有签发任何登录码。</td></tr>') +
      `<tr class="dt-avg-row">${avg}</tr>`;
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
