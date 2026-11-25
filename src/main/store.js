'use strict';
// 本地 JSON 存储（分文件布局）：
//   config.json            配置（密钥 safeStorage/DPAPI 加密）
//   sessions/index.json    会话顺序（{ v, order: [sessionId...] }）
//   sessions/<fileId>.json 单个会话全文
//   backups/auto-<日期>/   每日自动备份（硬链接当天被替换前的文件，几乎零占用），滚动 7 份
//   backups/bak-<时间戳>/  多实例冲突备份，滚动 5 份
//   backups/<tag>-<时间戳>/ 覆盖类操作（导入）前的整库快照
//
// 写路径差量化：save() 收到整包 {config, sessions} 后按会话逐个 stringify 与上次写盘
// 内容比对，只重写变化的部分——14MB 库的单次保存从"全文件重写"降到"变化的会话文件"。
// stringify 总量与旧单文件方案相当（本来就要算），省下的是磁盘写放大与损坏面。
//
// 保护语义（与旧 store.json 单文件一脉相承，粒度变细）：
// - 原子写（tmp + fsync + rename）；硬链接备份依赖"从不原地改写"这一前提
// - 并发保护：写入前比对文件 mtime，被其他实例改过的文件先备份进 backups/bak-<ts>/
// - 损坏隔离：config.json 或某个会话文件解析失败只隔离该文件（备份 .corrupt-<时间戳>），
//   其余数据照常加载——不再像旧方案那样一处损坏全库不可用
// - 旧版单文件迁移：首次启动发现 store.json 且无 sessions/ 目录时一次性拆分，
//   旧文件改名 store.json.legacy-<时间戳> 留档不删
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

let dataDir = null;
const mtimes = new Map();      // 文件路径 -> 本进程最后已知的 mtimeMs
const sessionCache = new Map(); // sessionId -> 上次写盘的 JSON 字符串（差量比对基准）
const fileIds = new Map();     // sessionId -> 会话文件名（含净化/防碰撞）
const usedNames = new Set();   // 已占用的文件名（小写）：Windows 文件系统大小写不敏感
let cfgPlain = null;           // 上次写盘的 config 明文串（差量基准；DPAPI 密文非确定，密文串比对永不命中）
let idxCache = null;           // 上次写盘的 index.json 内容
let corrupts = [];             // 本次加载中隔离的损坏文件 [{file, backup, message}]
let decryptFailures = 0;       // 本次加载/导入中无法解密的密钥数量

function init(userDataDir) { dataDir = userDataDir; }
function dir() { return dataDir; }
function configFile() { return path.join(dataDir, 'config.json'); }
function sessionsDir() { return path.join(dataDir, 'sessions'); }
function indexFile() { return path.join(sessionsDir(), 'index.json'); }
function backupsDir() { return path.join(dataDir, 'backups'); }

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; }
}

// ---------- 密钥加解密 ----------
function canEncrypt() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}
function encryptValue(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'object') return v; // 已是 { enc }
  try { return { enc: safeStorage.encryptString(String(v)).toString('base64') }; }
  catch (e) {
    // 加密失败不能静默回退明文：保存应失败并保留原有安全数据，交给上层提示用户。
    const err = new Error('API 密钥加密失败，未写入明文密钥');
    err.cause = e;
    throw err;
  }
}
function decryptValue(v) {
  if (v == null) return v;
  if (typeof v === 'object') {
    if (!v.enc) { decryptFailures++; return ''; } // 未知格式（手改/异版本数据）：当作空密钥，避免后续 .trim() 崩溃
    try { return safeStorage.decryptString(Buffer.from(v.enc, 'base64')); }
    catch (e) {
      decryptFailures++;
      console.warn('[store] 密钥解密失败（可能来自其它机器/用户），已清空该密钥');
      return '';
    }
  }
  return v; // 旧版明文：原样使用
}

