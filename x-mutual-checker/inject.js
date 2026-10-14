// 运行在页面主环境（MAIN world）：
// 1. 快速模式：直接调用 X 网页版的 Following 接口翻页读取（每页 50 人，约 0.4 秒）
//    接口编号从 X 自己的代码里自动查找，X 更新后也能跟上
// 2. 兜底模式：快速模式不可用时，在关注页自动滚动，读取 X 自己加载的数据
// 3. 调用 X 的取关接口
(() => {
  if (window.__xmfInjected) return;
  window.__xmfInjected = true;

  const SRC_IN = 'xmf-content';
  const SRC_OUT = 'xmf-page';
  // X 网页版公开的 Bearer（所有登录用户通用）；优先使用从页面请求里捕获到的
  const FALLBACK_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const FALLBACK_QID = 'ath0FIohYC_c3Hj3SsxoCg'; // 2026-10 时的 Following 接口编号，找不到新的时才用
  const QID_KEY = 'xmf_qid_following';
  const FOLLOWING_RE = /\/graphql\/([^/]+)\/Following(?:\?|$)/;

  let bearer = null;
  let pageTpl = null; // X 页面自己发过的 Following 请求（用来拿接口编号和参数）
  const lists = new Map(); // 列表主人 userId -> Map(用户id -> 用户)，兜底模式用
  const lastPageEmpty = {};
  let respSeq = 0;
  let rateLimitedUntil = 0;
  let scanning = false;
  let stopFlag = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 扫描里用的等待：点“停止”后 0.1 秒内就能退出
  async function nap(ms) {
    const end = Date.now() + ms;
    while (!stopFlag && Date.now() < end) await sleep(Math.min(100, end - Date.now()));
  }
  const post = (type, data = {}) => window.postMessage({ source: SRC_OUT, type, ...data }, location.origin);
  const getCookie = (k) => (document.cookie.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]+)')) || [])[1];

  // ---------- 捕获 X 自己的请求（只读，不改） ----------
  function readAuth(h) {
    if (!h) return;
    let v;
    if (h instanceof Headers) v = h.get('authorization');
    else if (Array.isArray(h)) v = (h.find(([k]) => String(k).toLowerCase() === 'authorization') || [])[1];
    else for (const k in h) if (k.toLowerCase() === 'authorization') v = h[k];
    if (v && /^Bearer /i.test(v)) bearer = v;
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || String(input);
      readAuth(init && init.headers);
      if (input instanceof Request) readAuth(input.headers);
    } catch {}
    const res = await origFetch.apply(this, arguments);
    try {
      if (FOLLOWING_RE.test(url)) {
        pageTpl = url;
        if (res.status === 429) markRateLimited(res.headers.get('x-rate-limit-reset'));
        else res.clone().json().then((d) => handlePage(url, d)).catch(() => {});
      }
    } catch {}
    return res;
  };

  const XO = XMLHttpRequest.prototype.open;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__xmfUrl = String(u);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization' && /^Bearer /i.test(v)) bearer = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__xmfUrl;
    if (url && FOLLOWING_RE.test(url)) {
      pageTpl = url;
      this.addEventListener('load', () => {
        try {
          if (this.status === 429) return markRateLimited(this.getResponseHeader('x-rate-limit-reset'));
          const d = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          if (d) handlePage(url, d);
        } catch {}
      });
    }
    return XS.apply(this, arguments);
  };

  function markRateLimited(reset) {
    const t = Number(reset) * 1000;
    rateLimitedUntil = t > Date.now() ? Math.min(t, Date.now() + 15 * 60e3) : Date.now() + 60e3;
  }

  // ---------- 解析 ----------
  function varsOf(url) {
    try {
      return JSON.parse(new URL(url, location.origin).searchParams.get('variables') || '{}');
    } catch {
      return {};
    }
  }

  function collectUsers(o, out) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const x of o) collectUsers(x, out);
      return;
    }
    if (o.user_results && o.user_results.result) out.push(o.user_results.result);
    for (const k in o) collectUsers(o[k], out);
  }

  function bottomCursor(o) {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o)) {
      for (const x of o) {
        const c = bottomCursor(x);
        if (c) return c;
      }
      return null;
    }
    if (o.cursorType === 'Bottom' && o.value) return o.value;
    for (const k in o) {
      const c = bottomCursor(o[k]);
      if (c) return c;
    }
    return null;
  }

  function norm(r) {
    if (r && r.__typename === 'UserWithVisibilityResults' && r.user) r = r.user;
    if (!r || !r.rest_id) return null;
    const L = r.legacy || {};
    const C = r.core || {};
    const RP = r.relationship_perspectives || {};
    const RC = r.relationship_counts || {};
    let fb = RP.followed_by !== undefined ? RP.followed_by : L.followed_by;
    // 老版本数据结构里，X 只在“对方关注了你”时才返回 followed_by
    if (fb === undefined && (r.legacy || r.relationship_perspectives)) fb = false;
    const followers = typeof RC.followers === 'number' ? RC.followers : typeof L.followers_count === 'number' ? L.followers_count : null;
    return {
      id: String(r.rest_id),
      screen_name: C.screen_name || L.screen_name || '',
      name: C.name || L.name || '',
      avatar: (r.avatar && r.avatar.image_url) || L.profile_image_url_https || '',
      blue: !!r.is_blue_verified,
      verifiedType: (r.verification && r.verification.verified_type) || L.verified_type || '',
      followers,
      followedBy: fb === undefined || fb === null ? null : !!fb,
    };
  }

  function addUsers(map, owner, data) {
    const raw = [];
    collectUsers(data, raw);
    let added = 0;
    for (const r of raw) {
      const u = norm(r);
      if (!u || u.id === owner) continue;
      const prev = map.get(u.id);
      if (!prev) added++;
      map.set(u.id, prev ? { ...prev, ...u, followedBy: prev.followedBy || u.followedBy } : u);
    }
    return { raw: raw.length, added };
  }

  // X 页面自己加载的数据（兜底模式用）
  function handlePage(url, data) {
    const owner = varsOf(url).userId;
    if (!owner) return;
    if (!lists.has(owner)) lists.set(owner, new Map());
    const { raw } = addUsers(lists.get(owner), owner, data);
    lastPageEmpty[owner] = raw === 0;
    respSeq++;
  }

  // ---------- 找接口编号：X 的代码里写着 queryId:"xxx",operationName:"Following" ----------
  async function discoverQid() {
    const srcs = [...document.scripts].map((s) => s.src).filter((s) => /client-web/.test(s));
    for (const src of srcs) {
      try {
        const t = await (await origFetch(src)).text();
        const m = t.match(/queryId:"([^"]+)",operationName:"Following"/);
        if (m) return m[1];
      } catch {}
    }
    return null;
  }

  async function getQid(fresh) {
    if (!fresh) {
      if (pageTpl) return (pageTpl.match(FOLLOWING_RE) || [])[1];
      try {
        const c = localStorage.getItem(QID_KEY);
        if (c) return c;
      } catch {}
    }
    const q = await discoverQid();
    if (q)
      try {
        localStorage.setItem(QID_KEY, q);
      } catch {}
    return q || FALLBACK_QID;
  }

  function apiHeaders() {
    return {
      authorization: bearer || FALLBACK_BEARER,
      'x-csrf-token': getCookie('ct0') || '',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': document.documentElement.lang || 'en',
    };
  }

  // ---------- 快速模式 ----------
  async function fastScan(viewerId, map, expectTotal) {
    let qid = await getQid(false);
    let rediscovered = false;
    let features = {};
    if (pageTpl) {
      try {
        features = JSON.parse(new URL(pageTpl, location.origin).searchParams.get('features') || '{}');
      } catch {}
    }
    let cursor = null;
    let errors = 0;
    while (!stopFlag) {
      if (Date.now() < rateLimitedUntil) {
        const s = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
        post('progress', { count: map.size, total: expectTotal, note: `被 X 限流，${s} 秒后自动继续…` });
        await nap(2000);
        continue;
      }
      const vars = { userId: viewerId, count: 100, includePromotedContent: false };
      if (cursor) vars.cursor = cursor;
      const url =
        `${location.origin}/i/api/graphql/${qid}/Following?variables=${encodeURIComponent(JSON.stringify(vars))}` +
        `&features=${encodeURIComponent(JSON.stringify(features))}`;
      let res;
      const ac = new AbortController();
      const t0 = Date.now();
      const watch = setInterval(() => (stopFlag || Date.now() - t0 > 20000) && ac.abort(), 100);
      try {
        res = await origFetch(url, { credentials: 'include', headers: apiHeaders(), signal: ac.signal });
      } catch {
        res = null;
      } finally {
        clearInterval(watch);
      }
      if (stopFlag) break;
      if (!res) {
        if (++errors >= 3) return { ok: false, err: '网络请求失败' };
        await nap(1500);
        continue;
      }
      if (res.status === 429) {
        markRateLimited(res.headers.get('x-rate-limit-reset'));
        continue;
      }
      let data = null;
      try {
        data = await res.json();
      } catch {}
      if (!res.ok || !data || !data.data) {
        // 接口编号过期（X 更新了）：重新找一次
        if ((res.status === 404 || res.status === 400) && !rediscovered) {
          rediscovered = true;
          qid = await getQid(true);
          continue;
        }
        // 缺少参数：按 X 的提示补上再试
        const msg = (data && data.errors && data.errors[0] && data.errors[0].message) || '';
        const miss = msg.match(/cannot be null:\s*(.+)$/);
        if (miss && errors < 3) {
          errors++;
          miss[1].split(',').forEach((k) => k.trim() && (features[k.trim()] = true));
          continue;
        }
        return { ok: false, err: 'HTTP ' + res.status + (msg ? ' ' + msg.slice(0, 60) : '') };
      }
      errors = 0;
      const { raw, added } = addUsers(map, viewerId, data);
      post('progress', { count: map.size, total: expectTotal, note: '快速读取中…' });
      const next = bottomCursor(data);
      if (!raw || !next || next === cursor || !added) return { ok: true, end: true };
      // 不在两页之间加定时等待：标签页在后台时 Chrome 会把定时器拖慢到几十秒一次。
      // 每页请求本身约 0.4 秒，2000 多个关注约 50 次请求，远低于 X 每 15 分钟 500 次的限制
      cursor = next;
    }
    return { ok: true, end: false };
  }

  // ---------- 兜底模式：在关注页自动滚动 ----------
  async function scrollScan(viewerId, expectTotal) {
    if (!lists.has(viewerId)) lists.set(viewerId, new Map());
    const map = lists.get(viewerId);
    lastPageEmpty[viewerId] = false;
    let last = -1;
    let idle = 0;
    while (!stopFlag) {
      if (Date.now() < rateLimitedUntil) {
        post('progress', { count: map.size, total: expectTotal, note: '被 X 限流，稍后自动继续…' });
        await nap(2000);
        idle = 0;
        continue;
      }
      if (idle > 0 && idle % 3 === 0) {
        window.scrollBy(0, -1200);
        await nap(300);
      }
      const seq = respSeq;
      const se = document.scrollingElement || document.documentElement;
      window.scrollTo(0, se.scrollHeight);
      const end = Date.now() + 2500;
      while (!stopFlag && respSeq === seq && Date.now() < end) await sleep(100);
      await nap(200);
      const n = map.size;
      post('progress', { count: n, total: expectTotal, note: '滚动读取中…' });
      if (n !== last) {
        last = n;
        idle = 0;
      } else idle++;
      if (lastPageEmpty[viewerId] && idle >= 2) break;
      if (idle >= 5) break;
    }
    return map;
  }

  async function scan({ viewerId, reqId, allowScroll, expectTotal }) {
    if (scanning) return post('scanDone', { reqId, error: '已在扫描中' });
    scanning = true;
    stopFlag = false;
    const map = new Map();
    let mode = 'fast';
    let fastErr = null;
    let endReached = false;
    const r = await fastScan(viewerId, map, expectTotal);
    if (r.ok) endReached = r.end;
    else {
      fastErr = r.err;
      if (!allowScroll || stopFlag) {
        scanning = false;
        return post('scanDone', { reqId, needScroll: !stopFlag, fastErr, users: [...map.values()], aborted: stopFlag });
      }
      mode = 'scroll';
      post('progress', { count: map.size, total: expectTotal, note: '快速模式不可用，改为滚动读取…' });
      const sm = await scrollScan(viewerId, expectTotal);
      for (const [id, u] of sm) if (!map.has(id)) map.set(id, u);
      endReached = !!lastPageEmpty[viewerId];
    }
    scanning = false;
    post('scanDone', { reqId, users: [...map.values()], mode, fastErr, endReached, aborted: stopFlag });
  }

  // ---------- 取关 ----------
  async function unfollow(id) {
    const ct0 = getCookie('ct0');
    if (!ct0) return { ok: false, error: '未登录（缺少 ct0）' };
    try {
      const res = await origFetch(location.origin + '/i/api/1.1/friendships/destroy.json', {
        method: 'POST',
        credentials: 'include',
        headers: { ...apiHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user_id: id }).toString(),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {}
      if (res.ok && body && (body.id_str === id || body.screen_name)) return { ok: true };
      const msg = body && body.errors && body.errors[0] && body.errors[0].message;
      return { ok: false, status: res.status, error: msg || 'HTTP ' + res.status };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SRC_IN) return;
    const d = e.data;
    if (d.type === 'scan') scan({ ...d, viewerId: String(d.viewerId) });
    else if (d.type === 'stopScan') stopFlag = true;
    else if (d.type === 'unfollow') unfollow(String(d.id)).then((r) => post('unfollowResult', { reqId: d.reqId, ...r }));
  });
})();
