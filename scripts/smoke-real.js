// 冒烟：用真实 main.js + 真实 store.js 启动，验证启动容错与写盘加密。
// 磁盘断言按分文件布局（store.js 重写后）：config.json / sessions/<id>.json / backups/
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-real-'));
app.setPath('userData', tmp);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS | ' + name + ' | ' + detail); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function listDir(p) { try { return fs.readdirSync(p); } catch (e) { return []; } }

// 故意写入：null 服务商 + 明文密钥 + null 会话 + 无 roundId 的 assistant
const seed = {
  config: {
    providers: [
      null,
      {
        id: 'deepseek', name: 'DeepSeek', provider: 'deepseek', apiFormat: 'openai',
        baseUrl: 'https://api.deepseek.com', apiKey: 'test-key-not-real', fullUrl: false, preset: true,
        models: [{ modelId: 'deepseek-flash', name: 'Flash', enabled: true, contextTokens: 100000, maxTokens: 8000 }]
      }
    ],
    search: { provider: 'bing' },
    synthesis: { synthSource: 'frontend', autoMerge: false }
  },
  sessions: [
    null,
    {
      id: 's1', title: '旧会话', createdAt: 1, updatedAt: 2, pinned: false,
      messages: [
        { id: 'm1', role: 'user', content: '你好', createdAt: 1 },
        { id: 'm2', role: 'assistant', createdAt: 2,
          results: [{ modelId: 'deepseek::deepseek-flash', name: 'Flash', status: 'done', content: '你好' }] }
      ]
    }
  ]
};
fs.writeFileSync(path.join(tmp, 'store.json'), JSON.stringify(seed), 'utf8');

require(path.join(ROOT, 'src', 'main', 'main.js'));

