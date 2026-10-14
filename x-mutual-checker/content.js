// 运行在扩展隔离环境：界面面板、历史记录（chrome.storage）、与 inject.js 通信
(() => {
  if (window.top !== window) return;

  const SRC_IN = 'xmf-content';
  const SRC_OUT = 'xmf-page';
  const DELAY_MIN = 3000; // 批量取关间隔（毫秒），别调太小，避免被 X 风控
  const DELAY_MAX = 7000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 兜底取关的后台标签页：自动点“正在关注 → 取消关注”
  const autoId = new URLSearchParams(location.search).get('xmf_unfollow');
  if (autoId) {
    autoUnfollow(autoId);
    return;
  }

  // ---------- 工具 ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const fmtNum = (n) => (n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(n || 0));
  const fmtDate = (t) => {
    const d = new Date(t);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function getViewerId() {
    const m = document.cookie.match(/(?:^|;\s*)twid=([^;]+)/);
    if (!m) return null;
    const mm = decodeURIComponent(m[1]).match(/u=(\d+)/);
    return mm ? mm[1] : null;
  }
  function getMyHandle() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return a ? a.getAttribute('href').replace(/^\//, '') : null;
  }

  async function waitFor(sel, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  async function autoUnfollow(id) {
    const key = 'xmf_tab_' + id;
    let result;
    try {
      const btn = await waitFor(`[data-testid="${id}-unfollow"]`, 15000);
      if (!btn) {
        result = document.querySelector(`[data-testid="${id}-follow"]`)
          ? { ok: true, note: '本来就没关注' }
          : { ok: false, error: '找不到“正在关注”按钮' };
      } else {
        btn.click();
        const confirmBtn = await waitFor('[data-testid="confirmationSheetConfirm"]', 5000);
        if (confirmBtn) confirmBtn.click();
        const done = await waitFor(`[data-testid="${id}-follow"]`, 8000);
        result = done ? { ok: true } : { ok: false, error: '点击后未生效' };
      }
    } catch (e) {
      result = { ok: false, error: String(e) };
    }
    chrome.storage.local.set({ [key]: result });
  }

  // ---------- 与页面脚本通信 ----------
  const pending = new Map();
  let seq = 0;
  function callPage(type, data = {}) {
    return new Promise((resolve) => {
      const reqId = ++seq;
      pending.set(reqId, resolve);
      window.postMessage({ source: SRC_IN, type, reqId, ...data }, location.origin);
    });
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SRC_OUT) return;
    const d = e.data;
    if (d.reqId && pending.has(d.reqId)) {
      pending.get(d.reqId)(d);
      pending.delete(d.reqId);
    } else if (d.type === 'progress') {
      onScanProgress(d);
    }
  });

  // ---------- 存储 ----------
  let viewerId = null;
  const skey = () => 'xmf_' + viewerId;
  async function load() {
    const r = await chrome.storage.local.get(skey());
    return Object.assign(
      { mutual: {}, unfollowers: {}, ignored: {}, counts: {}, nonFollowback: [], lastScanAt: 0, lastCount: 0, unknown: 0 },
      r[skey()] || {}
    );
  }
  function fixZeroCounts(st) {
    for (const list of [st.nonFollowback, Object.values(st.unfollowers)])
      if (list.length >= 5 && list.every((u) => !u.followers)) list.forEach((u) => (u.followers = null));
    return st;
  }
  const save = () => chrome.storage.local.set({ [skey()]: S.st });

  // ---------- 状态 ----------
  const S = {
    st: null,
    tab: 'unf',
    onlyBlue: true,
    q: '',
    sel: new Set(),
    rowStatus: {},
    scanning: false,
    bulk: false,
    stopBulk: false,
  };

  // ---------- 界面 ----------
  const R = {};
  const ref = (name, el) => (R[name] = el);

  const root = h(
    'div',
    { id: 'xmf-root' },
    ref(
      'panel',
      h(
        'div',
        { class: 'xmf-panel', hidden: true },
        h(
          'div',
          { class: 'xmf-head' },
          h('div', null, h('div', { class: 'xmf-title' }, '互关检测 · 蓝V'), ref('sub', h('div', { class: 'xmf-sub' }))),
          h('button', { class: 'xmf-x', title: '关闭', onclick: () => togglePanel(false) }, '×')
        ),
        h(
          'div',
          { class: 'xmf-bar' },
          ref('scanBtn', h('button', { class: 'xmf-btn pri', onclick: () => startScan() }, '开始扫描')),
          ref('stopBtn', h('button', { class: 'xmf-btn danger', hidden: true, onclick: () => stopScan() }, '停止扫描')),
          ref('prog', h('span', { class: 'xmf-prog' }))
        ),
        ref(
          'pwrap',
          h(
            'div',
            { class: 'xmf-pwrap', hidden: true },
            ref('pbar', h('div', { class: 'xmf-pbar' }, ref('pfill', h('div', { class: 'xmf-pfill' })))),
            ref('ptext', h('div', { class: 'xmf-ptext' }))
          )
        ),
        h(
          'div',
          { class: 'xmf-tabs' },
          ref('tabUnf', h('button', { class: 'on', onclick: () => setTab('unf') }, '取关了我 ', ref('cUnf', h('b', null, '0')))),
          ref('tabNfb', h('button', { onclick: () => setTab('nfb') }, '未回关 ', ref('cNfb', h('b', null, '0'))))
        ),
        h(
          'div',
          { class: 'xmf-tools' },
          h(
            'label',
            null,
            ref(
              'blue',
              h('input', {
                type: 'checkbox',
                checked: true,
                onchange: (e) => {
                  S.onlyBlue = e.target.checked;
                  resetPaging();
                  render();
                },
              })
            ),
            ' 仅蓝V'
          ),
          h('input', {
            class: 'xmf-q',
            placeholder: '搜索名称 / 用户名',
            oninput: (e) => {
              S.q = e.target.value.trim().toLowerCase();
              resetPaging();
              render();
            },
          })
        ),
        ref('hint', h('div', { class: 'xmf-hint' })),
        ref('list', h('div', { class: 'xmf-list' })),
        h(
          'div',
          { class: 'xmf-foot' },
          h(
            'label',
            null,
            ref('all', h('input', { type: 'checkbox', onchange: (e) => selectAll(e.target.checked) })),
            ' 全选'
          ),
          ref('selN', h('span', { class: 'xmf-seln' })),
          h('div', { class: 'xmf-sp' }),
          h('button', { class: 'xmf-btn', onclick: () => exportCsv() }, '导出CSV'),
          ref('bulkBtn', h('button', { class: 'xmf-btn danger', onclick: () => bulkUnfollow() }, '取关选中'))
        )
      )
    )
  );

  // ---------- 右下角浮窗：图标按钮 + 未读角标 + 扫描进度环，可上下拖动 ----------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    kids.forEach((c) => el.append(c));
    return el;
  }
  const RING_R = 25;
  const RING_C = 2 * Math.PI * RING_R;

  function buildDock() {
    const icon = svg(
      'svg',
      { class: 'xmf-ico', viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true' },
      svg('path', { d: 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5' })
    );
    R.ringFg = svg('circle', { class: 'xmf-ring-fg', cx: '28', cy: '28', r: String(RING_R) });
    const ring = svg(
      'svg',
      { class: 'xmf-ring', viewBox: '0 0 56 56', 'aria-hidden': 'true' },
      svg('circle', { class: 'xmf-ring-bg', cx: '28', cy: '28', r: String(RING_R) }),
      R.ringFg
    );
    R.ringFg.style.strokeDasharray = RING_C;
    R.ringFg.style.strokeDashoffset = RING_C;
    R.fabPct = h('span', { class: 'xmf-fab-pct' });
    R.fabBadge = h('span', { class: 'xmf-fab-badge', hidden: true });
    R.fabTip = h('span', { class: 'xmf-fab-tip' }, '互关检测');
    R.fab = h('button', { class: 'xmf-fab', 'aria-label': 'X 互关检测' }, ring, icon, R.fabPct);
    R.dock = h('div', { class: 'xmf-dock' }, R.fabTip, R.fab, R.fabBadge);
    bindDrag();
    return R.dock;
  }

  // 拖动：按住上下拖，松开记住位置；没拖动就当作点击
  const DOCK = { y: null };
  function placeDock(y) {
    const max = window.innerHeight - 56 - 12;
    DOCK.y = Math.max(12, Math.min(max, y == null ? window.innerHeight - 56 - 96 : y));
    R.dock.style.top = DOCK.y + 'px';
    placePanel();
  }
  function placePanel() {
    if (!R.panel || R.panel.hidden) return;
    const ph = R.panel.offsetHeight || 600;
    const dockY = DOCK.y == null ? window.innerHeight - 56 - 96 : DOCK.y;
    const top = Math.max(12, Math.min(window.innerHeight - ph - 12, dockY + 56 - ph));
    R.panel.style.top = top + 'px';
  }
  function bindDrag() {
    let start = null;
    R.fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { y: e.clientY, top: DOCK.y, moved: false };
      R.fab.setPointerCapture(e.pointerId);
    });
    R.fab.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dy = e.clientY - start.y;
      if (!start.moved && Math.abs(dy) < 5) return;
      start.moved = true;
      R.dock.classList.add('dragging');
      placeDock(start.top + dy);
    });
    R.fab.addEventListener('pointerup', () => {
      if (!start) return;
      const moved = start.moved;
      start = null;
      R.dock.classList.remove('dragging');
      if (moved) {
        try {
          chrome.storage.local.set({ xmf_dock_y: DOCK.y / window.innerHeight });
        } catch {}
      } else togglePanel();
    });
    R.fab.addEventListener('pointercancel', () => {
      start = null;
      R.dock.classList.remove('dragging');
    });
    window.addEventListener('resize', () => placeDock(DOCK.y));
  }

  // 角标：取关了我的人数（只算没忽略的）
  function updateBadge() {
    if (!R.fabBadge || !S.st) return;
    const n = Object.values(S.st.unfollowers).filter((u) => !S.st.ignored[u.id]).length;
    R.fabBadge.hidden = !n || S.scanning;
    R.fabBadge.textContent = n > 99 ? '99+' : String(n);
    R.fabTip.textContent = S.scanning ? '扫描中…' : n ? `${n} 个人取关了你` : '互关检测';
  }

  // 扫描时：按钮外圈显示进度，中间显示百分比
  function setFabProgress(pct, count) {
    const busy = pct != null || count != null;
    R.dock.classList.toggle('busy', busy);
    R.dock.classList.toggle('indet', busy && pct == null);
    R.ringFg.style.strokeDashoffset = pct == null ? RING_C * 0.75 : RING_C * (1 - pct / 100);
    R.fabPct.textContent = !busy ? '' : pct != null ? pct + '%' : String(count || 0);
    updateBadge();
  }

  function applyTheme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    root.classList.toggle('xmf-dark', m ? +m[0] + +m[1] + +m[2] < 240 : false);
  }

  root.prepend(buildDock());

  function setProg(t) {
    R.prog.textContent = t || '';
  }

  function togglePanel(force) {
    const show = force === undefined ? R.panel.hidden : force;
    R.panel.hidden = !show;
    R.dock.classList.toggle('open', show);
    if (show) {
      CNT.stopped = false;
      applyTheme();
      render();
      placePanel();
    }
  }

  function setTab(t) {
    S.tab = t;
    S.sel.clear();
    R.tabUnf.classList.toggle('on', t === 'unf');
    R.tabNfb.classList.toggle('on', t === 'nfb');
    resetPaging();
    render();
  }

  function baseList(tab) {
    const st = S.st;
    const src = tab === 'unf' ? Object.values(st.unfollowers) : st.nonFollowback;
    return src.filter((u) => !st.ignored[u.id] && (!S.onlyBlue || u.blue));
  }

  function currentList() {
    let list = baseList(S.tab);
    if (S.q)
      list = list.filter(
        (u) => (u.name || '').toLowerCase().includes(S.q) || (u.screen_name || '').toLowerCase().includes(S.q)
      );
    return S.tab === 'unf'
      ? list.sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))
      : list.sort((a, b) => (b.followers || 0) - (a.followers || 0));
  }

  // 列表只渲染前 PAGE 行，点“显示更多”再加，避免几千行一起渲染吃内存
  const PAGE = 100;
  const rowMeta = new Map(); // 用户id -> 粉丝数那一行的元素，补查到粉丝数时只改这一处

  function resetPaging() {
    S.limit = PAGE;
    R.list.scrollTop = 0;
  }

  function render() {
    updateBadge();
    if (!S.st || R.panel.hidden) return;
    const st = S.st;
    const handle = getMyHandle();
    R.sub.textContent =
      (handle ? '@' + handle + ' · ' : '') +
      (st.lastScanAt ? `上次扫描 ${fmtDate(st.lastScanAt)} · 关注 ${st.lastCount}` : '还没扫描过');
    R.cUnf.textContent = baseList('unf').length;
    R.cNfb.textContent = baseList('nfb').length;

    let hint = '';
    if (S.tab === 'unf') {
      if (!st.lastScanAt) hint = '首次使用：先扫描一次，记录下当前和你互关的人。以后再扫描，就会列出“曾经互关、后来取关了你”的账号。';
      else if (!Object.keys(st.unfollowers).length)
        hint = `已记录 ${Object.keys(st.mutual).length} 个互关账号作为基线。目前没发现取关你的人，隔几天再扫一次。想马上清理可以看“未回关”。`;
    } else {
      const all = st.nonFollowback.filter((u) => !st.ignored[u.id]);
      hint = `你关注了、但目前没有关注你的账号（包括从来没回关的）：共 ${all.length} 个，其中蓝V ${all.filter((u) => u.blue).length} 个。${S.onlyBlue ? '当前只显示蓝V，取消勾选“仅蓝V”可看全部。' : ''}`;
    }
    if (st.lastScanAt) hint += ' 结果已保存，打开面板就能看，不用每次都重新扫描。';
    if (st.lastCount && st.unknown > st.lastCount * 0.5)
      hint += ' ⚠ 有大量账号无法判断是否关注你，X 可能改了接口，结果可能不准。';
    R.hint.textContent = hint;
    R.hint.hidden = !hint;

    const list = currentList();
    S.list = list;
    const ids = new Set(list.map((u) => u.id));
    for (const id of [...S.sel]) if (!ids.has(id)) S.sel.delete(id);

    const shown = list.slice(0, S.limit || PAGE);
    S.shown = shown;
    rowMeta.clear();
    const kids = shown.length
      ? shown.map(row)
      : [h('div', { class: 'xmf-empty' }, st.lastScanAt ? '没有符合条件的账号' : '点击“开始扫描”')];
    if (list.length > shown.length)
      kids.push(
        h(
          'button',
          {
            class: 'xmf-more',
            onclick: () => {
              S.limit = (S.limit || PAGE) + PAGE;
              render();
            },
          },
          `显示更多（还有 ${list.length - shown.length} 个）`
        )
      );
    const top = R.list.scrollTop;
    R.list.replaceChildren(...kids);
    R.list.scrollTop = top;
    updateFoot();
  }

  function updateFoot() {
    const n = (S.list || []).length;
    R.selN.textContent = S.sel.size ? `已选 ${S.sel.size}` : '';
    R.all.checked = n > 0 && S.sel.size === n;
  }

  function metaText(u) {
    const parts = [
      u.followers != null ? fmtNum(u.followers) + ' 粉丝' : '粉丝数未知',
    ];
    if (u.detectedAt) parts.push('发现于 ' + fmtDate(u.detectedAt));
    return parts.join(' · ');
  }

  function row(u) {
    const status = S.rowStatus[u.id];
    const meta = h('span', null, metaText(u));
    rowMeta.set(u.id, { el: meta, u });
    return h(
      'div',
      { class: 'xmf-row' },
      h('input', {
        type: 'checkbox',
        checked: S.sel.has(u.id),
        onchange: (e) => {
          e.target.checked ? S.sel.add(u.id) : S.sel.delete(u.id);
          updateFoot();
        },
      }),
      h('img', { class: 'xmf-av', src: u.avatar || '', loading: 'lazy', decoding: 'async', alt: '' }),
      h(
        'div',
        { class: 'xmf-info' },
        h(
          'div',
          { class: 'xmf-name' },
          h('span', { class: 'xmf-nm' }, u.name || u.screen_name),
          u.blue ? h('span', { class: 'xmf-badge' + (u.verifiedType === 'Business' ? ' gold' : ''), title: '已认证' }, '✓') : null
        ),
        h('a', { class: 'xmf-handle', href: '/' + u.screen_name, target: '_blank', rel: 'noopener' }, '@' + u.screen_name),
        h(
          'div',
          { class: 'xmf-meta' },
          meta,
          status ? h('span', { class: 'xmf-rs' + (status.err ? ' err' : '') }, ' · ' + status.text) : null
        )
      ),
      h(
        'div',
        { class: 'xmf-acts' },
        h('button', { class: 'xmf-btn sm danger', disabled: S.bulk, onclick: () => unfollowSingle(u) }, '取关'),
        h('button', { class: 'xmf-btn sm', title: '以后不再显示', onclick: () => ignore(u) }, '忽略')
      )
    );
  }

  function selectAll(on) {
    S.sel.clear();
    if (on) (S.list || currentList()).forEach((u) => S.sel.add(u.id));
    render();
  }

  async function ignore(u) {
    S.st.ignored[u.id] = 1;
    S.sel.delete(u.id);
    await save();
    render();
  }

  // ---------- 粉丝数缓存：扫描时读到的粉丝数保存 7 天，下次兜底模式缺数据时直接用 ----------
  const COUNT_TTL = 7 * 24 * 3600e3;
  const CNT = { stopped: false };

  function applyCountCache(st, users) {
    const now = Date.now();
    for (const id in st.counts) if (now - st.counts[id][1] > COUNT_TTL) delete st.counts[id];
    for (const u of users) {
      if (u.followers != null) st.counts[u.id] = [u.followers, now];
      else if (st.counts[u.id]) u.followers = st.counts[u.id][0];
    }
  }

  // ---------- 扫描 ----------
  const SC = { token: 0, t0: 0, timer: 0, count: 0, total: 0, note: '' };

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
  }

  // 进度条 + 悬浮按钮上的百分比
  function drawProgress() {
    if (!S.scanning) return;
    const { count, total, t0 } = SC;
    const el = Date.now() - t0;
    const pct = total ? Math.min(99, Math.floor((count / total) * 100)) : 0;
    R.pfill.style.width = total ? pct + '%' : '';
    R.pbar.classList.toggle('indet', !total);
    let txt = total ? `已读取 ${count} / ${total}（${pct}%）` : `已读取 ${count} 个`;
    txt += ` · 用时 ${fmtDur(el)}`;
    if (total && count > 20 && count < total) txt += ` · 预计还要 ${fmtDur((el / count) * (total - count))}`;
    R.ptext.textContent = txt;
    setFabProgress(total ? pct : null, count);
    if (SC.note) setProg(SC.note);
  }

  function onScanProgress(d) {
    SC.count = d.count || 0;
    if (d.total) SC.total = d.total;
    SC.note = d.note || '';
    drawProgress();
  }

  function setScanningUI(on) {
    S.scanning = on;
    R.scanBtn.hidden = on;
    R.stopBtn.hidden = !on;
    R.stopBtn.disabled = false;
    R.stopBtn.textContent = '停止扫描';
    R.pwrap.hidden = !on;
    root.classList.toggle('xmf-busy', on);
    clearInterval(SC.timer);
    if (on) SC.timer = setInterval(drawProgress, 1000);
    else setFabProgress(null, null);
  }

  async function startScan() {
    if (S.scanning || S.bulk) return;
    const handle = getMyHandle();
    if (!handle) return setProg('没识别到你的账号，等页面加载完再试');
    const target = '/' + handle + '/following';
    const onFollowingPage = location.pathname.toLowerCase() === target.toLowerCase();
    const token = ++SC.token;
    // 进度条的总数：用上次扫描的关注数估算，在自己主页上能读到准确值
    const domTotal = readFollowingCount(handle);
    Object.assign(SC, { t0: Date.now(), count: 0, total: domTotal || S.st.lastCount || 0, note: '' });
    setScanningUI(true);
    setProg('正在读取关注列表…');
    drawProgress();
    // 快速模式在任何页面都能用；只有快速模式失败时才需要去关注页滚动
    const r = await callPage('scan', { viewerId, allowScroll: onFollowingPage, expectTotal: SC.total });
    if (token !== SC.token) return; // 已经被强制停止，结果作废
    setScanningUI(false);
    if (r.needScroll) {
      sessionStorage.setItem('xmf_autoscan', '1');
      setProg('快速模式不可用（' + (r.fastErr || '未知原因') + '），正在打开关注页改用滚动读取…');
      setTimeout(() => (location.href = target), 800);
      return;
    }
    finishScan(r, Date.now() - SC.t0);
  }

  function readFollowingCount(handle) {
    const a = document.querySelector(`a[href="/${handle}/following" i]`);
    const m = a && a.textContent.replace(/[,\s]/g, '').match(/^(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async function finishScan(r, elapsed) {
    if (r.error) return setProg(r.error);
    if (r.total) SC.total = r.total;
    const users = r.users || [];
    if (!users.length) return setProg(r.aborted ? '已停止，还没读到数据' : '没抓到关注数据，刷新页面后再试');
    const mutualN = users.filter((u) => u.followedBy === true).length;
    if (users.length >= 20 && mutualN === 0)
      return setProg('读取到的数据里看不出谁关注了你，X 可能改了接口，本次结果未保存，请把这个提示告诉开发者');
    const partial = !!r.aborted;
    const added = await applyScan(users, r.endReached && !partial, partial);
    const nfbN = users.filter((u) => u.followedBy === false).length;
    const modeTxt = r.mode === 'fast' ? '快速模式' : '滚动模式' + (r.fastErr ? '，快速模式不可用：' + r.fastErr : '');
    setProg(
      (partial ? `已停止，已保存读取到的 ${users.length} 个关注` : `扫描完成：关注 ${users.length}`) +
        `（互关 ${mutualN}，未回关 ${nfbN}），新发现 ${added} 个取关你的账号。用时 ${fmtDur(elapsed)}（${modeTxt}）` +
        (!partial && !r.endReached ? '。⚠ 可能没读到底，如果关注数和主页上差很多，请再扫一次' : '')
    );
    window.scrollTo(0, 0);
    if (added) setTab('unf');
    else render();
  }

  function stopScan() {
    if (!S.scanning) return;
    R.stopBtn.disabled = true;
    R.stopBtn.textContent = '正在停止…';
    SC.note = '正在停止，马上保存已读取的部分…';
    setProg(SC.note);
    window.postMessage({ source: SRC_IN, type: 'stopScan' }, location.origin);
    // 兜底：3 秒还没停下就直接结束界面上的扫描状态
    const token = SC.token;
    setTimeout(() => {
      if (S.scanning && token === SC.token) {
        SC.token++;
        setScanningUI(false);
        setProg('已停止');
      }
    }, 3000);
  }

  async function applyScan(users, endReached, partial) {
    const st = (S.st = await load());
    const now = Date.now();
    applyCountCache(st, users);
    const cur = new Map(users.map((u) => [u.id, u]));
    let added = 0;

    // 曾经互关、现在仍在我的关注里、但对方已不再关注我 => 取关了我
    for (const id of Object.keys(st.mutual)) {
      const u = cur.get(id);
      if (u && u.followedBy === false && !st.unfollowers[id]) {
        st.unfollowers[id] = { ...u, detectedAt: now };
        added++;
      }
    }
    for (const id of Object.keys(st.unfollowers)) {
      const u = cur.get(id);
      if (u) {
        if (u.followedBy) delete st.unfollowers[id]; // 又关注回来了
        else st.unfollowers[id] = { ...st.unfollowers[id], ...u, detectedAt: st.unfollowers[id].detectedAt };
      } else if (endReached) delete st.unfollowers[id]; // 我已经不关注他了
    }
    for (const u of users) if (u.followedBy) st.mutual[u.id] = 1;

    const fresh = users.filter((u) => u.followedBy === false);
    if (partial) {
      // 只读了一部分：读到的人用新结果，没读到的保留上次的结果
      st.nonFollowback = st.nonFollowback.filter((u) => !cur.has(u.id)).concat(fresh);
    } else {
      st.nonFollowback = fresh;
      st.unknown = users.filter((u) => u.followedBy == null).length;
      st.lastScanAt = now;
      st.lastCount = users.length;
    }
    await save();
    return added;
  }

  // ---------- 取关 ----------
  async function doUnfollow(u) {
    S.rowStatus[u.id] = { text: '取关中…' };
    render();
    let r = await callPage('unfollow', { id: u.id });
    if (!r.ok) {
      S.rowStatus[u.id] = { text: `接口失败(${r.error})，改用页面方式…` };
      render();
      r = await chrome.runtime
        .sendMessage({ type: 'unfollowViaTab', id: u.id, screen_name: u.screen_name, origin: location.origin })
        .catch((e) => ({ ok: false, error: String(e) }));
    }
    if (r && r.ok) {
      const st = S.st;
      delete st.unfollowers[u.id];
      delete st.mutual[u.id];
      st.nonFollowback = st.nonFollowback.filter((x) => x.id !== u.id);
      st.lastCount = Math.max(0, st.lastCount - 1);
      S.sel.delete(u.id);
      delete S.rowStatus[u.id];
      await save();
    } else {
      S.rowStatus[u.id] = { text: '失败：' + ((r && r.error) || '未知错误'), err: true };
    }
    render();
    return !!(r && r.ok);
  }

  async function unfollowSingle(u) {
    if (S.bulk) return;
    if (!confirm(`确定取关 @${u.screen_name}？`)) return;
    await doUnfollow(u);
  }

  async function bulkUnfollow() {
    if (S.bulk) {
      S.stopBulk = true;
      R.bulkBtn.textContent = '正在停止…';
      return;
    }
    const list = currentList().filter((u) => S.sel.has(u.id));
    if (!list.length) return setProg('先勾选要取关的账号');
    if (!confirm(`确定取关选中的 ${list.length} 个账号？\n每个之间会间隔 ${DELAY_MIN / 1000}-${DELAY_MAX / 1000} 秒，过程中可以随时停止。`))
      return;
    S.bulk = true;
    S.stopBulk = false;
    R.bulkBtn.textContent = '停止取关';
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length && !S.stopBulk; i++) {
      setProg(`取关中 ${i + 1}/${list.length}（成功 ${ok}，失败 ${fail}）`);
      (await doUnfollow(list[i])) ? ok++ : fail++;
      if (fail >= 3 && ok === 0) {
        setProg('连续失败，已暂停。可能被限流，过一会再试');
        break;
      }
      if (i < list.length - 1 && !S.stopBulk) await sleep(DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));
    }
    if (!(fail >= 3 && ok === 0)) setProg(`取关完成：成功 ${ok}，失败 ${fail}${S.stopBulk ? '（已手动停止）' : ''}`);
    S.bulk = false;
    R.bulkBtn.textContent = '取关选中';
    render();
  }

  function exportCsv() {
    const list = currentList();
    if (!list.length) return setProg('当前列表为空');
    const rows = [['名称', '用户名', '主页', '粉丝数', '蓝V', '发现时间']].concat(
      list.map((u) => [
        u.name,
        '@' + u.screen_name,
        location.origin + '/' + u.screen_name,
        u.followers,
        u.blue ? '是' : '否',
        u.detectedAt ? fmtDate(u.detectedAt) : '',
      ])
    );
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = h('a', {
      href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
      download: `x-${S.tab === 'unf' ? '取关了我' : '未回关'}-${fmtDate(Date.now()).slice(0, 10)}.csv`,
    });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- 启动 ----------
  async function init() {
    for (let i = 0; i < 40 && !(viewerId = getViewerId()); i++) await sleep(500);
    if (!viewerId) return; // 未登录
    S.st = fixZeroCounts(await load());

    // 开关：点浏览器工具栏上的插件图标切换，关闭时页面上不显示任何东西
    const setEnabled = (on, openPanel) => {
      if (on) {
        if (!root.isConnected) {
          document.body.append(root);
          applyTheme();
          chrome.storage.local.get('xmf_dock_y').then(({ xmf_dock_y }) =>
            placeDock(typeof xmf_dock_y === 'number' ? xmf_dock_y * window.innerHeight : null)
          );
          updateBadge();
        }
        if (openPanel) togglePanel(true);
      } else {
        if (S.scanning) stopScan();
        if (S.bulk) S.stopBulk = true;
        togglePanel(false);
        root.remove();
      }
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.xmf_enabled) setEnabled(!!changes.xmf_enabled.newValue, true);
    });
    const { xmf_enabled } = await chrome.storage.local.get('xmf_enabled');
    setEnabled(!!xmf_enabled, false);
    if (!xmf_enabled) return;

    if (sessionStorage.getItem('xmf_autoscan')) {
      sessionStorage.removeItem('xmf_autoscan');
      togglePanel(true);
      setProg('等待关注列表加载…');
      await waitFor('[data-testid="UserCell"]', 15000);
      await sleep(1000);
      startScan();
    }
  }
  init();
})();
