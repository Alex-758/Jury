'use strict';
// 聊天流·渲染：卡片/状态徽标/综合卡与来源角标装饰/版本展示与切换/
// DOM 回收池/编辑重发/会话提示词面板/滚动贴底与流式绘制。
  // ---------- 模型芯片 ----------
  // 勾选状态跨重启记忆：config.chipSel = { on: [id...], off: [id...] }。
  // 两个集合都不在的 id（新添加的模型）默认选中——既保住用户特意关掉的，又不漏掉新模型。
  function chipSel() {
    const cs = MM.state.config.chipSel;
    return (cs && Array.isArray(cs.on) && Array.isArray(cs.off)) ? cs : null;
  }
  function persistChips() {
    const sel = { on: [], off: [] };
    for (const c of U.$$('#model-chips .chip')) {
      (c.classList.contains('on') ? sel.on : sel.off).push(c.getAttribute('data-model-id'));
    }
    MM.state.config.chipSel = sel;
    MM.save({ configOnly: true }); // 只动了配置，不必复制整份会话历史
  }

  function renderChips() {
    const box = U.$('#model-chips');
    // 重建前记录当前勾选状态：设置页关闭/配置变更会频繁触发本函数，不能重置用户的选择
    const prev = new Map();
    for (const c of box.querySelectorAll('.chip')) {
      prev.set(c.getAttribute('data-model-id'), c.classList.contains('on'));
    }
    box.innerHTML = '';
    const models = MM.settings.allFlatModels();
    if (!models.length) {
      box.appendChild(U.el('div', { style: 'color:var(--muted);font-size:12.5px;padding:6px' }, '暂无可用模型，请在「设置 → 模型配置」中添加'));
      return;
    }
    const saved = chipSel();
    const frag = document.createDocumentFragment();
    for (const m of models) {
      const bits = [m.providerName + ' · ' + m.modelId];
      if (m.contextTokens) bits.push(MM.modelInfo.fmtTokens(m.contextTokens) + ' 上下文');
      if (m.multimodal) bits.push('多模态');
      if (!m.hasKey) bits.push('API Key 未设置，请在设置中填写');
      // 优先级：本次运行内的状态 > 持久化记录 > 默认选中
      const on = prev.has(m.id) ? prev.get(m.id) : (saved ? !saved.off.includes(m.id) : true);
      frag.appendChild(U.el('div', {
        class: 'chip' + (on ? ' on' : ''),
        'data-model-id': m.id,
        title: bits.join(' · '),
        onclick: function () { this.classList.toggle('on'); persistChips(); }
      },
        U.el('span', {}, m.name || m.modelId)
      ));
    }
    box.appendChild(frag);
    refreshChipVisionHints();
  }

  // ---------- 历史 ----------
  function pickAnswer(am) {
    if (!am || !am.results) return null;
    const done = am.results.filter(r => r.status === 'done' && r.content);
    if (!done.length) return null;
    // 多轮上下文优先取综合回答（若存在），其次取当前显示版本的回答
    if (am.merge && am.merge.content) return am.merge.content;
    return done[0].content;
  }

  // 粗略 token 估算：CJK 字符按 1 token，其他按 4 字符 1 token
  function estTokens(s) {
    if (!s) return 0;
    let cjk = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x2e80) cjk++;
    }
    return cjk + Math.ceil((s.length - cjk) / 4);
  }

  // 生效的系统提示词：会话级覆盖优先，取不到再用全局；两者都为空返回 ''（调用方自行判断是否注入）
  function effectiveSystemPrompt(s) {
    const local = s && typeof s.systemPrompt === 'string' ? s.systemPrompt.trim() : '';
    if (local) return local;
    const g = MM.state.config && MM.state.config.systemPrompt;
    return typeof g === 'string' ? g.trim() : '';
  }

  // model：本轮要发给的模型（决定图片路由——多模态收原图引用，纯文本收提取文字）。
  // 兼容旧调用（测试/旧路径）：不传时按纯文本处理。
  function buildHistory(s, userMsg, searchResults, ctxLimit, maxOut, model) {
    const mm = !!(model && model.multimodal === true);
    const msgs = [];
    for (const m of s.messages) {
      if (m === userMsg) break;
      if (m.role === 'user') {
        msgs.push({ role: 'user', content: historyUserContent(m) });
      } else if (m.role === 'assistant') {
        const best = pickAnswer(m);
        if (best) msgs.push({ role: 'assistant', content: best });
      } else if (m.role === 'merge') {
        if (m.content && msgs.length && msgs[msgs.length - 1].role === 'assistant') {
          msgs[msgs.length - 1].content = m.content; // 优先用综合回答作为上一轮上下文
        }
      }
    }
    // 注意：相邻 user 的合并必须放在"追加当前消息"之后（见函数末尾），
    // 否则最常见的相邻情况（历史最后一条 user + 当前消息）不会被合并
    if (searchResults && searchResults.length) {
      const src = searchResults.map(r => '- ' + r.title + '\n  ' + r.snippet + '\n  来源: ' + r.url).join('\n');
      msgs.push({ role: 'system', content: '以下是与用户问题相关的联网搜索结果，回答时可以参考：\n\n' + src });
    }
    // 按模型上下文窗口裁剪历史，避免超限报错
    // 系统提示词的 token 也要计入预算，否则长提示词 + 长历史仍会超限
    const sysPrompt = effectiveSystemPrompt(s);
    if (ctxLimit) {
      // 预算下限取 512：极小上下文窗口（如 3000）下不能仍塞 4096
      let budget = Math.max(ctxLimit - (maxOut || 4096) - 4096, 512) - estTokens(sysPrompt);
      // 本轮图片按每张约 1200 token 预留（各家计费口径不同，取保守值）
      if (mm && Array.isArray(userMsg.images) && userMsg.images.length) {
        budget -= userMsg.images.length * 1200;
        if (budget < 512) budget = 512;
      }
      let total = msgs.reduce((a, x) => a + estTokens(x.content), 0);
      while (total > budget && msgs.length > 1) {
        total -= estTokens(msgs[0].content);
        msgs.shift();
        if (msgs.length && msgs[0].role === 'assistant') { // 保持 user/assistant 配对
          total -= estTokens(msgs[0].content);
          msgs.shift();
        }
      }
      // Anthropic 要求首条消息为 user
      while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
    }
    // 提示词插在裁剪之后：从前面 shift 历史时不能把它一起丢掉，
    // 它是本轮对话的角色设定，任何时候都要保住
    if (sysPrompt) msgs.unshift({ role: 'system', content: sysPrompt });
    msgs.push(currentUserEntry(userMsg, mm));
    // 合并相邻的 user 消息：上一轮全部失败/被停止时，历史最后一条 user 会与当前消息相邻，
    // Anthropic 等格式对角色交替更敏感（必须在 push 当前消息之后执行）
    for (let i = msgs.length - 1; i > 0; i--) {
      if (msgs[i].role === 'user' && msgs[i - 1].role === 'user') {
        msgs[i - 1].content += '\n\n' + msgs[i].content;
        // 当前消息带图：并入上一条时保留图片引用，不能只合并文字
        if (msgs[i].images && msgs[i].images.length) {
          msgs[i - 1].images = (msgs[i - 1].images || []).concat(msgs[i].images);
        }
        msgs.splice(i, 1);
      }
    }
    return msgs;
  }

  // ---------- 渲染 ----------
  function renderTitle() {
    const s = MM.sessions.current();
    U.$('#session-title').textContent = s ? s.title : 'Jury';
  }

  function emptyState() {
    const box = U.el('div', { class: 'empty-state' },
      U.el('h1', {}, 'Jury'),
      U.el('p', {}, '在下方输入问题，同时获得多个模型的回答'));
    // 没有任何已配置密钥的模型时显示引导（配置过后不再出现）
    const hasUsableModel = MM.settings.allFlatModels().some(m => m.hasKey);
    if (!hasUsableModel) {
      box.appendChild(U.el('div', { class: 'empty-guide' },
        U.el('span', { class: 'eg-text' }, '首次使用：请先在左下角「设置 → 模型配置」中为服务商填写 API Key'),
        U.el('button', { class: 'btn-secondary eg-btn', onclick: function () { MM.settings.open(); } }, '打开设置')));
    } else {
      // 已配置：给两个示例提问，点击直接填入输入框
      const ex = U.el('div', { class: 'empty-examples' });
      for (const q of ['用三句话解释量子计算', '对比三种主流大模型的长文本能力']) {
        ex.appendChild(U.el('button', {
          class: 'eg-q', onclick: function () {
            U.$('#input').value = q;
            autoResize();
            U.$('#input').focus();
          }
        }, q));
      }
      box.appendChild(ex);
    }
    return box;
  }

  // Markdown 渲染缓存：切换会话/版本时会反复重画同一条回答，
  // 内容没变就直接复用上次的 HTML。WeakMap 以结果对象为键，删除会话后可被 GC。
  const mdCache = new WeakMap();
  function mdHtml(obj, content) {
    const src = content || '';
    const hit = mdCache.get(obj);
    if (hit && hit.src === src) return hit.html;
    const html = MM.md.render(src);
    mdCache.set(obj, { src: src, html: html });
    return html;
  }

  function answerCard(res, streamingNow, roundId) {
    const card = U.el('div', { class: 'answer-card', 'data-model-id': res.modelId });
    const statusSpan = U.el('span', { class: 'ac-status' });
    statusSpan.innerHTML = statusHtml(res);
    card.appendChild(U.el('div', { class: 'ac-head' },
      U.el('span', { class: 'ac-dot', style: 'background:' + MM.settings.dotColor(res.modelId) }),
      U.el('span', { class: 'ac-name' }, res.name || res.modelId),
      statusSpan
    ));
    if (res.reasoning) {
      card.appendChild(U.el('details', { class: 'reasoning' },
        U.el('summary', {}, '查看思考过程'),
        U.el('div', { class: 'r-body' }, res.reasoning)));
    }
    if (res.sources && res.sources.length) {
      card.appendChild(U.el('details', { class: 'sources' },
        U.el('summary', {}, '📎 搜索来源 (' + res.sources.length + ')'),
        res.sources.map(r => {
          const url = String(r.url || '');
          // 只允许 http(s)：搜索服务返回的 URL 不可信，javascript:/data: 一律按纯文本渲染
          return /^https?:\/\//i.test(url)
            ? U.el('a', { href: url, target: '_blank', rel: 'noopener' }, r.title || url)
            : U.el('span', { class: 'src-item' }, r.title || url);
        })));
    }
    const body = U.el('div', { class: 'ac-body' + (streamingNow ? ' streaming' : ' md') });
    if (streamingNow) body.textContent = res.content || '';
    else if (res.status === 'skipped') body.innerHTML = '<div class="ac-skipped">该模型不支持图片，且未从图中提取到文字，本轮已跳过</div>';
    else if (res.status === 'error' && res.error) body.innerHTML = '<div class="ac-error">✗ ' + U.esc(res.error) + '</div>';
    else body.innerHTML = mdHtml(res, res.content);
    card.appendChild(body);
    const foot = U.el('div', { class: 'card-foot' });
    // 失败/被停止的卡片给单模型重试入口：只重发这一个模型，不重跑整轮（省掉已成功模型的钱）
    if (roundId && (res.status === 'error' || res.status === 'stopped')) {
      foot.appendChild(U.el('button', {
        class: 'ac-copy', title: '只重新调用这一个模型',
        onclick: function () { retryOne(roundId, res.modelId); }
      }, '重试'));
    }
    foot.appendChild(U.el('button', {
      class: 'ac-copy', onclick: function () { U.copyTextFrom(body); U.toast('已复制'); }
    }, '复制'));
    card.appendChild(foot);
    MM.md.bindCopy(card);
    return card;
  }

  // 流式期间模型回传了搜索引用（annotations）：在卡片上补/重建 📎 来源区。
  // 与 answerCard 建卡时的来源区同一结构，点击行为也一致（http(s) 白名单）
  function refreshSourcesRow(card, res) {
    if (!card || !res.sources || !res.sources.length) return;
    let det = card.querySelector('details.sources');
    if (!det) {
      det = U.el('details', { class: 'sources' });
      card.insertBefore(det, card.querySelector('.ac-body'));
    }
    det.innerHTML = '';
    det.appendChild(U.el('summary', {}, '📎 搜索来源 (' + res.sources.length + ')'));
    for (const r of res.sources) {
      const url = String(r.url || '');
      det.appendChild(/^https?:\/\//i.test(url)
        ? U.el('a', { href: url, target: '_blank', rel: 'noopener' }, r.title || url)
        : U.el('span', { class: 'src-item' }, r.title || url));
    }
  }

  // 缓存一张回答卡片里高频访问的节点（状态、正文、思考过程）
  function cardRefs(card) {
    return {
      card: card,
      status: card.querySelector('.ac-status'),
      body: card.querySelector('.ac-body'),
      reasoning: card.querySelector('.reasoning .r-body')
    };
  }

  // 任意来源（磁盘/导入/服务端）的数值字段统一转成有限数字，NaN/对象/字符串一律按 0
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function statusHtml(res) {
    if (res.status === 'searching') return '<span class="spinner"></span><span class="badge muted">搜索中…</span>';
    if (res.status === 'streaming') return '<span class="spinner"></span><span class="badge muted">生成中…</span>';
    if (res.status === 'done') {
      let h = '<span class="badge ok">✓</span>';
      // ms/chars 来自磁盘/导入数据时可能是任意类型：强制转数字，
      // 否则字符串会原样拼进 innerHTML（持久化 HTML 注入）或被 + 拼接
      const ms = num(res.ms);
      if (ms > 0) h += '<span class="badge">' + U.fmtMs(ms) + '</span>';
      const chars = num(res.chars);
      if (chars > 0) h += '<span class="badge">' + chars + ' 字</span>';
      // 非正常终止要标记出来（finish_reason 此前全程未读）：截断/拦截的回答
      // 看起来和完整回答一样，用户会误以为内容是全的
      if (res.finish === 'length') h += '<span class="badge warn" title="回答因达到最大输出长度被截断，可调大该模型的最大输出">已截断</span>';
      else if (res.finish === 'content_filter') h += '<span class="badge err" title="回答被内容安全策略拦截，可能不完整">内容被拦截</span>';
      return h + usageBadge(res.usage, { modelId: res.modelId });
    }
    if (res.status === 'error') {
      const ms = num(res.ms);
      return '<span class="badge err">✗ 失败</span>' + (ms > 0 ? '<span class="badge">' + U.fmtMs(ms) + '</span>' : '') +
        usageBadge(res.usage, { modelId: res.modelId });
    }
    if (res.status === 'stopped') {
      const ms = num(res.ms);
      return '<span class="badge muted">⏹ 已停止</span>' + (ms > 0 ? '<span class="badge">' + U.fmtMs(ms) + '</span>' : '') +
        usageBadge(res.usage, { modelId: res.modelId });
    }
    if (res.status === 'skipped') return '<span class="badge muted" title="' + U.esc(res.error || '') + '">⏭ 已跳过</span>';
    return '';
  }

  // token 用量徽标。悬停看输入/输出拆分与花费——只显示总数会让「为什么这么贵」查不到原因。
  // 用量是服务端回传的，某些端点不返回时此处自然为空，不猜不估算。
  // opts.modelId：按该模型单价解析花费；opts.cost：调用方已算好的花费（交叉审查是多模型聚合，
  // 没有单一 modelId 可解析）。单价未知就不显示金额，绝不猜
  function usageBadge(u, opts) {
    if (!u) return '';
    const a = num(u.input), b = num(u.output);
    if (!a && !b) return '';
    const total = a + b;
    let cost = null;
    if (opts && opts.cost != null) cost = opts.cost;
    else if (opts && opts.modelId && MM.costOf) cost = MM.costOf(opts.modelId, u);
    const tip = '输入 ' + a + ' + 输出 ' + b + ' tokens' + (cost != null ? ' · 花费约 ' + MM.modelInfo.fmtCost(cost) : '');
    return '<span class="badge tok" title="' + tip + '">' + MM.modelInfo.fmtTokens(total) + ' tok' +
      (cost != null ? ' · ≈' + MM.modelInfo.fmtCost(cost) : '') + '</span>';
  }

  // 本轮合计用量（回答 + 模型综合 + 交叉审查）；没有任何服务端用量时返回 null
  function roundUsage(am) {
    let total = 0;
    let hasUsage = false;
    const add = u => {
      if (!u) return;
      const n = num(u.input) + num(u.output);
      if (n) { total += n; hasUsage = true; }
    };
    for (const r of (am.results || [])) add(r.usage);
    if (am.merge && am.merge.mode !== 'frontend') add(am.merge.usage);
    for (const rv of (am.reviews || [])) {
      for (const it of (rv.items || [])) add(it.usage);
      if (rv.verdict) add(rv.verdict.usage);
    }
    return hasUsage ? total : null;
  }

  function answersGrid(am) {
    // 必须带 data-round：综合回答结束后要按它定位网格插回工具栏
    const grid = U.el('div', { class: 'answers', 'data-round': am.roundId });
    for (const r of (am.results || [])) grid.appendChild(answerCard(r, false, am.roundId));
    return grid;
  }

  function mergeCard(msg, live, roundId, results) {
    const card = U.el('div', { class: 'merge-card', 'data-role': 'merge', 'data-round': roundId || '' });
    const label = msg.mode === 'model' ? '综合回答 · 模型二次综合' : '综合回答';
    const mStatus = U.el('span', { class: 'ac-status' });
    // 非流式（历史快照）也要带上完成标记与用量，否则重开会话后综合卡片的头部是空的
    mStatus.innerHTML = live ? '<span class="spinner"></span>'
      : (msg.stopped ? '<span class="badge muted">⏹ 已停止</span>'
        : '✓ ' + (msg.mode === 'model' ? '完成' : '已合并')) + usageBadge(msg.usage, { modelId: msg.modelId });
    card.appendChild(U.el('div', { class: 'ac-head' },
      U.el('span', { class: 'ac-name' }, label),
      mStatus
    ));
    const body = U.el('div', { class: 'ac-body' + (live ? ' streaming' : ' md') });
    if (live) body.textContent = msg.content || '';
    else body.innerHTML = mdHtml(msg, msg.content);
    card.appendChild(body);
    // 非流式（历史重绘/前端合并完成）：渲染来源角标与分歧小节标识。
    // 冷开大会话逐卡装饰是秒级开销（E2）：空闲时段补，先出内容后出角标
    if (!live) decorateMergeSourcesDeferred(body, msg, results, roundId);
    card.appendChild(U.el('div', { class: 'card-foot' },
      U.el('button', { class: 'ac-copy', onclick: function () { U.copyTextFrom(body); U.toast('已复制'); } }, '复制')));
    MM.md.bindCopy(card);
    return card;
  }

  // ---------- 综合报告的来源角标（观点可点击查来源） ----------
  // 报告的每个段落/列表项与各模型原回答做本地相似度匹配，命中的块尾加小色点，
  // 点击滚动到对应模型卡片并闪烁。匹配是尽力而为：改写幅度大的块不显示角标。
  // 匹配结果按 merge 对象缓存（WeakMap，不进 JSON 序列化/落盘）：renderAll 每次重绘
  // 都会对每轮综合重跑 buildPool+blockModels，长会话切回时是纯重复计算。
  const srcCache = new WeakMap();
  function srcCacheEntry(msg, results) {
    let sig = 5381;
    // 报告正文也进签名：内容变了块结构就变，角标/溯源/覆盖缓存必须随之失效
    const mc = String((msg && msg.content) || '');
    for (let i = 0; i < mc.length; i++) sig = ((sig << 5) + sig + mc.charCodeAt(i)) | 0;
    for (const r of (results || [])) {
      const c = String((r && r.content) || '');
      const key = (r && r.modelId) + '\u0000' + c.length + '\u0000' + c;
      for (let i = 0; i < key.length; i++) sig = ((sig << 5) + sig + key.charCodeAt(i)) | 0;
    }
    let e = srcCache.get(msg);
    if (!e || e.sig !== sig) {
      e = { sig: sig, pool: MM.merge.buildPool(results), hits: new Map() };
      srcCache.set(msg, e);
    }
    return e;
  }

  // 冷开大会话时逐卡装饰（分析+匹配+溯源）是秒级一次性开销（E2）：挪到空闲时段
  // 逐卡补——卡片先出内容，角标/溯源稍后跟上；卡片被替换/移除则跳过。
  // finalize 路径（单卡）保持同步，保证综合完成瞬间角标即可点。
  // 回调触发时节点游离（冷开 1.2s 内切走）：保留 _decoArgs 与 .deco-pending 标记，
  // renderAll 池命中复用该节点时据此补一次装饰，否则角标永久缺失
  function decorateMergeSourcesDeferred(body, msg, results, roundId) {
    if (!body || body._decoQueued) return;
    body._decoQueued = true;
    body._decoArgs = [msg, results, roundId];
    body.classList.add('deco-pending');
    const run = function () {
      body._decoQueued = false;
      if (!body.isConnected) return; // 游离：参数留在 _decoArgs，池命中方补装饰
      body.classList.remove('deco-pending');
      body._decoArgs = null;
      decorateMergeSources(body, msg, results, roundId);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 200);
  }

  function decorateMergeSources(body, msg, results, roundId) {
    if (!msg || !msg.content || !results || !results.length) return;
    const entry = srcCacheEntry(msg, results);
    if (!entry.pool.length) return;
    // 两阶段（E3）：先一次性读完全部块的 innerText（整批只触发一次布局），
    // 再做全部匹配与追加——逐块"读布局→写 DOM"交替会让每块强制重排一次
    const blocks = Array.from(body.querySelectorAll('p, li'))
      .map(el => ({ el: el, text: (el.innerText || '').trim() }));
    // 装饰缓存（②持久化）：msg.deco 签名一致且块数一致 → 直接套用持久化结果，
    // 跳过 blockMatches 余弦匹配与 analyze 重算（冷开大会话的秒级开销 → 近零）；
    // 未命中则算完后写回 msg.deco，随会话文件落盘（版本快照剥离，见 snapshotOf）
    const cached = msg.deco;
    const cacheHit = !!(cached && cached.v === 1 && cached.h === entry.sig &&
      Array.isArray(cached.blocks) && cached.blocks.length === blocks.length);
    const nameOf = mid => {
      const r = (results || []).find(x => x && x.modelId === mid);
      return (r && r.name) || mid;
    };
    let allFresh = true; // 已装饰过的块会跳过：此时不能写缓存（漏块的空结果会污染下次冷开）
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.el.querySelector('.merge-src')) { allFresh = false; continue; }
      if (b.text.length < 12) continue; // 短标题类不标
      // hits：每个命中模型 + 池内最佳匹配原句（点击跳转后高亮具体段落用）
      let hits;
      if (cacheHit) {
        const c = cached.blocks[bi] || {};
        hits = (c.m || []).map((mid, k) => ({ modelId: mid, name: nameOf(mid), text: (c.s || [])[k] || '' }));
      } else {
        hits = entry.hits.get(b.text);
        if (!hits) { hits = MM.merge.blockMatches(b.text, entry.pool); entry.hits.set(b.text, hits); }
      }
      if (!hits.length) continue;
      const models = hits.map(h => ({ modelId: h.modelId, name: h.name }));
      // 每个模型的色点各自可点，多来源块不再只能跳到第一家；
      // sup 上的点击兜底保持旧行为（点中色点间缝隙时跳第一个可用来源，
      // 色点自身 onclick 已 stopPropagation，不会双触发）
      b.el.appendChild(U.el('sup', {
        class: 'merge-src',
        title: '来自：' + models.map(m => m.name).join('、'),
        onclick: function (e) {
          e.stopPropagation();
          jumpToSource(roundId, models, hits);
        }
      }, models.map(m => U.el('span', {
        class: 'src-dot',
        style: 'background:' + MM.settings.dotColor(m.modelId),
        title: '来自：' + m.name,
        onclick: function (e) {
          e.stopPropagation();
          jumpToSource(roundId, [m], hits.filter(h => h.modelId === m.modelId));
        }
      }))));
    }
    // 分歧 / 待验证小节的视觉标识（按模型输出的小节标题文本识别）
    for (const h of Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
      const t = h.textContent || '';
      if (/分歧|不一致|争议/.test(t)) h.classList.add('sec-flag');
      else if (/待验证|需核实|未确认/.test(t)) h.classList.add('sec-soft');
    }
    // 报告后校验（零 token，结果随 entry 缓存，每次重绘不重复算）：
    // a) 数值溯源：报告中的数字在来源回答里找不到同值（中文数量级换算后）→ 块尾加待核实标记
    if (!entry.srcNums) entry.srcNums = MM.merge.sourceNums(results);
    for (const b of blocks) {
      if (b.el.querySelector('.merge-num')) continue;
      if (b.text.length < 6) continue;
      const missing = MM.merge.numsAudit(b.text, entry.srcNums);
      if (missing.length) b.el.appendChild(U.el('sup', {
        class: 'merge-num',
        title: '数值 ' + missing.join('、') + ' 未在原始回答中出现，可能为推算或笔误，请留意核实'
      }));
    }
    // b) 共识覆盖：预分析的共识要点没出现在报告里时，正文下方给一行提示；
    // 提示挂在 body 之外（卡片上），复制综合回答不会带入
    let unc;
    if (cacheHit) {
      unc = Array.isArray(cached.unc) ? cached.unc : [];
    } else {
      if (!entry.analysis) entry.analysis = MM.merge.analyze(results);
      if (!('uncovered' in entry)) entry.uncovered = MM.merge.uncoveredConsensus(entry.analysis.consensus, msg.content);
      unc = entry.uncovered;
    }
    if (unc.length) {
      const card = body.closest('.merge-card, .review-card');
      if (card && !card.querySelector('.merge-cov')) {
        // 审查卡片上对应的动作是「重新审查」而不是「重新综合」：提示指向用户实际能点的按钮
        const redo = body.closest('.review-card') ? '重新审查' : '重新综合';
        body.insertAdjacentElement('afterend', U.el('div', {
          class: 'merge-cov',
          title: unc.map(t => '· ' + t).join('\n')
        }, '⚠ ' + unc.length + ' 条共识要点未出现在报告中，可' + redo + '补全'));
      }
    }
    // 未命中缓存且这次是全量新算（没有跳过已装饰块）：写回缓存随会话落盘。
    // 命中句文本截断防膨胀；块数上限防病态超长报告把会话文件撑大
    if (!cacheHit && allFresh && blocks.length <= 400) {
      const cap = s => String(s || '').slice(0, 240);
      msg.deco = {
        v: 1, h: entry.sig, unc: unc.slice(0, 20),
        blocks: blocks.map(b => {
          const hs = entry.hits.get(b.text) || [];
          return { m: hs.map(h => h.modelId), s: hs.map(h => cap(h.text)) };
        })
      };
      MM.save();
    }
  }

  function jumpToSource(roundId, models, hits) {
    const grid = byRound('.answers', roundId);
    if (!grid) { U.toast('未找到本轮回答卡片'); return; }
    let card = null;
    for (const m of models) {
      card = Array.from(grid.querySelectorAll('.answer-card'))
        .find(c => c.getAttribute('data-model-id') === m.modelId);
      if (card) break;
    }
    if (!card) { U.toast('原回答卡片不在当前视图'); return; }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('src-flash');
    void card.offsetWidth; // 重启动画
    card.classList.add('src-flash');
    setTimeout(function () { card.classList.remove('src-flash'); }, 1800);
    // 精准定位：高亮来源回答里命中原句所在的段落（底色+描边加粗，约 2 秒消退）。
    // 探针取命中句开头若干字在渲染文本里找所属块；行内加粗等格式差异会导致
    // 个别句子找不到块——此时退回整卡闪烁，角标匹配本就是尽力而为
    for (const h of (hits || [])) {
      if (!h || !h.text) continue;
      const probe = h.text.trim().replace(/^[-*+>#\s]+/, '').slice(0, 10);
      if (probe.length < 4) continue;
      const c = Array.from(grid.querySelectorAll('.answer-card'))
        .find(el => el.getAttribute('data-model-id') === h.modelId) || card;
      let done = false;
      for (const el of Array.from(c.querySelectorAll('p, li'))) {
        if ((el.innerText || '').indexOf(probe) < 0) continue;
        el.classList.remove('src-hit');
        void el.offsetWidth; // 重启动画
        el.classList.add('src-hit');
        setTimeout(function () { el.classList.remove('src-hit'); }, 2000);
        done = true;
        break; // 每个命中点只标一个块
      }
    }
  }

  // ---------- 版本历史 ----------
  // 每轮回答的快照：{ results, merge, at }；am.active 指向当前显示的版本
  function snapshotOf(am) {
    // 版本池不带装饰缓存（deco）：切版本走重算（低频路径），池不随缓存膨胀
    const merge = am.merge ? JSON.parse(JSON.stringify(am.merge)) : null;
    if (merge && merge.deco) delete merge.deco;
    return {
      results: JSON.parse(JSON.stringify(am.results || [])),
      merge: merge,
      at: Date.now()
    };
  }
  function hasUsefulResults(results) {
    return (results || []).some(r => (r.status === 'done' || r.status === 'stopped') && r.content);
  }
  // 一批版本快照里已被计入会话累计的真实用量（结果 + 综合；inherited 副本的结果与
  // 上一份共享，不计）。版本池裁剪前折进 am.prunedTokens，sessionTokens 会把它
  // 加回来——否则每轮换掉最旧版本，会话累计 token 反而变小。
  function prunedTokensOf(versions) {
    let sum = 0;
    const add = u => { if (u) sum += (u.input || 0) + (u.output || 0); };
    for (const v of (versions || [])) {
      if (!v) continue;
      // partial 快照（单模型重试）的 merge 是上一份的副本：综合没重跑，不能再计一次
      if (v.merge && !v.partial) add(v.merge.usage);
      if (!v.inherited) {
        // partial 快照只计重发的那一个模型（与 sessionTokens 同口径），
        // 否则裁剪时又把旧模型的用量多折一次
        if (v.partial && v.partialModelId) {
          const r = (v.results || []).find(x => x && x.modelId === v.partialModelId);
          if (r) add(r.usage);
        } else {
          for (const r of (v.results || [])) if (r) add(r.usage);
        }
      }
    }
    return sum;
  }
  function inheritVersionsOf(am) {
    // 仅继承含有效回答的版本；当前显示全失败时不入池
    const versions = (Array.isArray(am.versions) ? am.versions : [])
      .filter(v => hasUsefulResults(v.results))
      .map(v => JSON.parse(JSON.stringify(v)));
    if (hasUsefulResults(am.results)) {
      const cur = snapshotOf(am);
      const last = versions[versions.length - 1];
      // 当前显示若与最后一份快照不同（或池为空），把当前显示也存入版本池
      if (!last || JSON.stringify(last.results) !== JSON.stringify(cur.results) || JSON.stringify(last.merge || null) !== JSON.stringify(cur.merge || null)) {
        versions.push(cur);
      }
    }
    return versions;
  }
  function setVersion(am, i) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; } // 综合生成中切换会错乱版本快照
    if (!am.versions || !am.versions.length) return;
    const idx = Math.max(0, Math.min(am.versions.length - 1, i));
    if (idx === am.active) return;
    am.active = idx;
    am.results = JSON.parse(JSON.stringify(am.versions[idx].results));
    am.merge = am.versions[idx].merge ? JSON.parse(JSON.stringify(am.versions[idx].merge)) : null;
    MM.save();
    // 版本切换只换这一轮的内容：整页 fade 属于"切会话"的语言，这里用局部 crossfade
    suppressFade = true;
    renderAll();
    for (const sel of ['.answers', '.merge-card']) {
      const el = byRound(sel, am.roundId);
      if (el) { el.classList.remove('ver-swap'); void el.offsetWidth; el.classList.add('ver-swap'); }
    }
  }

  // anim=true 时给工具栏加入场动画类（renderAll 里由调用方统一标记最后一轮，避免历史轮次重播动画）
  function roundTools(am, anim) {
    const hasMerge = !!(am.merge && am.merge.content);
    const tools = U.el('div', { class: 'round-tools' + (anim ? ' anim-in' : ''), 'data-round': am.roundId });
    if (am.versions && am.versions.length > 1) {
      const idx = typeof am.active === 'number' ? am.active : am.versions.length - 1;
      const snap = am.versions[idx] || {};
      const timeStr = snap.at ? U.fmtTime(snap.at) : '';
      tools.appendChild(U.el('button', {
        class: 'tool-btn', title: '上一版本', html: U.svgIcon('left', 9),
        onclick: function () { setVersion(am, idx - 1); },
        disabled: idx <= 0
      }));
      tools.appendChild(U.el('span', {
        class: 'ver-label',
        title: snap.at ? '此版本生成于 ' + new Date(snap.at).toLocaleString('zh-CN') : ''
      },
        '版本 ' + (idx + 1) + '/' + am.versions.length +
        (timeStr ? ' · ' + timeStr : '') +
        (idx === am.versions.length - 1 ? '（最新）' : '')));
      tools.appendChild(U.el('button', {
        class: 'tool-btn', title: '下一版本', html: U.svgIcon('right', 9),
        onclick: function () { setVersion(am, idx + 1); },
        disabled: idx >= am.versions.length - 1
      }));
    }
    tools.appendChild(U.el('button', { class: 'tool-btn', title: '只重新调用本轮全部模型', onclick: function () { retryRound(am.roundId); } },
      U.el('span', { class: 'ico', html: U.svgIcon('redo', 11) }), '重新生成'));
    // 综合入口常驻：已有综合时变成「重新综合」（旧综合保留在版本历史中）
    tools.appendChild(U.el('button', {
      class: 'tool-btn',
      title: hasMerge ? '用当前设置重新生成综合回答（覆盖现有这份，旧综合保留在版本历史中）' : '把多个模型的回答合并为一份综合回答',
      onclick: function () { doMerge(am.roundId, { redo: hasMerge }); }
    }, hasMerge ? '重新综合' : '综合回答'));
    // 交叉审查入口常驻：已有审查时变成「重新审查」（新增一份记录，历史保留）
    const hasReview = hasAnyReview(am);
    tools.appendChild(U.el('button', {
      class: 'tool-btn',
      title: hasReview ? '用当前设置再进行一次交叉审查（新增一份记录，最多保留 5 份）' : '各模型互相审查本轮回答，仲裁给出最终结论',
      onclick: function () { doReview(am.roundId, { redo: hasReview }); }
    }, hasReview ? '重新审查' : '交叉审查'));
    tools.appendChild(U.el('button', {
      class: 'tool-btn', title: '把这一轮的提问与全部回答导出为 Markdown 文件',
      onclick: function () { exportRound(am.roundId); }
    }, '导出本轮'));
    tools.appendChild(U.el('button', {
      class: 'tool-btn danger', title: '删除这一轮提问与全部回答',
      onclick: function () { deleteRound(am.roundId); }
    }, '删除本轮'));
    // 本轮合计 token：放在最后，不打乱既有按钮顺序
    const total = roundUsage(am);
    if (total) {
      const usageRows = [];
      for (const r of (am.results || [])) usageRows.push(r);
      if (am.merge && am.merge.mode !== 'frontend') usageRows.push(am.merge);
      for (const rv of (am.reviews || [])) {
        for (const it of (rv.items || [])) usageRows.push(it);
        if (rv.verdict) usageRows.push(rv.verdict);
      }
      const n = usageRows.filter(r => r.usage && (r.usage.input || r.usage.output)).length;
      // 本轮花费合计：按各模型单价分别解析；一个已知的都没有就不显示金额
      let cost = 0, costAny = false;
      for (const r of usageRows) {
        const c = MM.costOf ? MM.costOf(r.modelId, r.usage) : null;
        if (c != null) { costAny = true; cost += c; }
      }
      tools.appendChild(U.el('span', {
        class: 'round-tok',
        title: '本轮 ' + n + ' 个请求的 token 用量合计（回答、综合与审查）' +
          (costAny ? '；花费 ≈' + MM.modelInfo.fmtCost(cost) + '（单价未知的模型不计入）' : '')
      }, 'Σ ' + MM.modelInfo.fmtTokens(total) + ' tok' + (costAny ? ' · ≈' + MM.modelInfo.fmtCost(cost) : '')));
    }
    return tools;
  }

  // 查找该轮正在进行中的流式请求上下文（用于切换会话后重建事件绑定）
  function liveCtxFor(am) {
    for (const ctx of pending.values()) {
      if (ctx.assistantMsg === am) return { type: 'round', ctx };
      if (ctx.am === am && ctx.mergeMsg) return { type: 'merge', ctx };
      if (ctx.am === am && ctx.reviewCtx) return { type: 'review', ctx };
    }
    return null;
  }

  // ---------- 轮次 DOM 回收 ----------
  // 实测（2.8MB 会话库）：renderAll 全量重建 360 张卡片约 270-330ms，切换会话/版本可感卡顿。
  // 签名未变的轮次直接复用上一次的节点（还保留思考过程/来源的展开状态），只重建变化的轮。
  // 池按会话分（key=sessionId），LRU 只保留最近 2 个会话，内存有界；
  // 流式进行中的轮次不进池（每次 renderAll 都要重建事件绑定，见 live 分支）。
  const roundDom = new Map(); // sessionId -> Map(roundId -> { sig, userEl, mids: [gridEl, mergeEl?, toolsEl] })
  const roundDomLru = [];

  function roundSig(m, am) {
    const u = m.id + '|' + m.content + '|' + (m.images || []).length + '|' + (m.files || []).length;
    if (!am) return 'U:' + u;
    const rs = (am.results || []).map(r =>
      r.status + ',' + (r.content || '').length + ',' + (r.reasoning || '').length +
      ',' + (r.sources ? r.sources.length : 0) + ',' + (r.usage && (r.usage.input || r.usage.output) ? 1 : 0) +
      ',' + (r.error ? 1 : 0) + ',' + (r.ms || 0)
    ).join(';');
    // content/mode 一律按空值兜底：导入或旧版本固化的 merge 可能只有 usage 没有 content，
    // 直接读 .length 会抛 TypeError 让 renderAll 整页失败（启动即错误遮罩）
    const mg = am.merge
      ? (am.merge.content || '').length + ',' + (am.merge.mode || '') + ',' + (am.merge.usage ? 1 : 0)
      : '-';
    // 交叉审查状态也要进签名：审查完成/失败会变卡内容，池里旧节点必须失效重建。
    // 活跃份 + 份数/指针一起进签名：切换历史或新增审查时同样触发重建
    const rvA = activeReviewOf(am);
    const rv = rvA
      ? (rvA.items || []).map(i => ((i && i.status) || '') + ':' + ((i && i.content) || '').length).join(';') +
        '|' + (rvA.verdict
          // verdict.content 同理可为空（仲裁占位已建、正文未到就被中断）
          ? ((rvA.verdict.content || '').length + (rvA.verdict.usage ? 'u' : '') + (rvA.verdict.stopped ? 's' : ''))
          : '-') + (rvA.stopped ? 'S' : '')
      : '';
    return 'A:' + u + '|' + am.active + ',' + ((am.versions || []).length) + '|' + rs + '|' + mg + '|' + rv +
      '|R' + ((am.reviews || []).length) + ',' + (typeof am.reviewActive === 'number' ? am.reviewActive : -1);
  }

  function renderAll() {
    const wrap = U.$('#messages');
    const s = MM.sessions.current();
    U.$('#composer').style.display = s ? '' : 'none';
    // 先同步按钮状态：空会话会提前 return，放在末尾会漏掉
    refreshSendBtn();
    // 顶栏提示词按钮与面板也要先同步：空会话提前 return 时同样不能显示上一个会话的状态
    refreshPromptBadge();
    syncPromptBox();
    if (!s || !s.messages.length) {
      wrap.innerHTML = '';
      wrap.appendChild(emptyState());
      return;
    }
    // 回收池：当前会话置顶，最多留 2 个会话的缓存
    let pool = roundDom.get(s.id);
    if (!pool) { pool = new Map(); roundDom.set(s.id, pool); }
    const lruIdx = roundDomLru.indexOf(s.id);
    if (lruIdx >= 0) roundDomLru.splice(lruIdx, 1); // 去重后再置顶：重复 unshift 会让一个会话占满判活窗口
    roundDomLru.unshift(s.id);
    if (roundDomLru.length > 8) roundDomLru.length = 8; // 只用前 2 位判存活，尾部截掉防无限增长
    for (const k of Array.from(roundDom.keys())) {
      const keep = roundDomLru.slice(0, 2).indexOf(k) >= 0;
      if (!keep) roundDom.delete(k);
    }
    wrap.innerHTML = ''; // 旧节点detach但不销毁：池里持有引用的直接搬回来
    let i = 0;
    // 统一在文档片段中构建，最后一次挂载（整列表只触发一次重排）
    const frag = document.createDocumentFragment();
    let seenUser = false; // 除第一条提问外，每条用户消息上方加轮次分隔线
    // 入场动画只标最后一轮：大会话（几十轮）切进来时不再给每轮重播动画（O(N)→O(1)）
    let lastRoundEls = null;
    while (i < s.messages.length) {
      const m = s.messages[i];
      if (m.role === 'user') {
        if (seenUser) frag.appendChild(U.el('div', { class: 'round-sep' }));
        seenUser = true;
        lastRoundEls = [];
        i++;
        // 收集该轮的 assistant（兼容旧格式：独立 merge 消息在迁移时已折叠，此处兜底忽略）
        let am = null;
        while (i < s.messages.length && s.messages[i].role !== 'user') {
          if (s.messages[i].role === 'assistant') am = s.messages[i];
          i++;
        }
        if (am) {
          const live = liveCtxFor(am);
          const sig = roundSig(m, am);
          const hit = live ? null : pool.get(am.roundId);
          if (hit && hit.sig === sig) {
            // 轮次内容没变：整轮节点原样搬回（含展开状态），跳过重建
            frag.appendChild(hit.userEl);
            for (const el of hit.mids) frag.appendChild(el);
            lastRoundEls.push(hit.userEl);
            for (const el of hit.mids) lastRoundEls.push(el);
            // 空闲装饰在游离期间被跳过的卡（切走太快）：复用进 DOM 后立即补装饰
            for (const el of hit.mids) {
              for (const pend of (el.querySelectorAll ? el.querySelectorAll('.deco-pending') : [])) {
                pend._decoQueued = false;
                pend.classList.remove('deco-pending');
                const args = pend._decoArgs || null;
                pend._decoArgs = null;
                if (args) decorateMergeSources(pend, args[0], args[1], args[2]);
              }
            }
          } else {
            const userEl = renderUser(m);
            frag.appendChild(userEl);
            const mids = [];
            // 该轮若有进行中的流式请求：以流式样式重建卡片，并把事件绑定切到新 DOM
            let grid;
            if (live && live.type === 'round') {
              grid = U.el('div', { class: 'answers', 'data-round': am.roundId });
              // 已完成的模型按渲染态显示，仍在生成的才显示流式样式
              const cards = new Map();
              for (const r of am.results) {
                const card = answerCard(r, r.status === 'streaming', am.roundId);
                grid.appendChild(card);
                cards.set(r.modelId, cardRefs(card));
              }
              live.ctx.grid = grid;
              live.ctx.cards = cards; // 重建后事件分发要用新的节点引用
            } else {
              grid = answersGrid(am);
            }
            frag.appendChild(grid);
            mids.push(grid);
            const liveMerge = live && live.type === 'merge';
            if (liveMerge || (am.merge && am.merge.content)) {
              const card = mergeCard(am.merge, !!liveMerge, am.roundId, am.results);
              frag.appendChild(card);
              mids.push(card);
              if (liveMerge) {
                live.ctx.mergeBody = card.querySelector('.ac-body');
                live.ctx.mergeStatus = card.querySelector('.ac-status');
              }
            }
            const liveReview = live && live.type === 'review';
            if (liveReview || hasAnyReview(am)) {
              const rc = reviewCard(liveReview ? live.ctx.review : activeReviewOf(am), !!liveReview, am.roundId, am.results,
                liveReview ? live.ctx.reviewPhase : null, am);
              frag.appendChild(rc);
              mids.push(rc);
              if (liveReview) {
                // 重绘后事件绑定要指向新 DOM（与 liveMerge 同理）
                live.ctx.rvCard = rc;
                live.ctx.rvRefs = reviewRefsOf(rc);
              }
            }
            const tools = roundTools(am, false);
            mids.push(tools);
            frag.appendChild(tools);
            lastRoundEls.push(userEl);
            for (const el of mids) lastRoundEls.push(el);
            // 流式轮次不入池：下一次 renderAll 必须重建绑定
            if (!live) pool.set(am.roundId, { sig: sig, userEl: userEl, mids: mids });
          }
        } else if (i >= s.messages.length) {
          // 这一轮没有回答（例如联网搜索阶段被停止）：补一个「重新生成」入口，
          // 否则这条提问只能删掉重发（临时态不入池）
          frag.appendChild(renderUser(m));
          const t = userRetryTools(m);
          lastRoundEls.push(t);
          frag.appendChild(t);
        } else {
          // 中间的无回答轮次（历史遗留格式）：只渲染提问
          frag.appendChild(renderUser(m));
        }
      } else {
        i++;
      }
    }
    for (const el of lastRoundEls || []) el.classList.add('anim-in');
    wrap.appendChild(frag);
    scrollBottom(true);
    // 会话切换/重建后整体淡入一次；版本切换已抑制（走局部 ver-swap）
    if (!suppressFade) {
      wrap.classList.remove('fade-in');
      void wrap.offsetWidth; // 强制重排，让连续两次 renderAll 也能重启动画
      wrap.classList.add('fade-in');
    }
    suppressFade = false;
  }

  // 用户气泡里的附件展示：图片缩略图（点击放大）/ 文档芯片（点击看提取全文）
  function attachRow(msg) {
    const row = U.el('div', { class: 'msg-attach' });
    let n = 0;
    for (const im of (msg.images || [])) {
      if (!im || !im.id) continue;
      n++;
      row.appendChild(U.el('img', {
        class: 'msg-thumb', src: 'mmimg://' + im.id + '.' + im.ext, alt: im.name || '图片',
        title: (im.name || '图片') + (im.text ? '（已提取 ' + im.text.length + ' 字）' : '（未提取到文字）') + '，点击放大',
        onclick: function () { previewAttachment({ kind: 'image', id: im.id, ext: im.ext, name: im.name }); }
      }));
    }
    for (const f of (msg.files || [])) {
      if (!f) continue;
      n++;
      row.appendChild(U.el('button', {
        class: 'msg-file', title: '点击查看提取的全文',
        onclick: function () { previewAttachment({ kind: 'file', name: f.name, text: f.text }); }
      }, '📄 ' + (f.name || '附件') + ' · ' + (f.chars || (f.text ? f.text.length : 0)) + ' 字'));
    }
    return n ? row : null;
  }

  function renderUser(msg) {
    // 编辑态下不显示编辑按钮（避免按钮被替换后绑不到事件）
    const editBtn = U.el('div', { class: 'copy-hint', onclick: function () { startEdit(msg); } }, '编辑');
    return U.el('div', { class: 'user-msg' },
      U.el('div', { class: 'user-bubble' },
        msg.content ? U.el('div', { style: 'white-space:pre-wrap' }, msg.content) : null,
        attachRow(msg),
        U.el('div', { class: 'copy-hints' },
          U.el('div', { class: 'copy-hint', onclick: function () { U.copyText(msg.content); } }, '复制'),
          editBtn)
      ));
  }

  // ---------- 编辑重发 ----------
  // 把这条用户消息就地改成编辑框；保存后删除它后面的所有轮次并重新发送。
  function startEdit(msg) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const bubble = findUserBubble(msg);
    if (!bubble) return;
    // 已存在的编辑框不再重复插入（连点两次会套两层）
    if (bubble.querySelector('.edit-box')) return;
    // 其它气泡先退出编辑态，避免同屏出现多个编辑框（要连原文一起还原）
    closeOtherEdits(bubble);

    const idx = s.messages.indexOf(msg);
    const hasTail = s.messages.some((m, i) => i > idx && m.role === 'assistant');
    const ta = U.el('textarea', { class: 'edit-input', rows: '3' });
    ta.value = msg.content;
    const box = U.el('div', { class: 'edit-box' }, ta,
      U.el('div', { class: 'edit-actions' },
        U.el('span', { class: 'edit-hint' }, hasTail ? '保存后会删除这条消息之后的全部对话（含后续提问）并重新发送' : '保存后重新发送'),
        U.el('button', { class: 'btn-ghost', onclick: function () { cancelEdit(msg); } }, '取消'),
        U.el('button', { class: 'btn-primary', onclick: function () { saveEdit(msg); } }, '保存并重发')));
    // 原文隐藏但保留（取消时能还原），不要直接清空
    const orig = bubble.querySelector('[style*="pre-wrap"]');
    if (orig) orig.classList.add('hidden');
    // 插到内容与按钮之间；参照节点不存在时退化为追加到末尾，不能让它静默丢失
    const hintRow = bubble.querySelector('.copy-hints');
    if (hintRow) bubble.insertBefore(box, hintRow); else bubble.appendChild(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoResizeTextarea(ta);
    // 中文输入法兼容
    let composing = false;
    ta.addEventListener('compositionstart', function () { composing = true; });
    ta.addEventListener('compositionend', function () { composing = false; });
    ta.addEventListener('input', function () { autoResizeTextarea(ta); });
    ta.addEventListener('keydown', function (e) {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msg); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(msg); }
    });
  }

  // 关闭除 keep 以外的所有编辑框，并还原被隐藏的原文
  function closeOtherEdits(keep) {
    for (const box of Array.from(document.querySelectorAll('.user-bubble .edit-box'))) {
      const bubble = box.closest('.user-bubble');
      if (bubble === keep) continue;
      box.remove();
      const orig = bubble && bubble.querySelector('[style*="pre-wrap"]');
      if (orig) orig.classList.remove('hidden');
    }
  }

  function autoResizeTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px';
  }

  function findUserBubble(msg) {
    // 返回 .user-bubble（气泡本身），不是外层 .user-msg：
    // 编辑框要插在气泡内部，原文和按钮都在这一层
    const nodes = Array.from(document.querySelectorAll('.user-msg'));
    const i = MM.state.sessions.find(x => x.id === MM.state.currentId);
    if (!i) return null;
    const real = i.messages.filter(m => m.role === 'user').indexOf(msg);
    if (real < 0) return null;
    const outer = nodes[real];
    return outer ? outer.querySelector('.user-bubble') : null;
  }

  function cancelEdit(msg) {
    const bubble = findUserBubble(msg);
    if (!bubble) return;
    const box = bubble.querySelector('.edit-box');
    if (box) box.remove();
    const orig = bubble.querySelector('[style*="pre-wrap"]');
    if (orig) orig.classList.remove('hidden');
  }

  function saveEdit(msg) {
    if (streaming || sendLock) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const bubble = findUserBubble(msg);
    const box = bubble && bubble.querySelector('.edit-box');
    const ta = box && box.querySelector('.edit-input');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { U.toast('内容不能为空', true); return; }
    if (text === msg.content) { cancelEdit(msg); U.toast('内容未变化，已取消编辑'); return; }

    const models = selectedModels();
    if (!models.length) { U.toast('请先在输入框上方选择至少一个模型', true); return; }

    // 只保留这条消息及其之前的历史，后面的回答全部丢弃（用户明确要改这条提问）
    const idx = s.messages.indexOf(msg);
    if (idx < 0) return; // 消息已不在当前会话（例如刚导入/切换过），不能盲目 splice(-1+1) 清空全部
    s.messages.splice(idx + 1);
    msg.content = text;
    // 搜索结果是针对旧提问的，必须清掉，否则重新发送会带着过期来源
    delete msg.sources;
    if (s.title === '新会话' || s.messages.length === 1) s.title = text.slice(0, 30);
    s.updatedAt = Date.now();
    MM.save();
    renderAll();
    renderTitle();
    MM.sessions.render();

    streaming = s.id;
    setSendBtn(true);
    dispatchRound(s, msg, models, U.$('#tgl-search').checked, false)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

  // ---------- 会话提示词 ----------
  // 顶栏「提示词」按钮展开面板；会话里设了提示词时按钮点亮，便于一眼看出本会话有覆盖。
  function refreshPromptBadge() {
    const s = MM.sessions.current();
    const btn = U.$('#btn-session-prompt');
    if (!btn) return;
    const has = !!(s && typeof s.systemPrompt === 'string' && s.systemPrompt.trim());
    btn.classList.toggle('on', has);
    btn.title = has ? '本会话已设置提示词（点击编辑/清除）' : '为当前会话单独设置系统提示词（留空则用全局提示词）';
    const hint = U.$('#sp-hint');
    if (hint) {
      const g = MM.state.config && typeof MM.state.config.systemPrompt === 'string' ? MM.state.config.systemPrompt.trim() : '';
      hint.textContent = has ? '本会话提示词已启用' : (g ? '本会话未设置，将使用全局提示词' : '未设置提示词（可去设置里写全局的）');
    }
  }

  function togglePromptBox(forceOpen) {
    const box = U.$('#session-prompt-box');
    if (!box) return;
    const open = forceOpen === undefined ? box.classList.contains('hidden') : !!forceOpen;
    box.classList.toggle('hidden', !open);
    if (!open) return;
    const s = MM.sessions.current();
    const ta = U.$('#session-prompt');
    if (ta) ta.value = (s && typeof s.systemPrompt === 'string') ? s.systemPrompt : '';
    refreshPromptBadge();
    if (ta) ta.focus();
  }

  // 面板展开时把内容同步成当前会话的提示词（只在会话切换/整体重绘时调用，
  // 不能放进 refreshPromptBadge：每次输入都重设 value 会把光标顶到末尾）
  function syncPromptBox() {
    const box = U.$('#session-prompt-box');
    if (!box || box.classList.contains('hidden')) return;
    const s = MM.sessions.current();
    const ta = U.$('#session-prompt');
    if (ta) ta.value = (s && typeof s.systemPrompt === 'string') ? s.systemPrompt : '';
  }

  // ---------- 滚动：贴底检测 + 智能跟随 ----------
  // stickBottom 由滚动事件维护：流式期间不再每帧读 scrollHeight（读布局会强制同步重排）
  let stickBottom = true;
  function scrollBottom(force) {
    const w = U.$('#messages');
    if (force) stickBottom = true;
    if (stickBottom) w.scrollTop = 1e9; // 超大值由浏览器夹紧到最大位置，避免读 scrollHeight
  }

  // 流式渲染按帧合帧：同一帧内所有卡片只写一次 DOM、只做一次滚动
  // （scrollHeight/scrollTop 读取会强制重排，4 模型并发时每秒可达数十次 delta）
  let paintQueue = [];
  let paintRaf = 0;
  function scheduleStreamPaint(el, paint) {
    el._paint = paint; // 同一元素一帧内只保留最后一次（最新的完整文本）
    if (el._paintQueued) return;
    el._paintQueued = true;
    paintQueue.push(el);
    if (paintRaf) return;
    paintRaf = requestAnimationFrame(function () {
      paintRaf = 0;
      const q = paintQueue;
      paintQueue = [];
      for (const node of q) {
        node._paintQueued = false;
        const fn = node._paint;
        node._paint = null;
        if (fn) fn();
      }
      scrollBottom(); // 整帧只滚动一次
    });
  }

  // 流式绘制只追加不重写（E6）：长回答末段每帧整段 textContent 替换是 O(n²)
  // 字符复制。维护流式文本节点引用与已绘长度：内容单调增长时 appendData 只写
  // 增量；节点被终态 innerHTML 重建或内容回退时自动回退整写
  function paintStreamText(el, text) {
    const node = el._streamNode;
    if (node && node.parentNode === el && el.childNodes.length === 1 && node.data.length === el._streamLen) {
      if (text.length === el._streamLen) return;
      if (text.length > el._streamLen) {
        node.appendData(text.slice(el._streamLen));
        el._streamLen = text.length;
        return;
      }
    }
    el.textContent = text;
    el._streamNode = el.firstChild;
    el._streamLen = text.length;
  }

  function autoResize() {
    const ta = U.$('#input');
    const v = ta.value;
    // 超长文本（>10 万字符）跳过整框布局与 O(n) trim（E4）：粘贴 10MB 后每个键入
    // 都要付一次全量换行布局 + 整串复制。高度已钳在 200px，大文本态直接复用
    if (v.length > 100000) {
      if (!ta._bigInput) { ta._bigInput = true; ta.style.height = '200px'; }
    } else {
      ta._bigInput = false;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
    const btn = U.$('#btn-send');
    const wasReady = btn.classList.contains('ready');
    const ready = btn.classList.contains('stop') || (v.length > 0 && (v.length > 100000 || v.trim().length > 0)) || pendingAttach.some(a => !a.failed);
    btn.classList.toggle('ready', ready);
    // 从"空"到"有内容"的瞬间脉冲一次提示可发送
    if (ready && !wasReady) {
      btn.classList.remove('pulse');
      void btn.offsetWidth;
      btn.classList.add('pulse');
    }
  }
