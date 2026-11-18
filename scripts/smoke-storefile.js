'use strict';
// 冒烟：分文件存储布局（store.js 重写后的核心行为）。
// 覆盖：旧版 store.json 一次性迁移、差量落盘（未变文件不重写）、会话增删落盘、
// 顺序维护、损坏会话隔离（不再全库不可用）、多实例冲突备份、每日自动备份滚动、
// 导入前整库快照、特殊字符 id 的文件名净化、index 缺失恢复、全新安装空库、
// 旧格式整包导入兼容。
// 用法：npx electron scripts/smoke-storefile.js
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'src', 'main', 'store.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-storefile-' + tag + '-')); }
function listDir(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }
function readIndex(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'sessions', 'index.json'), 'utf8')); }
  catch (e) { return null; }
}

const seedSessions = [
  {
    id: 's1', title: '会话一', createdAt: 1, updatedAt: 2, pinned: false,
    messages: [{ id: 'm1', role: 'user', content: '你好', createdAt: 1 }]
  },
  {
    id: 's2', title: '会话二', createdAt: 2, updatedAt: 3, pinned: true,
    messages: [{ id: 'm2', role: 'user', content: '世界', createdAt: 2 }]
  }
];
const seedConfig = {
  providers: [{ id: 'p1', name: 'P1', apiKey: 'test-key-not-real', models: [] }],
  search: { provider: 'bing' }
};