// 只克隆 config（很小），不复制 sessions
function encryptConfig(config) {
  if (!config || typeof config !== 'object' || !canEncrypt()) return config;
  const cfg = JSON.parse(JSON.stringify(config));
  for (const p of (Array.isArray(cfg.providers) ? cfg.providers : [])) {
    if (p && typeof p === 'object') p.apiKey = encryptValue(p.apiKey);
  }
  if (cfg.search && typeof cfg.search === 'object') cfg.search.apiKey = encryptValue(cfg.search.apiKey);
  return cfg;
}

// 把 { config, sessions } 里的密钥解密（导入内部 store.json/config.json 时也走这里）
function decryptData(data) {
  if (!data || typeof data !== 'object' || !data.config || typeof data.config !== 'object') return data;
  const cfg = data.config;
  for (const p of (Array.isArray(cfg.providers) ? cfg.providers : [])) {
    if (p && typeof p === 'object') p.apiKey = decryptValue(p.apiKey);
  }
  if (cfg.search && typeof cfg.search === 'object') cfg.search.apiKey = decryptValue(cfg.search.apiKey);
  return data;
}

// ---------- 低层写 ----------
// fsync 后再 rename：否则断电时 rename 元数据可能先于数据块落盘，文件截断
function writeAtomic(f, str) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, str, 'utf8');
  try {
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (err) { /* fsync 失败不阻断保存：最坏退回无 fsync 的原行为 */ }
  fs.renameSync(tmp, f);
  mtimes.set(f, statMtime(f));
}

function readJson(f) {
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (e) { return (e && e.code === 'ENOENT') ? { missing: true } : { error: e.message }; }
  try { return { data: JSON.parse(raw) }; }
  catch (e) { return { error: e.message }; }
}

// 解析失败的文件：留现场备份，绝不覆盖（原文件保持原样，用户可就地检查/恢复）。
// 但同一个坏文件每次启动都会解析失败：若无条件再复制一份 .corrupt，会随启动次数
// 无限堆积，且每次都弹「数据损坏」——用户已被告知过就不再重复打扰。
// 判据：同目录下已有该文件的 .corrupt-<时间戳> 备份 → 只记录、不再复制也不必再报。
function quarantine(f, message) {
  const dir = path.dirname(f);
  const base = path.basename(f);
  let already = '';
  try {
    already = fs.readdirSync(dir).find(n => n.indexOf(base + '.corrupt-') === 0) || '';
  } catch (e) { /* 目录不可读：按未隔离处理 */ }
  if (already) {
    // 历史遗留的坏文件：仍登记（主进程据此跳过图片 gc，避免把可恢复数据的图片删掉），
    // 但 isNew=false 让启动弹窗不再每次重复打扰
    const item = { file: f, backup: path.join(dir, already), message: message, isNew: false };
    corrupts.push(item);
    console.warn('[store] 数据文件仍无法解析（已有隔离备份，跳过重复复制）：' + f + '：' + message);
    return item;
  }
  const backup = f + '.corrupt-' + Date.now();
  let saved = '';
  try { fs.copyFileSync(f, backup); saved = backup; } catch (e2) { saved = ''; }
  const item = { file: f, backup: saved, message: message, isNew: true };
  corrupts.push(item);
  console.warn('[store] 数据文件解析失败，已隔离备份：' + f + ' -> ' + (saved || '（备份失败）') + '：' + message);
  return item;
}

