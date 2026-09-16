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

  const STATUS_LABEL = {
    issued: '已签发未打开',
    opened: '已领取未提交',
    submitted: '已提交',
    revoked: '已作废',
  };
  const STATUS_CLASS = { issued: 'is-faint', opened: 'is-warn', submitted: 'is-ok', revoked: 'is-faint' };
  const REFRESH_MS = 20000;

  const state = {
    activeTab: 'config',
    configDraft: { activityName: '', contestants: [], dimensions: [] },
    submittedCount: 0,
    results: null,
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
    if (tab === 'progress') loadProgress();
    if (tab === 'results') loadResults();
  }

  $('tabs').addEventListener('click', (event) => {
    const btn = event.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  function autoRefresh() {
    if (document.hidden || $('app-screen').hidden) return;
    if (state.activeTab === 'progress') loadProgress();
    else if (state.activeTab === 'results') loadResults();
  }

  /* -------------------------------- 配置 -------------------------------- */

  function setLockNotice() {
    const locked = state.submittedCount > 0;
    $('config-lock-notice').hidden = !locked;
    if (locked) {
      $('config-lock-text').textContent =
        `已有 ${state.submittedCount} 张选票提交。为保证选票与配置对得上，` +
        '现在只能修改名称、说明文字和权重，不能再增删参赛者或评分维度。';
    }
  }

  function renderConfig() {
    $('config-activity').value = state.configDraft.activityName;
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
        contestants: saved.contestants.map((c) => ({ ...c })),
        dimensions: saved.dimensions.map((d) => ({ ...d })),
      };
      state.submittedCount = saved.submittedCount;
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
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">还没有生成任何链接</td></tr>';
      return;
    }
    tbody.innerHTML = invites
      .map((inv, i) => {
        const locked = inv.status === 'submitted';
        const revokeBtn = locked
          ? `<button type="button" class="btn btn-sm" disabled
               title="已提交的链接不可作废：选票已与身份脱钩，无法定位该删哪张票">不可作废</button>`
          : inv.status === 'revoked'
            ? '<span class="hint">—</span>'
            : `<button type="button" class="btn btn-sm btn-danger" data-action="revoke" data-code="${esc(inv.code)}">作废</button>`;

        return `
          <tr>
            <td class="col-seq">${i + 1}</td>
            <td class="col-code">${esc(inv.code)}</td>
            <td>${esc(STATUS_LABEL[inv.status] || inv.status)}</td>
            <td>${esc(fmtTime(inv.opened_at))}</td>
            <td>${esc(fmtTime(inv.submitted_at))}</td>
            <td class="col-op" style="width:180px">
              <button type="button" class="btn btn-sm" data-action="copy" data-code="${esc(inv.code)}">复制</button>
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
      const ok = await copyText(`${location.origin}/v/${code}`);
      toast(ok ? `已复制 ${code} 的链接` : '复制失败，请手动选中复制', !ok);
      return;
    }

    if (btn.dataset.action === 'revoke') {
      confirmModal('作废链接', `确定要作废 ${code} 吗？作废后该链接打开会显示失效页，且无法恢复。`, '作废', async () => {
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
      toast(`已生成 ${data.created.length} 个链接`);
      loadInvites();
    } catch (err) {
      toast(err.message || '生成失败', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '生成链接';
    }
  });

  $('btn-refresh-invites').addEventListener('click', loadInvites);

  $('btn-copy-all').addEventListener('click', async () => {
    try {
      const data = await api('/api/admin/invites');
      const usable = data.invites.filter((i) => i.status !== 'revoked');
      if (!usable.length) return toast('还没有可用的链接', true);
      const text = usable.map((i) => `${i.code}\t${location.origin}/v/${i.code}`).join('\n');
      const ok = await copyText(text);
      toast(ok ? `已复制 ${usable.length} 条链接` : '复制失败', !ok);
    } catch (err) {
      toast(err.message || '复制失败', true);
    }
  });

  /* -------------------------------- 进度 -------------------------------- */

  async function loadProgress() {
    try {
      const data = await api('/api/admin/progress');
      renderProgress(data);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) toast(err.message || '加载失败', true);
    }
  }

  let lastPhase = null;

  function renderProgress(data) {
    const { counts, total } = data;
    const pct = total ? Math.round((counts.submitted / total) * 100) : 0;

    $('progress-submitted').textContent = counts.submitted;
    $('progress-total').textContent = total;
    $('progress-hero-fill').style.width = pct + '%';

    const cards = [
      { key: 'issued', label: '已签发未打开', desc: '刚领到、还没进打分页' },
      { key: 'opened', label: '已领取未提交', desc: '扫了码但没交卷' },
      { key: 'submitted', label: '已提交', desc: '选票已入库' },
      { key: 'revoked', label: '已作废', desc: '已失效的链接' },
    ];
    $('progress-stats').innerHTML = cards
      .map(
        (c) => `
        <div class="stat-card ${STATUS_CLASS[c.key]}">
          <div class="stat-card-num">${counts[c.key] ?? 0}</div>
          <div class="stat-card-label">${esc(c.label)}</div>
          <div class="stat-card-desc">${esc(c.desc)}</div>
        </div>`
      )
      .join('');

    const chase = data.codes.opened || [];
    $('chase-box').hidden = chase.length === 0;
    $('chase-chips').innerHTML = chase.map((c) => `<span class="code-chip">${esc(c)}</span>`).join('');

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

  $('btn-refresh-progress').addEventListener('click', loadProgress);

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

    // 横幅（PLAN §7.4 强制项）
    const banner = $('result-banner');
    if (data.phase === 'open') {
      banner.className = 'result-banner is-live';
      banner.textContent =
        `⚠️ 投票进行中（已提交 ${data.n} 张）— 请勿对外透露任何分数。` +
        '评审群里一句「目前第一是……」就会污染剩余选票，让排名向先投者收敛。';
    } else {
      banner.className = 'result-banner is-closed';
      banner.textContent = `✅ 投票已结束（有效选票 ${data.n} 张）— 结果可以公布了。`;
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

    // 一律去一高一低。k = N-2，N≤2 时已经没有剩余分数可平均了，如实说明而不是显示负数
    const trimText =
      data.k >= 1
        ? `每维度去掉一个最高分和一个最低分后，以 <b>${data.k}</b> 张计平均`
        : `每维度去掉一个最高分和一个最低分后<b>已无剩余分数</b>（有效票数 ${data.n} 张，需至少 3 张才能计分）`;
    $('result-meta').innerHTML =
      `有效选票 <b>${data.n}</b> 张 · ${trimText} · 总分区间 1.00–5.00`;

    // 名次表
    const thead = $('rank-table').querySelector('thead');
    thead.innerHTML =
      '<tr>' +
      '<th class="col-rank">名次</th>' +
      '<th>参赛者</th>' +
      '<th>项目</th>' +
      dims.map((d) => `<th class="num-cell">${esc(d.name)}<br /><span style="font-weight:400">${esc(d.weight)}%</span></th>`).join('') +
      '<th class="num-cell">加权总分</th>' +
      '</tr>';

    const tbody = $('rank-table').querySelector('tbody');
    tbody.innerHTML = rows
      .map((r) => {
        const tied = rows.filter((o) => o.u === r.u).length > 1;
        return `
          <tr data-contestant-id="${r.contestantId}">
            <td class="col-rank"><span class="rank-badge ${tied ? 'is-tie' : r.rank === 1 ? 'is-top' : ''}">${r.rank}</span></td>
            <td>${esc(r.name)}</td>
            <td>${esc(r.project)}</td>
            ${dims.map((d) => `<td class="num-cell">${fmt2(r.margins[d.id])}</td>`).join('')}
            <td class="total-cell">${fmt2(r.total)}</td>
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

  /* -------------------------------- 启动 -------------------------------- */

  async function bootApp() {
    const config = await api('/api/admin/config');
    state.configDraft = {
      activityName: config.activityName,
      contestants: config.contestants.map((c) => ({ ...c })),
      dimensions: config.dimensions.map((d) => ({ ...d })),
    };
    state.submittedCount = config.submittedCount;
    $('brand-activity').textContent = config.activityName || '管理后台';
    applyPhase(config.phase);
    lastPhase = config.phase;
    renderConfig();
    switchTab('config');
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
