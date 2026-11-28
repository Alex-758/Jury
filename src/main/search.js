'use strict';
const crypto = require('crypto');
// 通用联网搜索：必应（免费无需密钥）/ Tavily / 博查，结果注入对话上下文。
// opts.signal：外部中止（chat:stop 经 activeRequests 传入）——用户点停止时
// 搜索请求立即中断，不再在主进程空跑到 15s 超时
const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_SEARCH_RESPONSE_CHARS = 10 * 1024 * 1024;
const SEARCH_CACHE_TTL = 2 * 60 * 1000;
const SEARCH_CACHE_MAX = 80;
const searchCache = new Map();

function normalizeQuery(query) {
  return String(query || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    return u.pathname === '/' && !u.search ? u.origin : u.toString();
  } catch (e) { return ''; }
}

function normalizeResults(items, provider, count) {
  const seen = new Set();
  const out = [];
  const limit = Math.max(1, Math.min(Number(count) || 6, 12));
  for (const item of (Array.isArray(items) ? items : [])) {
    if (!item || typeof item !== 'object') continue;
    const url = normalizeUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(item.title || url).replace(/\s+/g, ' ').trim().slice(0, 240),
      url,
      snippet: String(item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      provider,
      rank: out.length + 1,
      retrievedAt: Date.now()
    });
    if (out.length >= limit) break;
  }
  return out;
}

function cacheKey(provider, query, count, key) {
  const keyHash = key ? crypto.createHash('sha256').update(String(key)).digest('hex') : '';
  return String(provider || '') + '\u0000' + keyHash + '\u0000' + normalizeQuery(query) + '\u0000' + String(count || 6);
}

function readCache(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { searchCache.delete(key); return null; }
  return hit.items.map(x => Object.assign({}, x));
}

function writeCache(key, items) {
  searchCache.delete(key);
  searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL, items: items.map(x => Object.assign({}, x)) });
  while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
}

async function readTextCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > max) throw new Error('搜索响应超过 10MB，已中止解析');
    return text;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '', bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (bytes > max) {
      try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (e) { /* 已断 */ }
      throw new Error('搜索响应超过 10MB，已中止解析');
    }
  }
  return out + dec.decode();
}

async function readJsonCapped(res) {
  const text = await readTextCapped(res, MAX_SEARCH_RESPONSE_CHARS);
  try { return JSON.parse(text); }
  catch (e) { throw new Error('搜索响应不是有效 JSON'); }
}

// 把外部 signal 接到本次请求的 controller 上；已中止则直接抛"已停止"
function wireExternal(signal, ctrl) {
  if (!signal) return function () {};
  if (signal.aborted) throw new Error('已停止');
  const abort = () => ctrl.abort();
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

async function bingSearch(query, count, opts) {
  // 双端点兜底：www 失败或解析不到结果时换 cn 端点再试一次（已中止则不再重试）。
  // 两个端点共享一个 15 秒总预算：否则第一个端点超时后还要再等 15s，最坏 30s
  const deadline = Date.now() + 15000;
  const endpoints = [
    'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + Math.max(count + 4, 10),
    'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=' + Math.max(count + 4, 10)
  ];
  let lastErr = null;
  for (const url of endpoints) {
    if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
    const remain = deadline - Date.now();
    if (remain <= 500) { lastErr = lastErr || new Error('搜索超时：15 秒未响应'); break; }
    try {
      const out = await bingAttempt(url, count, opts, remain);
      if (out.length) return out;
      lastErr = new Error('必应搜索未解析到结果（可能被临时限流），可稍后重试或配置 Tavily/博查');
    } catch (e) {
      if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
      // 15s 超时的 AbortError 转中文（用户主动停止已在上面的 signal 检查里拦截）
      lastErr = (e && e.name === 'AbortError') ? new Error('搜索超时：15 秒未响应') : e;
    }
  }
  throw lastErr || new Error('必应搜索失败');
}

async function bingAttempt(url, count, opts, budgetMs) {
  const ctrl = new AbortController();
  const unwire = wireExternal(opts && opts.signal, ctrl);
  const timeout = setTimeout(() => ctrl.abort(), budgetMs > 0 ? budgetMs : 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: ctrl.signal
    });
    if (!res.ok) {
      try { Promise.resolve(res.body && res.body.cancel()).catch(function () {}); } catch (e) { /* 已断 */ }
      throw new Error('必应搜索 HTTP ' + res.status);
    }
    const t = await readTextCapped(res, MAX_SEARCH_RESPONSE_CHARS);
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
    const out = [];
    let m;
    while ((m = re.exec(t)) && out.length < count) {
      const title = (m[2] || '').replace(/<[^>]+>/g, '').trim();
      let u = String(m[1] || '');
      if (u.startsWith('/')) u = 'https://www.bing.com' + u;
      const snippet = (m[3] || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
      if (!title || !/^https?:\/\//.test(u)) continue;
      out.push({ title, url: u, snippet });
    }
    return out;
  } finally { clearTimeout(timeout); unwire(); }
}

async function webSearch(cfg, query, count = 6, opts) {
  const provider = cfg && cfg.provider;
  const key = (cfg && cfg.apiKey || '').trim();
  if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
  if (!provider || provider === 'none') return null;
  if (!['bing', 'tavily', 'bocha'].includes(provider)) throw new Error('不支持的搜索服务商：' + provider);
  count = Math.max(1, Math.min(Math.floor(Number(count) || 6), 12));
  const q = normalizeQuery(query);
  if (!q) return [];
  const ck = cacheKey(provider, q, count, key);
  const cached = opts && opts.bypassCache ? null : readCache(ck);
  if (cached) return cached;

  let raw;
  if (provider === 'bing') {
    raw = await bingSearch(q, count, opts);
    const normalized = normalizeResults(raw, provider, count);
    if (normalized.length && !(opts && opts.bypassCache)) writeCache(ck, normalized);
    return normalized;
  }

  const ctrl = new AbortController();
  const unwire = wireExternal(opts && opts.signal, ctrl);
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  try {
    if (!key) throw new Error('搜索服务商已选但 API 密钥为空，请在设置中填写');
    if (provider === 'tavily') {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, api_key: key, max_results: count }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('Tavily ' + res.status + ': ' + (await readTextCapped(res, MAX_SEARCH_RESPONSE_CHARS)).slice(0, 200));
      const j = await readJsonCapped(res);
      raw = (j.results || []).map(r => ({ title: r.title || '', url: r.url || '', snippet: (r.content || '').slice(0, 300) }));
    }
    if (provider === 'bocha') {
      const res = await fetch('https://api.bochaai.com/v1/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ query: q, count, summary: true }),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('博查 ' + res.status + ': ' + (await readTextCapped(res, MAX_SEARCH_RESPONSE_CHARS)).slice(0, 200));
      const j = await readJsonCapped(res);
      const items = (j.data && j.data.webPages && j.data.webPages.value) || [];
      raw = items.map(r => ({ title: r.name || '', url: r.url || '', snippet: (r.summary || r.snippet || '').slice(0, 300) }));
    }
    const normalized = normalizeResults(raw, provider, count);
    if (normalized.length && !(opts && opts.bypassCache)) writeCache(ck, normalized);
    return normalized;
  } catch (e) {
    if (opts && opts.signal && opts.signal.aborted) throw new Error('已停止');
    if (e && e.name === 'AbortError') throw new Error('搜索超时：15 秒未响应');
    throw e;
  } finally { clearTimeout(timeout); unwire(); }
}

module.exports = { webSearch };