// ---------- 备份（硬链接优先：原子写从不原地改写，旧 inode 由链接保活，零拷贝零占用） ----------
function hardlinkOrCopy(src, destDir) {
  const dest = path.join(destDir, path.basename(src));
  try { fs.linkSync(src, dest); return true; }
  catch (e) {
    try { fs.copyFileSync(src, dest); return true; } // 跨卷/exFAT 等不支持硬链接：退回复制
    catch (e2) { return false; }
  }
}
function backupAll(destDir) {
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { return; }
  const files = [configFile(), indexFile()];
  try {
    const imageDir = path.join(dataDir, 'images');
    if (fs.existsSync(imageDir)) fs.cpSync(imageDir, path.join(destDir, 'images'), { recursive: true });
  } catch (e) { /* 图片备份失败不阻断配置/会话备份 */ }
  try {
    for (const n of fs.readdirSync(sessionsDir())) {
      if (n.endsWith('.json') && n !== 'index.json') files.push(path.join(sessionsDir(), n));
    }
  } catch (e) { /* sessions 目录不存在：首次启动无从备份 */ }
  for (const f of files) {
    try { if (fs.existsSync(f)) hardlinkOrCopy(f, destDir); } catch (e) { /* 单个失败不阻断 */ }
  }
}
function pruneBackupDirs(prefix, keep) {
  try {
    const dirs = fs.readdirSync(backupsDir())
      .filter(n => n.indexOf(prefix) === 0).sort();
    for (const n of dirs.slice(0, Math.max(0, dirs.length - keep))) {
      try { fs.rmSync(path.join(backupsDir(), n), { recursive: true, force: true }); } catch (e) { /* 占用等：下次再清 */ }
    }
  } catch (e) { /* backups 目录还不存在：跳过 */ }
}

// 每日自动备份：当天第一次保存前，把磁盘上的现状硬链接进 backups/auto-<日期>/。
// 快照的是"覆盖前的磁盘状态"——当天任何一次写坏（渲染层送来坏数据、导入出错），
// 都能退回到昨天的样子。每天最多一份，滚动保留最近 7 份
function autoBackup() {
  try {
    const d = new Date();
    const day = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const dest = path.join(backupsDir(), 'auto-' + day);
    if (fs.existsSync(dest)) return; // 当天已备份过
    if (!fs.existsSync(configFile()) && !fs.existsSync(sessionsDir())) return; // 首次启动还没有数据
    backupAll(dest);
    pruneBackupDirs('auto-', 7);
  } catch (e) { /* 备份失败不阻断保存 */ }
}

// 覆盖类操作（导入）前给当前数据留一份带时间戳的整库副本，返回副本目录路径
function snapshot(tag) {
  try {
    if (!fs.existsSync(configFile()) && !fs.existsSync(sessionsDir())) return '';
    const dest = path.join(backupsDir(), tag + '-' + Date.now());
    backupAll(dest);
    return dest;
  } catch (e) { return ''; }
}

