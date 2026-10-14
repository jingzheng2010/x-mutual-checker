// 兜底取关：接口取关失败时，在后台标签页打开对方主页，由 content.js 自动点击“取消关注”
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'unfollowViaTab') {
    unfollowViaTab(msg).then(sendResponse);
    return true;
  }
});

async function unfollowViaTab({ id, screen_name, origin }) {
  const key = 'xmf_tab_' + id;
  await chrome.storage.local.remove(key);
  const base = origin || 'https://x.com';
  const tab = await chrome.tabs.create({
    url: `${base}/${encodeURIComponent(screen_name)}?xmf_unfollow=${encodeURIComponent(id)}`,
    active: false,
  });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => done({ ok: false, error: '页面操作超时' }), 30000);
    function onChange(changes, area) {
      if (area === 'local' && changes[key] && changes[key].newValue) done(changes[key].newValue);
    }
    function done(r) {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onChange);
      resolve(r);
    }
    chrome.storage.onChanged.addListener(onChange);
  });
  try {
    await chrome.tabs.remove(tab.id);
  } catch {}
  await chrome.storage.local.remove(key);
  return result;
}

// ---------- 开关：点工具栏图标 开启 / 关闭 ----------
async function refreshBadge() {
  const { xmf_enabled } = await chrome.storage.local.get('xmf_enabled');
  await chrome.action.setBadgeText({ text: xmf_enabled ? '开' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#1d9bf0' });
  await chrome.action.setTitle({ title: xmf_enabled ? 'X 互关检测：已开启（点击关闭）' : 'X 互关检测：已关闭（点击开启）' });
}

chrome.action.onClicked.addListener(async (tab) => {
  const { xmf_enabled } = await chrome.storage.local.get('xmf_enabled');
  const on = !xmf_enabled;
  await chrome.storage.local.set({ xmf_enabled: on });
  await refreshBadge();
  // 开启时如果当前不在 X 页面，直接打开 X
  if (on && !/^https:\/\/(x|twitter)\.com\//.test(tab.url || '')) chrome.tabs.create({ url: 'https://x.com/home' });
});

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