app.whenReady().then(async () => {
  try {
    await sleep(1800);
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) { check('窗口已创建', false, '窗口不存在'); throw new Error('窗口未创建'); }
    const js = code => w.webContents.executeJavaScript(code, true);

    const fatal = await js("!!document.getElementById('fatal-error')");
    check('非法数据启动不进入错误遮罩', fatal === false, 'fatal=' + fatal);

    const st = await js(`({
      sessions: MM.state.sessions.length,
      title: MM.state.sessions[0] && MM.state.sessions[0].title,
      providers: MM.state.config.providers.length,
      allObjects: MM.state.config.providers.every(function(p){ return p && typeof p === 'object'; }),
      hasKey: MM.state.config.providers[0] && MM.state.config.providers[0].hasKey,
      hasPlainKey: !!(MM.state.config.providers[0] && MM.state.config.providers[0].apiKey),
      roundId: MM.state.sessions[0] && MM.state.sessions[0].messages[1] && MM.state.sessions[0].messages[1].roundId,
      sidebar: document.querySelectorAll('#session-list .session-item').length
    })`);
    check('null 服务商被过滤，密钥标记保留，渲染层无明文密钥',
      st.providers >= 1 && st.allObjects === true && st.hasKey === true && st.hasPlainKey === false,
      JSON.stringify(st));
    check('null 会话被过滤，旧会话保留并渲染', st.sessions === 1 && st.title === '旧会话' && st.sidebar === 1,
      JSON.stringify(st));
    check('旧 assistant 自动补 roundId', !!st.roundId, 'roundId=' + st.roundId);

    // 等待防抖/迁移落盘，再检查磁盘上的密钥是否已加密（分文件布局：config.json）
    await sleep(600);
    const cfgDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    const key = cfgDisk.config && cfgDisk.config.providers &&
      cfgDisk.config.providers.find(p => p && p.id === 'deepseek');
    check('磁盘密钥已加密（safeStorage）',
      !!(key && typeof key.apiKey === 'object' && key.apiKey.enc),
      'diskKey=' + JSON.stringify(key && key.apiKey).slice(0, 60));
    const allPlain = listDir(path.join(tmp, 'sessions')).every(f => {
      const raw = fs.readFileSync(path.join(tmp, 'sessions', f), 'utf8');
      return raw.indexOf('test-key-not-real') < 0;
    }) && fs.readFileSync(path.join(tmp, 'config.json'), 'utf8').indexOf('test-key-not-real') < 0;
    check('磁盘文件不含明文密钥', allPlain, '');
    check('旧 store.json 已留档改名', listDir(tmp).some(f => /^store\.json\.legacy-\d+$/.test(f)), '');
    const corrupts = listDir(tmp).concat(listDir(path.join(tmp, 'sessions'))).filter(f => f.indexOf('.corrupt-') >= 0);
    check('未产生损坏备份', corrupts.length === 0, JSON.stringify(corrupts));
    check('会话已落到独立文件（sessions/s1.json）', fs.existsSync(path.join(tmp, 'sessions', 's1.json')), '');

    // 每日自动备份：当天第一次保存前自动留底 backups/auto-<日期>/（启动迁移已触发过保存）
    const autos = listDir(path.join(tmp, 'backups')).filter(f => /^auto-\d{8}$/.test(f));
    check('每日自动备份已生成（backups/auto-<日期>/）', autos.length >= 1, JSON.stringify(autos));

    // 非法 chat:send payload 不应让渲染层一直停在"生成中"
    const done = await js(`new Promise(function(resolve){
      var off = api.onEvent(function(d){
        if (d && d.type === 'all-done' && d.requestId === 'bad1') { off(); resolve(true); }
      });
      api.send({ requestId: 'bad1', targets: 'oops' });
      setTimeout(function(){ off(); resolve(false); }, 1500);
    })`);
    check('非法 chat:send payload 仍会收到 all-done', done === true, 'allDone=' + done);

    // 多实例冲突备份：文件粒度 + backups/bak-<时间戳>/ + 只保留最近 5 份（D8）。
    // 模拟另一实例：外部改写 s1.json（mtime 变化）+ 渲染层侧同一会话有新内容要写——
    // 只有真正要覆盖该文件时才检测冲突（内容没变不写盘，对方数据自然存活）
    fs.appendFileSync(path.join(tmp, 'sessions', 's1.json'), ' ');
    await js('MM.state.sessions[0].updatedAt = Date.now(); MM.save()');
    await sleep(500);
    let baks = listDir(path.join(tmp, 'backups')).filter(f => /^bak-\d+$/.test(f));
    check('冲突备份带时间戳（backups/bak-<ts>/）', baks.length >= 1, JSON.stringify(baks));
    for (let i = 0; i < 7; i++) fs.mkdirSync(path.join(tmp, 'backups', 'bak-100000000000' + i), { recursive: true });
    fs.appendFileSync(path.join(tmp, 'sessions', 's1.json'), ' ');
    await js('MM.state.sessions[0].updatedAt = Date.now(); MM.save()');
    await sleep(500);
    baks = listDir(path.join(tmp, 'backups')).filter(f => /^bak-\d+$/.test(f));
    check('冲突备份只保留最近 5 份', baks.length === 5, 'n=' + baks.length);

    // 自动备份：同一天重复保存不再新增 + 滚动只保留最近 7 份
    const d = new Date();
    const dayKey = 'auto-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    let autos2 = listDir(path.join(tmp, 'backups')).filter(f => /^auto-\d{8}$/.test(f));
    check('当天重复保存只保留一份自动备份', autos2.filter(f => f === dayKey).length === 1, JSON.stringify(autos2));
    for (let i = 1; i <= 9; i++) fs.mkdirSync(path.join(tmp, 'backups', 'auto-2025010' + i), { recursive: true });
    await js('MM.save()');
    await sleep(500);
    autos2 = listDir(path.join(tmp, 'backups')).filter(f => /^auto-\d{8}$/.test(f));
    check('自动备份滚动保留 7 份（更旧的被清理）', autos2.length === 7, 'n=' + autos2.length);
  } catch (e) {
    fail++;
    console.log('SMOKE_ERROR ' + (e && (e.stack || e.message)));
  }
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  app.exit(fail ? 1 : 0);
});