// ---------- 会话文件名 ----------
// id 来自渲染层 U.uid()（字母数字），但导入/手改数据不作此假设：
// 净化成安全文件名；有损净化/保留名/重名时补全量短哈希定位（哈希含完整 id）。
// 映射确定性强：save → load → save 走同一函数得到同一文件名
function hash36(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
// 保留名：index 是索引文件本身；con/prn/aux/nul/com1-9/lpt1-9 在 Windows 上是设备名
//（带扩展名同样无效，例如 nul.txt），这些名字一律补哈希，避免写盘失败或落到设备上。
const RESERVED = /^(index|con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
function fileIdOf(id) {
  if (fileIds.has(id)) return fileIds.get(id);
  const key = String(id);
  let name = key.replace(/[^\w.-]/g, '_').slice(0, 80);
  // 有损净化、空名、保留名，或者名字（不分大小写）已被占用 → 补哈希
  if (name !== key || !name || RESERVED.test(name) || usedNames.has(name.toLowerCase())) {
    name = name.slice(0, 80) + '-' + hash36(key);
  }
  // 补哈希后仍可能撞上（两个不同 id 哈希相同/名字相同）：再追加长度兜底
  while (usedNames.has(name.toLowerCase())) name = name.slice(0, 74) + '-' + hash36(key + '#' + usedNames.size);
  usedNames.add(name.toLowerCase());
  fileIds.set(id, name);
  return name;
}
function sessionFile(id) { return path.join(sessionsDir(), fileIdOf(id) + '.json'); }

// ---------- 旧版单文件迁移 ----------
// store.json（旧版全量文件）存在而 sessions/ 不存在时一次性拆分。
// 解析失败按旧语义处理：隔离备份 + 返回 null（整库空启动，主进程弹窗提示），
// 与损坏场景一致——此时任何自动处理都可能扩大损失，交给用户恢复备份。
function migrateLegacy() {
  const legacy = path.join(dataDir, 'store.json');
  if (!fs.existsSync(legacy)) return true;
  // 「迁移已完成」的唯一判据是 index.json（提交点：它在所有会话写完之后才写）。
  // 不能只看 sessions/ 目录是否存在——迁移中途失败时目录已被创建，那样下次启动
  // 会误判为已完成并静默跳过旧数据（store.json 还在，却永远不再被读取）。
  if (fs.existsSync(indexFile())) return true;
  const r = readJson(legacy);
  if (r.missing) return true;
  if (r.error || !r.data || typeof r.data !== 'object') {
    quarantine(legacy, r.error || '结构不是对象');
    return false;
  }
  const data = r.data;
  const sessions = Array.isArray(data.sessions) ? data.sessions.filter(s => s && typeof s === 'object' && s.id) : [];
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    // 写盘顺序即提交顺序：config（密钥）最先，index.json（提交点）最后——
    // 中途断电最坏留下"新文件 + 未改名的旧 store.json"，数据两处都找得回来；
    // 且 index.json 未写成时下次启动会重做迁移（守卫看 index.json）
    const cfgStr = JSON.stringify({ config: encryptConfig(data.config || {}) });
    writeAtomic(configFile(), cfgStr);
    cfgPlain = JSON.stringify(data.config || {});
    const order = [];
    for (const s of sessions) {
      const f = sessionFile(s.id);
      writeAtomic(f, JSON.stringify(s));
      sessionCache.set(s.id, JSON.stringify(s));
      order.push(s.id);
    }
    const idx = JSON.stringify({ v: 1, order: order });
    writeAtomic(indexFile(), idx);
    idxCache = idx;
    // 旧文件留档不删（复制不删除惯例），旧版 auto/bak 备份也原样保留
    const keep = legacy + '.legacy-' + Date.now();
    try { fs.renameSync(legacy, keep); } catch (e) { /* 改名失败不影响：index.json 已写，下次启动走正常加载 */ }
    console.log('[store] 旧版 store.json 已拆分为分文件布局，原文件留档为 ' + path.basename(keep));
    return true;
  } catch (e) {
    // 拆分写盘失败（磁盘满/无权限等）：不能静默当空库启动——记进 corrupts 让主进程
    // 弹窗提示，旧文件原样保留，下次启动重试拆分（index.json 未写成，守卫不会误判）
    corrupts.push({ file: legacy, backup: '', message: '旧版数据拆分写盘失败：' + (e && e.message) });
    console.warn('[store] 旧版数据拆分失败：', e && e.message);
    return false;
  }
}

// ---------- 读 ----------
function load() {
  corrupts = [];
  decryptFailures = 0;
  sessionCache.clear();
  fileIds.clear();
  usedNames.clear();
  mtimes.clear();
  cfgPlain = null;
  idxCache = null;

  if (!migrateLegacy()) {
    // 迁移失败：本次以空库启动（主进程已弹窗），但必须清掉迁移过程中建立的
    // 「磁盘已知内容」基准——否则渲染层拿到空数据后的首次保存会把刚写成功的
    // 会话文件当成"已删除"逐个 unlink，把本可重试恢复的数据真的删掉。
    // 这些残留文件下次启动会走"未登记会话文件"补录逻辑被收回。
    sessionCache.clear();
    fileIds.clear();
    usedNames.clear();
    mtimes.clear();
    return null; // 旧文件损坏/写盘失败：整库空启动（语义与旧方案一致）
  }

  const hasConfig = fs.existsSync(configFile());
  const hasSessions = fs.existsSync(sessionsDir());
  if (!hasConfig && !hasSessions) return null; // 全新安装：首次启动

  // config.json
  let config = {};
  const cr = readJson(configFile());
  if (cr.error) quarantine(configFile(), cr.error);
  else if (cr.data && typeof cr.data === 'object' && cr.data.config && typeof cr.data.config === 'object') {
    config = cr.data.config;
    mtimes.set(configFile(), statMtime(configFile()));
  }
  if (hasConfig && !cr.error && !(cr.data && typeof cr.data === 'object' && cr.data.config &&
    typeof cr.data.config === 'object')) quarantine(configFile(), '结构不是 {config:...}');

  // sessions/index.json + 各会话文件
  const sessions = [];
  const seenIds = new Set();
  let order = null;
  const ir = hasSessions ? readJson(indexFile()) : { missing: true };
  if (ir.error) quarantine(indexFile(), ir.error);
  else if (ir.data && Array.isArray(ir.data.order)) order = ir.data.order.filter(x => typeof x === 'string');
  else if (ir.data) quarantine(indexFile(), '结构不是 {order:[...]}');

  const byIdInDir = {};
  try {
    for (const n of fs.readdirSync(sessionsDir())) {
      if (!n.endsWith('.json') || n === 'index.json') continue;
      byIdInDir[n.slice(0, -5)] = path.join(sessionsDir(), n);
    }
  } catch (e) { /* 目录不可读：按无会话处理 */ }

  const readSession = f => {
    const sr = readJson(f);
    if (sr.error) { quarantine(f, sr.error); return null; }
    if (!sr.data || typeof sr.data !== 'object' || !sr.data.id) {
      // 无 id 的会话文件：UI 本就无法寻址，隔离出来防丢
      quarantine(f, '缺少 id 字段');
      return null;
    }
    return sr.data;
  };

  if (order) {
    mtimes.set(indexFile(), statMtime(indexFile()));
    idxCache = JSON.stringify({ v: 1, order: order });
    for (const id of order) {
      const fname = fileIdOf(id);
      const f = byIdInDir[fname] || byIdInDir[id]; // 兼容未净化文件名的旧布局
      if (!f) { console.warn('[store] index 引用的会话文件缺失：' + id); continue; }
      const s = readSession(f);
      // 实际读到的键删掉（净化名与未净化名都可能命中），避免同名内容被"未登记文件"恢复逻辑重复收一遍
      delete byIdInDir[fname];
      delete byIdInDir[id];
      if (!s) continue;
      if (seenIds.has(s.id)) continue;
      seenIds.add(s.id);
      sessions.push(s);
      sessionCache.set(s.id, JSON.stringify(s));
      mtimes.set(f, statMtime(f));
    }
  }
  // 目录里有而 index 没登记的文件（写 index 前断电等）：按文件名序补到末尾，不丢数据
  for (const key of Object.keys(byIdInDir).sort()) {
    const s = readSession(byIdInDir[key]);
    if (!s || seenIds.has(s.id)) continue;
    seenIds.add(s.id);
    sessions.push(s);
    sessionCache.set(s.id, JSON.stringify(s));
    mtimes.set(byIdInDir[key], statMtime(byIdInDir[key]));
    console.warn('[store] 发现未登记的会话文件，已补入列表：' + key);
  }

  // 差量基准 = 解密后的明文形态（与 save 收到的 config 同构，密钥为明文字符串）。
  // 必须在解密之后取：磁盘上是密文，内存里是明文，两者 JSON 串不同
  decryptData({ config });
  cfgPlain = JSON.stringify(config);
  return { config, sessions };
}

function corruptInfo() { return corrupts.length ? { items: corrupts } : null; }
function decryptInfo() { return decryptFailures; }
function encryptionAvailable() { return canEncrypt(); }

// ---------- 写（差量） ----------
function save(data) {
  autoBackup(); // 每天第一次保存前，把磁盘旧数据留底（详见 autoBackup 注释）
  pruneBackupDirs('auto-', 7); // 滚动清理每次保存都跑：手工堆积的旧备份不必等到下一天才清
  pruneBackupDirs('bak-', 5);
  let conflict = false;
  let written = 0;

  // 检查目标文件的磁盘 mtime 是否被外部（另一实例）改过；是则先备份该文件
  const conflictCheck = f => {
    const cur = statMtime(f);
    const known = mtimes.has(f) ? mtimes.get(f) : 0;
    if (cur && known && cur !== known) {
      conflict = true;
      const ts = Date.now();
      try {
        const dest = path.join(backupsDir(), 'bak-' + ts);
        fs.mkdirSync(dest, { recursive: true });
        hardlinkOrCopy(f, dest);
        pruneBackupDirs('bak-', 5);
        console.warn('[store] 检测到 ' + path.basename(f) + ' 被其他实例修改，已备份进 backups/' + path.basename(dest));
      } catch (e) { /* 备份失败不阻断写入 */ }
    }
  };

  // config.json：明文串比对（DPAPI 密文非确定性，密文比对永不命中）；变了才加密写盘
  if (data && data.config && typeof data.config === 'object') {
    const plain = JSON.stringify(data.config);
    if (plain !== cfgPlain) {
      const f = configFile();
      try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* 已存在 */ }
      conflictCheck(f);
      writeAtomic(f, JSON.stringify({ config: encryptConfig(data.config) }));
      cfgPlain = plain;
      written++;
    }
  }

  // 会话文件：逐个比对
  const list = (data && Array.isArray(data.sessions)) ? data.sessions : [];
  const seenIds = new Set();
  try { fs.mkdirSync(sessionsDir(), { recursive: true }); } catch (e) { /* 已存在 */ }
  for (const s of list) {
    if (!s || typeof s !== 'object' || !s.id) { console.warn('[store] 跳过缺少 id 的会话条目'); continue; }
    const id = s.id;
    if (seenIds.has(id)) continue; // 重复 id：渲染层 normalizeSessions 会兜底，这里取首个
    seenIds.add(id);
    const str = JSON.stringify(s);
    if (sessionCache.get(id) === str) continue; // 内容未变：不写
    const f = sessionFile(id);
    conflictCheck(f);
    writeAtomic(f, str);
    sessionCache.set(id, str);
    written++;
  }

  // index.json 先写成新的提交点，再清理不再登记的旧会话文件。
  // 如果索引写入失败，旧索引仍指向旧文件，不能先删会话再留下不可见数据。
  const order = Array.from(seenIds);
  const idxStr = JSON.stringify({ v: 1, order: order });
  if (idxStr !== idxCache) {
    const f = indexFile();
    try { fs.mkdirSync(sessionsDir(), { recursive: true }); } catch (e) { /* 已存在 */ }
    conflictCheck(f);
    writeAtomic(f, idxStr);
    idxCache = idxStr;
    written++;
  }

  // 删除：索引提交成功后，再清理内存基准里已不在新列表中的会话。
  for (const id of Array.from(sessionCache.keys())) {
    if (seenIds.has(id)) continue;
    const f = sessionFile(id);
    try { fs.unlinkSync(f); } catch (e) { /* 文件本就不存在：忽略 */ }
    sessionCache.delete(id);
    // 同时释放文件名占用：否则删掉的 id 名字永远不可复用（长会话反复增删会累积占位）
    const name = fileIds.get(id);
    if (name) usedNames.delete(name.toLowerCase());
    fileIds.delete(id);
    mtimes.delete(f);
    written++;
  }

  return { conflict, written };
}

module.exports = { init, load, save, dir, snapshot, corruptInfo, decryptInfo, decryptData, encryptionAvailable };