app.whenReady().then(async () => {
  try {
    // ---------- 1. 旧版单文件迁移 ----------
    const t1 = mkTmp('migrate');
    fs.writeFileSync(path.join(t1, 'store.json'), JSON.stringify({ config: seedConfig, sessions: [null].concat(seedSessions) }), 'utf8');
    store.init(t1);
    const loaded = store.load();
    check('迁移后 load 返回全部有效会话（null 条目被滤掉）',
      !!loaded && loaded.sessions.length === 2 && loaded.sessions[0].id === 's1' && loaded.sessions[1].id === 's2',
      JSON.stringify(loaded && loaded.sessions.map(s => s.id)));
    check('config.json / sessions/index.json / 会话文件已生成',
      fs.existsSync(path.join(t1, 'config.json')) &&
      fs.existsSync(path.join(t1, 'sessions', 'index.json')) &&
      fs.existsSync(path.join(t1, 'sessions', 's1.json')) &&
      fs.existsSync(path.join(t1, 'sessions', 's2.json')),
      JSON.stringify(listDir(path.join(t1, 'sessions'))));
    check('旧 store.json 已留档改名（.legacy-<ts>）',
      listDir(t1).some(f => /^store\.json\.legacy-\d+$/.test(f)) && !fs.existsSync(path.join(t1, 'store.json')),
      JSON.stringify(listDir(t1)));
    const cfgDisk = JSON.parse(fs.readFileSync(path.join(t1, 'config.json'), 'utf8'));
    const encOk = safeStorage.isEncryptionAvailable();
    check('迁移写盘的密钥已加密（safeStorage）',
      !encOk || !!(cfgDisk.config && cfgDisk.config.providers[0] && cfgDisk.config.providers[0].apiKey &&
        typeof cfgDisk.config.providers[0].apiKey === 'object' && cfgDisk.config.providers[0].apiKey.enc),
      JSON.stringify(cfgDisk.config && cfgDisk.config.providers[0] && cfgDisk.config.providers[0].apiKey).slice(0, 60));
    check('迁移后立即再 load 结果一致（幂等）',
      (() => { const l2 = store.load(); return l2 && l2.sessions.length === 2 && l2.sessions[1].id === 's2'; })(), '');
    check('迁移后未产生损坏备份',
      listDir(t1).concat(listDir(path.join(t1, 'sessions'))).every(f => f.indexOf('.corrupt-') < 0), '');

    // ---------- 2. 差量落盘：未变不写、变了只写该文件 ----------
    const before = {
      s1: fs.statSync(path.join(t1, 'sessions', 's1.json')).mtimeMs,
      s2: fs.statSync(path.join(t1, 'sessions', 's2.json')).mtimeMs,
      cfg: fs.statSync(path.join(t1, 'config.json')).mtimeMs
    };
    await sleep(50); // mtime 时间分辨率：确保"真的写了"能从 mtime 看出来
    const r0 = store.save({ config: JSON.parse(JSON.stringify(seedConfig)), sessions: JSON.parse(JSON.stringify(seedSessions)) });
    check('内容未变的整包保存零写盘（written=0）', r0.written === 0 && r0.conflict === false, JSON.stringify(r0));
    check('未变文件 mtime 未动', fs.statSync(path.join(t1, 'sessions', 's1.json')).mtimeMs === before.s1 &&
      fs.statSync(path.join(t1, 'config.json')).mtimeMs === before.cfg, '');
    const changed = JSON.parse(JSON.stringify(seedSessions));
    changed[1].title = '会话二（改）';
    const r1 = store.save({ config: JSON.parse(JSON.stringify(seedConfig)), sessions: changed });
    check('只改一个会话只写一个文件（written=1）', r1.written === 1, 'written=' + r1.written);
    check('变更的会话文件已重写',
      fs.statSync(path.join(t1, 'sessions', 's2.json')).mtimeMs !== before.s2 &&
      fs.statSync(path.join(t1, 'sessions', 's1.json')).mtimeMs === before.s1, '');
    const s2disk = JSON.parse(fs.readFileSync(path.join(t1, 'sessions', 's2.json'), 'utf8'));
    check('变更内容已落盘', s2disk.title === '会话二（改）', s2disk.title);

    // ---------- 3. 会话新增/删除 + 顺序维护 ----------
    const withS3 = changed.concat([{ id: 's3', title: '三', createdAt: 3, updatedAt: 4, pinned: false, messages: [] }]);
    store.save({ config: seedConfig, sessions: withS3 });
    check('新增会话落盘（s3.json 出现）', fs.existsSync(path.join(t1, 'sessions', 's3.json')), '');
    const reordered = [withS3[2], withS3[0], withS3[1]]; // s3, s1, s2
    store.save({ config: seedConfig, sessions: reordered });
    const idxDisk = readIndex(t1);
    check('index.json 维护会话顺序', !!idxDisk && JSON.stringify(idxDisk.order) === JSON.stringify(['s3', 's1', 's2']),
      JSON.stringify(idxDisk));
    const reloaded = store.load();
    check('load 按 index 顺序返回', reloaded.sessions.map(s => s.id).join(',') === 's3,s1,s2',
      reloaded.sessions.map(s => s.id).join(','));
    const removed = [reloaded.sessions[0], reloaded.sessions[1]]; // 删掉 s2
    store.save({ config: seedConfig, sessions: removed });
    check('删除的会话文件已清理', !fs.existsSync(path.join(t1, 'sessions', 's2.json')), '');

    // ---------- 4. 多实例冲突备份（文件粒度） ----------
    const s3File = path.join(t1, 'sessions', 's3.json');
    fs.appendFileSync(s3File, ' '); // 外部改动 s3：mtime 变化，模拟另一实例写入过
    const s3Old = fs.readFileSync(s3File, 'utf8');
    const modS3 = JSON.parse(JSON.stringify(removed));
    modS3[0].title = '三（改）';
    const r3 = store.save({ config: seedConfig, sessions: modS3 });
    const bakDirs = listDir(path.join(t1, 'backups')).filter(f => /^bak-\d+$/.test(f));
    check('冲突检测触发并备份（backups/bak-<ts>/）', r3.conflict === true && bakDirs.length === 1, JSON.stringify(bakDirs));
    const bakS3 = path.join(t1, 'backups', bakDirs[0], 's3.json');
    check('冲突备份保留的是被覆盖前的内容', fs.existsSync(bakS3) && fs.readFileSync(bakS3, 'utf8') === s3Old, '');
    for (let i = 0; i < 7; i++) fs.mkdirSync(path.join(t1, 'backups', 'bak-100000000000' + i), { recursive: true });
    fs.appendFileSync(s3File, ' ');
    store.save({ config: seedConfig, sessions: modS3.map(s => Object.assign({}, s, { title: s.title + '!' })) });
    const baks2 = listDir(path.join(t1, 'backups')).filter(f => /^bak-\d+$/.test(f));
    check('冲突备份滚动保留最近 5 份', baks2.length === 5, 'n=' + baks2.length);

    // ---------- 5. 每日自动备份：当天一份 + 滚动 7 份 ----------
    const day = new Date();
    const dayKey = 'auto-' + day.getFullYear() + String(day.getMonth() + 1).padStart(2, '0') + String(day.getDate()).padStart(2, '0');
    const autosNow = listDir(path.join(t1, 'backups')).filter(f => /^auto-\d{8}$/.test(f));
    check('每日自动备份目录已生成（auto-<日期>）', autosNow.indexOf(dayKey) >= 0, JSON.stringify(autosNow));
    for (let i = 1; i <= 9; i++) fs.mkdirSync(path.join(t1, 'backups', 'auto-2025010' + i), { recursive: true });
    store.save({ config: seedConfig, sessions: modS3 });
    const autos2 = listDir(path.join(t1, 'backups')).filter(f => /^auto-\d{8}$/.test(f));
    check('自动备份滚动保留 7 份', autos2.length === 7, 'n=' + autos2.length);
    check('自动备份含 config.json（硬链接/复制）', fs.existsSync(path.join(t1, 'backups', dayKey, 'config.json')), '');

    // ---------- 6. 导入前整库快照 ----------
    const snap = store.snapshot('pre-import');
    check('snapshot 返回非空目录且含 config.json', !!snap && fs.existsSync(path.join(snap, 'config.json')), String(snap));

    // ---------- 7. 特殊字符 id 的文件名净化 ----------
    const t2 = mkTmp('sanitize');
    store.init(t2);
    const weird = [{ id: 'a/b:c?', title: '特殊', createdAt: 1, updatedAt: 2, pinned: false, messages: [] }];
    store.save({ config: seedConfig, sessions: weird });
    const files2 = listDir(path.join(t2, 'sessions')).filter(f => f !== 'index.json');
    check('特殊字符 id 写出安全文件名', files2.length === 1 && ![/\\/, /:/, /\//, /\*/].some(re => re.test(files2[0])), JSON.stringify(files2));
    const l3 = store.load();
    check('净化文件名的会话 load 后 id 原样还原', l3.sessions.length === 1 && l3.sessions[0].id === 'a/b:c?',
      JSON.stringify(l3.sessions.map(s => s.id)));

    // ---------- 8. 损坏隔离：单个会话文件坏了不再全库不可用 ----------
    const t3 = mkTmp('corrupt');
    fs.mkdirSync(path.join(t3, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(t3, 'config.json'), JSON.stringify({ config: seedConfig }), 'utf8');
    fs.writeFileSync(path.join(t3, 'sessions', 'index.json'), JSON.stringify({ v: 1, order: ['sa', 'sb'] }), 'utf8');
    fs.writeFileSync(path.join(t3, 'sessions', 'sa.json'), JSON.stringify({ id: 'sa', title: '好的', messages: [] }), 'utf8');
    fs.writeFileSync(path.join(t3, 'sessions', 'sb.json'), '{这不是JSON', 'utf8');
    store.init(t3);
    const l4 = store.load();
    const bad = store.corruptInfo();
    check('损坏只隔离坏文件，其余会话照常加载', l4 && l4.sessions.length === 1 && l4.sessions[0].id === 'sa',
      JSON.stringify(l4 && l4.sessions.map(s => s.id)));
    check('corruptInfo 指出被隔离的文件', !!bad && bad.items.length === 1 && bad.items[0].file.indexOf('sb.json') >= 0,
      JSON.stringify(bad));
    check('坏文件已留 .corrupt-<ts> 现场备份',
      listDir(path.join(t3, 'sessions')).some(f => /^sb\.json\.corrupt-\d+$/.test(f)), '');
    store.save({ config: seedConfig, sessions: l4.sessions });
    check('隔离后 save 不触碰坏文件（原件与 .corrupt 备份都还在）',
      fs.existsSync(path.join(t3, 'sessions', 'sb.json')) &&
      listDir(path.join(t3, 'sessions')).some(f => /^sb\.json\.corrupt-\d+$/.test(f)), '');

    // ---------- 9. index 缺失时按目录扫描恢复 ----------
    const t4 = mkTmp('recover');
    fs.mkdirSync(path.join(t4, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(t4, 'sessions', 'sc.json'), JSON.stringify({ id: 'sc', title: '无索引', messages: [] }), 'utf8');
    store.init(t4);
    const l5 = store.load();
    check('index 缺失按目录扫描恢复会话', l5 && l5.sessions.length === 1 && l5.sessions[0].id === 'sc',
      JSON.stringify(l5 && l5.sessions.map(s => s.id)));
    store.save({ config: seedConfig, sessions: l5.sessions });
    const idx4 = readIndex(t4);
    check('恢复后的会话已重新登记进 index', !!idx4 && JSON.stringify(idx4.order) === JSON.stringify(['sc']), JSON.stringify(idx4));

    // ---------- 10. 全新安装空库 ----------
    const t5 = mkTmp('fresh');
    store.init(t5);
    check('全新目录 load 返回 null（首次启动）', store.load() === null, '');
    const r5 = store.save({ config: seedConfig, sessions: [] });
    check('空会话列表保存后 load 返回空数组', store.load().sessions.length === 0 && r5.written >= 1, JSON.stringify(r5));

    // ---------- 11. 导入兼容：旧格式整包（密文密钥）可解密 ----------
    if (encOk) {
      const encCfg = JSON.parse(JSON.stringify(seedConfig));
      encCfg.providers[0].apiKey = { enc: safeStorage.encryptString('test-key-not-real').toString('base64') };
      const dec = store.decryptData({ config: encCfg, sessions: [] });
      check('decryptData 还原内部格式密文密钥', dec.config.providers[0].apiKey === 'test-key-not-real', '');
    } else {
      console.log('  SKIP 11（本机不支持 safeStorage，密文用例跳过）');
    }
  } catch (e) {
    fail++;
    console.log('  SMOKE_ERROR ' + (e && (e.stack || e.message)));
  }
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  app.exit(fail ? 1 : 0);
});
