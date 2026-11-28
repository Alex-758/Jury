'use strict';
// 聊天流·请求：发送/轮次分发/事件处理/停止/重新生成/单模型重试/综合回答/交叉审查。
  // ---------- 发送 ----------
  // 发送重入锁：附件 OCR/文档提取期间 send() 停在 await 上，此时 streaming 尚未置位，
  // 再次点击发送会完整通过上面的全部检查，恢复后重复入列消息、重复发起请求（双重计费）。
  let sendLock = false;
  async function send() {
    if (streamingHere()) { stopAll(); return; }
    if (streaming) {
      // 别的会话正在生成：不要静默停掉它，也不要把消息发错会话
      U.toast('「' + streamingSessionName() + '」正在生成中，请等待完成或切回该会话停止', true);
      return;
    }
    const input = U.$('#input');
    const text = input.value.trim();
    // 只贴了图/拖了文件、没打字也允许发送
    if (!text && !pendingAttach.length) return;
    const models = selectedModels();
    if (!models.length) { U.toast('请先在输入框上方选择至少一个模型', true); return; }
    if (sendLock) return;
    sendLock = true;
    try {
      // OCR/文档提取可能还在跑：等它们完成，否则图片会被静默丢掉。
      // 等待期间用户可能切走会话：先锁定目标，恢复后校验，消息绝不能落进切换后的会话
      const target = MM.sessions.current();
      await Promise.all(pendingAttach.map(a => a.ready).filter(Boolean));
      if (MM.sessions.current() !== target) {
        U.toast('附件处理期间已切换会话，发送已取消', true);
        return; // 输入框与附件条原样保留，切回原会话可重发
      }
      const atts = pendingAttach.filter(a => !a.failed && (a.kind !== 'image' || a.id));
      if (!text && !atts.length) { U.toast('附件处理失败，请移除后重试', true); return; }

      const s = target || MM.sessions.createSilent();
      const userMsg = { id: U.uid(), role: 'user', content: text, createdAt: Date.now() };
      const imgs = atts.filter(a => a.kind === 'image')
        .map(a => ({ id: a.id, ext: a.ext, name: a.name, w: a.w, h: a.h, size: a.size, text: a.text || '' }));
      if (imgs.length) userMsg.images = imgs;
      const files = atts.filter(a => a.kind === 'file' && a.text)
        .map(a => ({ name: a.name, chars: a.chars, text: a.text }));
      if (files.length) userMsg.files = files;
      s.messages.push(userMsg);
      if (s.title === '新会话') s.title = (text || (imgs.length ? '图片提问' : '附件提问')).slice(0, 30);
      s.updatedAt = Date.now();
      MM.save();
      MM.sessions.render();
      renderTitle();

      // 清空空状态
      const wrap = U.$('#messages');
      const es = wrap.querySelector('.empty-state');
      if (es) es.remove();
      // 上一条"无回答"提问留下的重新生成入口已经过期（后面有新消息了），先移除
      for (const t of Array.from(wrap.querySelectorAll('.round-tools.retry-only'))) t.remove();
      wrap.appendChild(renderUser(userMsg));
      scrollBottom(true);
      // 只清掉发送时快照的内容：OCR/文档提取等待期间用户又打的字保留在输入框里，不能静默丢掉
      if (input.value.trim() === text) {
        input.value = '';
      }
      autoResize();
      pendingAttach = [];
      renderAttachBar();

      // 立即锁定状态：联网搜索 await 期间不允许再次发送/重试（防竞态）
      streaming = s.id;
      setSendBtn(true);
      dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, true)
        .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
    } finally {
      sendLock = false; // dispatchRound 已发起，streaming 已置位，后续点击由 streaming 守卫拦住
    }
  }

  // 发起一轮多模型请求并渲染占位卡片（inheritVersions：重试时继承的历史版本池；
  // carriedPruned：上一轮已累计的版本裁剪用量，轮次重建后要接着记，不能凭空消失）
  function nativeSearch(m) {
    return !!(m && (m.provider === 'dashscope' || m.provider === 'zhipu' || m.provider === 'openrouter'));
  }

  async function dispatchRound(s, userMsg, models, searchOn, appendUserDom, inheritVersions, carriedPruned) {
    const myToken = ++runToken;
    const wrap = U.$('#messages');
    // 关闭联网搜索时不能沿用上一轮缓存的来源（旧结果可能已过时，还会把 searchOn 抬成 true）
    let searchResults = null;
    let preGrid = null; // 搜索期间的占位网格（避免"点了发送界面没反应"）
    const needsWebSearch = searchOn && models.some(m => !nativeSearch(m));
    if (needsWebSearch) {
      searchResults = userMsg.sources || null;
      // 纯图片提问没有可搜的文字：跳过搜索阶段，避免拿空串去请求
      if (!searchResults && String(userMsg.content || '').trim()) {
        // 搜索要等 1~3 秒甚至更久：先挂一排「搜索中…」占位卡片，让用户立刻看到进展
        if (MM.sessions.current() === s) {
          preGrid = U.el('div', { class: 'answers anim-in' });
          for (const m of models) {
            preGrid.appendChild(answerCard(
              { modelId: m.id, name: m.name || m.modelId, status: 'searching', content: '' }, true, ''));
          }
          for (const t of Array.from(wrap.querySelectorAll('.round-tools.retry-only'))) t.remove();
          wrap.appendChild(preGrid);
          scrollBottom(true);
        }
        searchPhase++;
        const searchId = nextReqId('sr');
        curSearchId = searchId;
        curSearchSessionId = s.id;
        try {
          searchResults = await api.search(userMsg.content, 6, searchId);
          if (!searchResults || !searchResults.length) U.toast('联网搜索未返回结果（可在设置中检查搜索引擎）');
        } catch (e) {
          // 被停止（chat:stop 经 activeRequests 中止）或已开新一轮：属预期，静默；
          // 其余失败照常提示
          if (runToken !== myToken || /已停止/.test(e.message || '')) {
            searchResults = null;
          } else {
            U.toast('联网搜索失败：' + e.message, true);
            searchResults = null;
          }
        } finally {
          searchPhase--;
          // 旧搜索可能在新搜索已登记后才结束，只有仍指向本次 ID 才能清理全局句柄。
          if (curSearchId === searchId) {
            curSearchId = null;
            curSearchSessionId = null;
          }
        }
        if (searchResults && searchResults.length) userMsg.sources = searchResults;
      }
    }
    // 搜索期间用户点了停止（或已开始新一轮）：放弃本轮（此时助手消息尚未入列，干净退出）
    if (streaming !== s.id || runToken !== myToken) {
      if (preGrid && preGrid.isConnected) preGrid.remove();
      if (!streaming) {
        U.toast('已取消');
        // 该提问没有回答：重绘出「重新生成」入口（会话已切走时由切回时的 renderAll 负责）
        if (MM.sessions.current() === s) renderAll();
      }
      return;
    }

    const roundId = U.uid();
    const reqId = nextReqId('req');
    // 历史按模型各自的上下文窗口和输出上限裁剪，避免小窗口模型压缩所有模型的历史，
    // 也避免某个模型的超大输出上限挤占其他模型的输入预算。
    // 多模态模型的当前轮带原图引用，纯文本模型带提取的文字。
    const skipped = m => modelSkippedForRound(m, userMsg);
    const targets = models.filter(m => !skipped(m))
      .map(m => ({ model: stripModel(m), searchOn: !!searchOn && nativeSearch(m), messages: buildHistory(s, userMsg,
        nativeSearch(m) ? null : searchResults,
        m.contextTokens || 0, m.maxTokens || 4096, m) }));

    const assistantMsg = {
      id: U.uid(), role: 'assistant', roundId: roundId, createdAt: Date.now(),
      // 记下本轮是否带了联网（原生搜索的服务商重试时要保持同样条件；前端搜索看 sources）
      searchOn: !!searchOn,
      versions: Array.isArray(inheritVersions) ? inheritVersions : [],
      active: Array.isArray(inheritVersions) ? inheritVersions.length - 1 : -1,
      results: models.map(m => {
        const r = { modelId: m.id, name: m.name || m.modelId, status: 'streaming', content: '', reasoning: '' };
        if (skipped(m)) { r.status = 'skipped'; r.error = '该模型不支持图片，且图中未提取到文字'; }
        return r;
      })
    };
    if (carriedPruned) assistantMsg.prunedTokens = carriedPruned;
    // 把联网搜索来源挂到每个回答上：卡片里的来源区从这里读取
    if (searchResults && searchResults.length) {
      for (const r of assistantMsg.results) {
        if (!nativeSearch(models.find(m => m.id === r.modelId))) r.sources = searchResults;
      }
    }
    s.messages.push(assistantMsg);
    s.updatedAt = Date.now();
    // 这里不落盘：所有调用方（send/retryRound/saveEdit/retryUser）在进入本函数前
    // 已经把用户消息/裁剪结果保存过了。占位卡片没有内容，等 all-done 再连同结果一起写，
    // 可以少一次整份会话历史的 IPC 复制与磁盘写入。

    streaming = s.id;
    // 搜索 await 期间用户可能已切到别的会话：只锁当前查看的就是本轮会话的输入框，
    // 否则后台轮会把别的会话输入框锁成"生成中"（与 doMerge/doReview 的守卫同款）
    if (MM.sessions.current() === s) setSendBtn(true);
    MM.sessions.render(); // 会话列表立刻出现"生成中"呼吸点（切到别的会话也能看到后台在跑）

    const grid = U.el('div', { class: 'answers anim-in', 'data-round': roundId });
    // 缓存每张卡片的节点引用：流式期间每个 delta 都要更新状态/正文，
    // 逐个事件 querySelector 会在 4 模型并发时放大成大量 DOM 查询
    const cards = new Map();
    for (const r of assistantMsg.results) {
      // 跳过的模型（不支持图片）不是流式：必须按状态建卡，否则看不到跳过说明
      const card = answerCard(r, r.status === 'streaming', roundId);
      grid.appendChild(card);
      cards.set(r.modelId, cardRefs(card));
    }
    if (appendUserDom) { /* user DOM 已在 send() 中追加 */ }
    pending.set(reqId, { session: s, assistantMsg: assistantMsg, grid: grid, userMsg: userMsg, cards: cards });
    // 前面 await 过联网搜索：这期间用户可能已切到别的会话，
    // 此时不能把卡片挂到当前视图上（否则会串进别的会话界面）。
    // 数据照常更新，切回本会话时 renderAll 会把进行中的流式卡片重画出来。
    if (MM.sessions.current() === s) {
      // 搜索期间重绘可能留下"重新生成"临时工具栏：回答卡片要替换它，不能排在它后面
      for (const t of Array.from(wrap.querySelectorAll('.round-tools.retry-only'))) t.remove();
      // 搜索占位网格原位替换成真正的回答网格（避免 spinner 态闪一下）
      if (preGrid && preGrid.isConnected) preGrid.replaceWith(grid);
      else wrap.appendChild(grid);
      scrollBottom(true);
    }
    try {
      await api.send({ requestId: reqId, targets: targets, searchOn: false });
    } catch (e) {
      pending.delete(reqId);
      streaming = null;
      setSendBtn(false);
      // 请求没能启动：把占位卡片标成失败并落盘，避免界面上永远转圈
      for (const r of assistantMsg.results) {
        if (r.status === 'streaming') { r.status = 'error'; r.error = '请求失败：' + e.message; }
      }
      MM.save();
      renderAll();
      U.toast('请求失败：' + e.message, true);
    }
  }

  // ---------- 事件分发（全局只订阅一次） ----------
  function handleEvent(ev) {
    const ctx = pending.get(ev.requestId);
    if (!ctx) return;
    const wrap = U.$('#messages');

    if (ev.type === 'all-done') {
      pending.delete(ev.requestId);
      // 还有其它请求在跑、或有新一轮正在搜索时，不能把 streaming 清掉
      if (!pending.size && !searchPhase) { streaming = null; refreshSendBtn(); }
      if (ctx.reviewCtx) { onReviewAllDone(ctx); return; }
      if (ctx.mergeMsg) {
        // 综合请求结束：同步到当前版本的快照。必须走 syncMergeToVersion（带 deco 剥离），
        // 不能在这里内联拷贝——版本快照不带装饰缓存是同一不变量，两份实现迟早改漏一处
        syncMergeToVersion(ctx.am);
        finalizeMergeCard(ctx, !!ctx.mergeFailed);
        MM.save();
        return;
      }
      // 回答轮结束：保存本版本快照（全部模型都失败时不入版本池；每轮最多保留 10 版）
      const am = ctx.assistantMsg;
      if (hasUsefulResults(am.results)) {
        am.versions = am.versions || [];
        const snap = snapshotOf(am);
        // 单模型重试的快照只真实重发了一个模型：其余条目是从上一份快照原样
        // 带来的旧数据。打 partial 标记，sessionTokens/prunedTokensOf 对这种
        // 快照只计 partialModelId 那一条的用量，会话累计不再重复计数
        if (ctx.singleRetry && ctx.retryModelId) {
          snap.partial = true;
          snap.partialModelId = ctx.retryModelId;
        }
        if (!am.versions.length || JSON.stringify(am.versions[am.versions.length - 1].results) !== JSON.stringify(snap.results)) {
          am.versions.push(snap);
        }
        if (am.versions.length > 10) {
          // 只保留最近 10 版；被裁版本的用量折进 prunedTokens，会话累计不缩水
          am.prunedTokens = (am.prunedTokens || 0) + prunedTokensOf(am.versions.splice(0, am.versions.length - 10));
        }
        am.active = am.versions.length - 1;
      } else if (typeof am.active !== 'number' || am.active < 0) {
        am.active = Array.isArray(am.versions) ? am.versions.length - 1 : -1;
      }
      // 重建轮次工具栏（版本导航 / 重新生成 / 综合回答入口）
      const oldTools = byRound('.round-tools', am.roundId, wrap);
      if (oldTools) oldTools.remove();
      if (ctx.grid) ctx.grid.after(roundTools(am, true));
      MM.save();
      MM.sessions.render();
      // 整轮全失败时没有可合并的内容，不要弹「没有可合并的成功回答」；
      // 单模型重试不自动重跑综合：用户只是补一个失败的模型，重写全部综合既慢又费钱。
      // 用户点过停止的轮次（存在 stopped 半成品）不再自动发起综合/审查——
      // 停止意图优先（与仲裁阶段停止同款考量），补全走「重新综合」「重新审查」
      const userStopped = (am.results || []).some(r => r && r.status === 'stopped');
      if (!ctx.singleRetry && !userStopped && hasUsefulResults(am.results)) {
        // 交叉审查开关开启时自动流程走审查（仲裁结论已覆盖综合的职责），自动综合让位；
        // 成功回答不足两份审不起来，退回普通综合
        if (U.$('#tgl-review').checked) {
          const okCount = am.results.filter(r => (r.status === 'done' || r.status === 'stopped') && r.content).length;
          if (okCount >= 2) doReview(am.roundId);
          else if (U.$('#tgl-auto').checked) doMerge(am.roundId);
        } else if (U.$('#tgl-auto').checked) doMerge(am.roundId);
      }
      else if (ctx.singleRetry && am.merge && am.merge.content && hasUsefulResults(am.results)) {
        // 重试成功后旧综合容易被当成最新结论，提醒一句（重试失败则旧综合仍准确，不打扰）
        const retried = (am.results || []).find(r => r.modelId === ctx.retryModelId);
        if (retried && (retried.status === 'done' || retried.status === 'stopped')) {
          U.toast('回答已更新' + (hasAnyReview(am) ? '，综合回答与交叉审查仍是旧版，可点「重新综合」「重新审查」更新' : '，综合回答仍是旧版，可点「重新综合」更新'));
        }
      }
      return;
    }

    if (ctx.reviewCtx) { onReviewEvent(ev, ctx); return; }

    if (ctx.mergeMsg) {
      const body = ctx.mergeBody, status = ctx.mergeStatus;
      if (ev.type === 'start') { status.innerHTML = '<span class="spinner"></span> 生成中…'; }
      else if (ev.type === 'delta') {
        ctx.mergeMsg.content = U.stripEmoji(ctx.mergeMsg.content + ev.text);
        scheduleStreamPaint(body, function () { if (!ctx.mergeFailed) paintStreamText(body, ctx.mergeMsg.content); });
      }
      else if (ev.type === 'done' && ev.usage) {
        // 综合也是真实请求，占用量要一并记下并显示，否则统计会漏掉这一项
        ctx.mergeMsg.usage = ev.usage;
        status.innerHTML = '<span class="badge ok">完成</span>' + usageBadge(ev.usage, { modelId: ctx.mergeMsg.modelId });
      }
      else if (ev.type === 'error') {
        if (/已停止/.test(ev.message || '')) {
          // 停止与普通回答口径一致：保留已生成的半份报告并标“已停止”，不整份回滚
          //（模型综合一次几十秒，误停全丢太伤）；重出完整版用「重新综合」
          ctx.mergeMsg.stopped = true;
          if (ev.usage) ctx.mergeMsg.usage = ev.usage;
          ctx.mergeMsg.content += '\n\n（已停止，内容不完整，可点「重新综合」重出完整版）';
          status.innerHTML = '<span class="badge muted">已停止</span>' + usageBadge(ctx.mergeMsg.usage, { modelId: ctx.mergeMsg.modelId });
        } else {
          // 综合失败：回滚 merge 状态，允许用户再次点击“综合回答”
          ctx.mergeFailed = true; // 标记失败，随后的 all-done 不能把状态改回“完成”
          ctx.mergeMsg.content += '\n\n（综合失败：' + ev.message + '）';
          status.innerHTML = '<span class="badge err">失败</span>';
        }
        if (ctx.am) {
          if (!ctx.mergeMsg.stopped) ctx.am.merge = null;
          syncMergeToVersion(ctx.am);
          const oldTools = byRound('.round-tools', ctx.roundId, wrap);
          if (oldTools) oldTools.replaceWith(roundTools(ctx.am, true));
        }
        addMergeRetryBtn(status && status.closest('.merge-card'), ctx.roundId);
      }
      return;
    }

    if (!ev.modelId) return;
    const res = ctx.assistantMsg.results.find(r => r.modelId === ev.modelId);
    // 用建卡时缓存的节点引用，避免每个 delta 都遍历/查询 DOM
    const refs = ctx.cards && ctx.cards.get(ev.modelId);
    if (!res || !refs) return;
    const card = refs.card;
    const status = refs.status;
    const body = refs.body;

    if (ev.type === 'start') {
      status.innerHTML = '<span class="spinner"></span> 生成中…';
    } else if (ev.type === 'delta') {
      res.content = U.stripEmoji(res.content + ev.text);
      // 绘制前检查状态：error/done 事件可能在同一帧内先到，
      // 不能让排队的旧绘制把错误信息/渲染结果覆盖回纯文本
      scheduleStreamPaint(body, function () { if (res.status === 'streaming') paintStreamText(body, res.content); });
    } else if (ev.type === 'reasoning') {
      res.reasoning = U.stripEmoji((res.reasoning || '') + ev.text);
      if (!refs.reasoning) {
        let det = card.querySelector('details.reasoning');
        if (!det) {
          det = U.el('details', { class: 'reasoning' },
            U.el('summary', {}, '查看思考过程'),
            U.el('div', { class: 'r-body' }));
          card.insertBefore(det, body);
        }
        refs.reasoning = det.querySelector('.r-body');
      }
      // 与正文一样按帧合帧：长思考链下每个 delta 全量重写 textContent 是 O(n²)
      const rBody = refs.reasoning;
      if (rBody) scheduleStreamPaint(rBody, function () { if (res.status === 'streaming') paintStreamText(rBody, res.reasoning); });
    } else if (ev.type === 'sources') {
      // 模型原生联网的引用注回（OpenRouter/OpenAI 的 url_citation 等）：
      // 并入该回答的来源列表（按 url 去重），卡片上补来源区
      const list = (ev.sources || []).filter(s => s && s.url && !(res.sources || []).some(x => x.url === s.url));
      if (list.length) {
        res.sources = (res.sources || []).concat(list);
        refreshSourcesRow(card, res);
      }
    } else if (ev.type === 'done') {
      res.status = 'done'; res.ms = ev.ms; res.chars = ev.chars;
      if (ev.usage) res.usage = ev.usage; // token 用量（服务端回传，无则不显示）
      // 终止原因：length=被 max_tokens 截断、content_filter=被内容安全拦截——
      // 不标记的话用户会把截断/拦截的回答当成完整回答（C5）
      if (ev.finish) res.finish = ev.finish;
      status.innerHTML = statusHtml(res);
      body.classList.remove('streaming');
      body.classList.add('md');
      body.innerHTML = mdHtml(res, res.content);
    } else if (ev.type === 'error') {
      if (/已停止/.test(ev.message)) { res.status = 'stopped'; res.content = res.content || ''; }
      else { res.status = 'error'; res.error = ev.message; }
      res.ms = ev.ms || 0; // 已停止/失败也要显示已耗时多久（与成功卡同款徽标）
      // 已停止的回答也可能带出部分用量，一起存下来
      if (ev.usage) res.usage = ev.usage;
      body.classList.remove('streaming');
      if (res.status === 'error') {
        body.innerHTML = '<div class="ac-error">失败：' + U.esc(U.stripEmoji(ev.message)) + '</div>';
      } else if (res.content) {
        body.classList.add('md');
        body.innerHTML = mdHtml(res, res.content);
      }
      status.innerHTML = statusHtml(res);
      // 失败/被停止的卡片当场补上「重试」：不补的话入口要等下一次整页重绘才出现
      addAnswerRetryBtn(card, ctx.assistantMsg.roundId, res.modelId);
    }
  }

  // 失败/停止后在答案卡片上补「重试」按钮（只重发这一个模型，不重跑整轮）。
  // 与 addMergeRetryBtn 同一套路：error 事件到达时卡片早已建好，answerCard 建卡时
  // 的按钮判定只对"建卡即失败"的历史数据生效
  function addAnswerRetryBtn(card, roundId, modelId) {
    if (!card || !roundId) return;
    const foot = card.querySelector('.card-foot');
    if (!foot || foot.querySelector('.ac-retry')) return;
    foot.insertBefore(U.el('button', {
      class: 'ac-copy ac-retry',
      title: '只重新调用这一个模型',
      onclick: function () { retryOne(roundId, modelId); }
    }, '重试'), foot.firstChild);
  }

  function stopAll() {
    for (const id of Array.from(pending.keys())) {
      // 停止失败不应变成未处理的 Promise 拒绝
      Promise.resolve(api.stop(id)).catch(function () { });
    }
    // 搜索阶段尚无 pending 可中止：中止搜索请求本身，并立即复位、让令牌失效，
    // dispatchRound 在搜索返回后检测到即退出
    if (curSearchId) {
      Promise.resolve(api.stop(curSearchId)).catch(function () { });
      curSearchId = null;
    }
    streaming = null;
    runToken++;
    setSendBtn(false);
    MM.sessions.render(); // 摘掉会话列表上的"生成中"呼吸点
  }

  // 停止指定会话的在途请求（删除会话时调用；含仍在搜索阶段的轮次）
  function stopSession(sessionId) {
    for (const [reqId, ctx] of Array.from(pending.entries())) {
      if (ctx.session && ctx.session.id === sessionId) {
        pending.delete(reqId);
        Promise.resolve(api.stop(reqId)).catch(function () { });
      }
    }
    // 搜索阶段没有 pending 条目：按所属会话中止（否则删会话后搜索在主进程空跑到超时）
    if (curSearchId && curSearchSessionId === sessionId) {
      Promise.resolve(api.stop(curSearchId)).catch(function () { });
      curSearchId = null;
      curSearchSessionId = null;
    }
    if (streaming === sessionId) {
      streaming = null;
      runToken++;
      setSendBtn(false);
    }
  }

  // ---------- 重新生成 ----------
  // 没有回答的提问（搜索阶段被停止）用这个临时工具栏重发；回答开始后工具栏会被移除
  function userRetryTools(msg) {
    return U.el('div', { class: 'round-tools retry-only anim-in' },
      U.el('button', { class: 'tool-btn', onclick: function () { retryUser(msg); } },
        U.el('span', { class: 'ico', html: U.svgIcon('redo', 11) }), '重新生成'));
  }

  async function retryUser(userMsg) {
    if (streaming || sendLock) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.indexOf(userMsg);
    if (idx < 0) return;
    // 只允许对"最后一条消息"重发：否则后面的新对话会被 splice 掉
    if (idx !== s.messages.length - 1) {
      U.toast('该提问后面已有新内容，请刷新后重试', true);
      renderAll();
      return;
    }
    const models = selectedModels();
    if (!models.length) { U.toast('请先选择模型', true); return; }
    // 正常情况下该提问就是最后一条；若后面还有残留消息，一并清掉避免重复
    s.messages.splice(idx + 1);
    for (const t of Array.from(document.querySelectorAll('.round-tools.retry-only'))) t.remove();
    s.updatedAt = Date.now();
    MM.save();
    streaming = s.id;
    setSendBtn(true);
    dispatchRound(s, userMsg, models, U.$('#tgl-search').checked, false)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

  async function retryRound(roundId) {
    if (streaming || sendLock) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg || userMsg.role !== 'user') return;
    const models = selectedModels();
    if (!models.length) { U.toast('请先选择模型', true); return; }
    // 当前显示版本存入历史版本池，由新一轮继承（不删除，可随时切换/回滚）
    const versions = inheritVersionsOf(am);
    // 仅移除该轮的助手回答及其后的综合消息（遇到下一条用户消息即停，不能波及更后面的轮次）
    let end = idx;
    while (end < s.messages.length && s.messages[end].role !== 'user') end++;
    s.messages.splice(idx, end - idx);
    s.updatedAt = Date.now();
    MM.save();
    renderAll();
    // 立即锁定状态（防搜索 await 期间重复触发）
    streaming = s.id;
    setSendBtn(true);
    // 联网条件与单模型重试（retryOne）同口径：本轮记录过 searchOn 就用它——
    // 原生搜索没有 sources 存档，用当前开关会让重新生成悄悄丢掉/多出联网
    const searchOn = am.searchOn === undefined ? !!userMsg.sources : !!am.searchOn;
    dispatchRound(s, userMsg, models, searchOn, false, versions, am.prunedTokens || 0)
      .catch(e => { streaming = null; setSendBtn(false); U.toast('请求失败：' + e.message, true); });
  }

  // ---------- 单模型重试 ----------
  // 只重发失败/被停止的那一个模型，结果原位更新：已成功的模型不用再花钱重跑。
  // 历史按当前会话状态重建（与 dispatchRound 同一来源），搜索结果沿用该轮已保存的来源。
  async function retryOne(roundId, modelId) {
    if (streaming || sendLock) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg || userMsg.role !== 'user') return;
    const res = (am.results || []).find(r => r.modelId === modelId);
    if (!res) return;
    if (res.status === 'streaming') return;
    const flat = MM.settings.allFlatModels().find(m => m.id === modelId);
    if (!flat) { U.toast('该模型已被删除或停用，无法重试', true); return; }

    // 重置该条结果并原位替换为流式卡片（事件按 modelId 找卡片，ctx.grid 直接指向现有网格）
    res.status = 'streaming'; res.content = ''; res.reasoning = '';
    delete res.error; delete res.ms; delete res.chars; delete res.usage; delete res.finish;
    const searchOn = am.searchOn === undefined ? !!userMsg.sources : !!am.searchOn;
    const searchResults = searchOn && !nativeSearch(flat) ? userMsg.sources || null : null;
    delete res.sources;
    if (searchResults && searchResults.length) res.sources = searchResults;
    MM.save();

    streaming = s.id;
    setSendBtn(true);
    MM.sessions.render(); // 呼吸点：单模型重试同样占用全局生成状态
    const reqId = nextReqId('rt');
    // roundId 可能来自导入数据（含引号等字符），不能拼进 CSS 选择器：用 byRound 逐个比对属性
    const gridEl = byRound('.answers', roundId);
    const old = gridEl && Array.from(gridEl.querySelectorAll('.answer-card'))
      .find(c => c.getAttribute('data-model-id') === modelId);
    // 替换卡片后必须同步重建事件用的节点缓存：handleEvent 按 ctx.cards.get(modelId)
    // 找节点（流式竞态修复后不再走 DOM 查询），漏了这一条重试的流式内容会被静默丢弃
    let fresh = null;
    if (old) {
      fresh = answerCard(res, true, roundId);
      old.replaceWith(fresh);
    }

    const ctxLimit = flat.contextTokens || 0;
    const history = buildHistory(s, userMsg, searchResults, ctxLimit, flat.maxTokens || 4096, flat);
    // 联网条件与原轮保持一致：本轮记录过 searchOn 就用它（百炼/智谱/OpenRouter 的原生
    // 搜索没有 sources 存档，只看 sources 会让重试悄悄丢掉联网）；旧数据回落 sources
    pending.set(reqId, {
      session: s, assistantMsg: am, grid: gridEl, userMsg: userMsg, singleRetry: true, retryModelId: modelId,
      cards: new Map(fresh ? [[modelId, cardRefs(fresh)]] : [])
    });
    if (!fresh) renderAll(); // 网格不在 DOM（理论不可达）：走 live 重建路径重新绑定节点
    scrollBottom(true);
    try {
      await api.send({ requestId: reqId, targets: [{ model: stripModel(flat), messages: history,
        searchOn: searchOn && nativeSearch(flat) }], searchOn: false });
    } catch (e) {
      pending.delete(reqId);
      streaming = null; setSendBtn(false);
      res.status = 'error'; res.error = e.message;
      MM.save(); renderAll();
      U.toast('重试失败：' + e.message, true);
    }
  }
  // ---------- 综合回答 ----------
  // 上一轮问答背景：追问轮的提问往往单独看不懂（“那第二种方案呢”）。
  // 优先带上一轮的综合回答（紧凑且已过滤寒暄），没有就只带上一轮提问本身。
  // 轮次结构固定为 [user, assistant] 交替：本轮 assistant 在 idx，上一轮在 idx-2、user 在 idx-3。
  function prevRoundContext(s, idx) {
    if (idx < 3) return null;
    const prevUser = s.messages[idx - 3], prevAsst = s.messages[idx - 2];
    if (!prevUser || prevUser.role !== 'user' || !prevAsst || prevAsst.role !== 'assistant') return null;
    return {
      question: String(prevUser.content || ''),
      synthesis: prevAsst.merge && prevAsst.merge.content ? String(prevAsst.merge.content) : ''
    };
  }

  async function doMerge(roundId, opts) {
    opts = opts || {};
    if (streaming || sendLock) { U.toast('请等待当前任务完成', true); return; }
    // 轮次可能属于后台会话：自动综合在 all-done 时触发，此刻用户也许已切到别的会话。
    // 只查当前会话会让后台完成的轮次永远不综合——按 roundId 全局定位所属会话。
    let s = MM.sessions.current();
    let idx = s ? s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId) : -1;
    if (idx < 0) {
      for (const cand of MM.state.sessions) {
        if (!cand || !Array.isArray(cand.messages) || cand === s) continue;
        const j = cand.messages.findIndex(m => m && m.role === 'assistant' && m.roundId === roundId);
        if (j >= 0) { s = cand; idx = j; break; }
      }
    }
    if (idx < 0 || !s) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg) return;
    if (am.merge && am.merge.content) {
      if (!opts.redo) { U.toast('该轮已有综合回答，可点「重新综合」覆盖', true); return; }
      const okc = await U.confirm({
        title: '重新综合',
        message: '将用当前设置重新生成综合回答，覆盖现有的这一份。旧综合保留在版本历史中，可随时切回。',
        okText: '重新综合'
      });
      if (!okc) return;
      // 当前内容先存为新版本快照：重综合完成后写入最新快照，旧综合留在上一份里可回滚。
      // 副本打 inherited 标记：结果与上一份快照是同一批请求，sessionTokens 不重复计结果用量
      //（入池必须无条件——若因「与上一份相同」跳过，下面的 syncMergeToVersion 会把
      // 新综合直接覆盖进唯一那份快照，旧综合就丢了）
      if (hasUsefulResults(am.results)) {
        am.versions = am.versions || [];
        const snap = snapshotOf(am);
        snap.inherited = true;
        am.versions.push(snap);
        if (am.versions.length > 10) {
          am.prunedTokens = (am.prunedTokens || 0) + prunedTokensOf(am.versions.splice(0, am.versions.length - 10));
        }
        am.active = am.versions.length - 1;
      }
    }
    const okResults = (am.results || [])
      .filter(r => (r.status === 'done' || r.status === 'stopped') && r.content)
      .map(r => ({ modelId: r.modelId, name: r.name, content: r.content, sources: r.sources }));
    if (!okResults.length) { U.toast('没有可合并的成功回答', true); return; }

    const cfg = MM.state.config.synthesis || {};
    const source = cfg.synthSource || 'frontend';

    // 综合回答挂在轮次上（不再作为独立消息），并同步进当前版本快照
    am.merge = { content: '', mode: source === 'frontend' ? 'frontend' : 'model', createdAt: Date.now() };
    s.updatedAt = Date.now();
    // 前端合并是同步完成的，直接等下面的最终保存即可；只有模型综合需要先落盘占位
    if (source !== 'frontend') MM.save();

    // 渲染实时卡片（先清掉该轮此前失败留下的综合卡片，避免重复堆叠）
    const wrap = U.$('#messages');
    const card = mergeCard(am.merge, true, roundId);
    card.classList.add('anim-in');
    // 卡片只在正查看该会话时挂进 DOM；后台会话时保持游离——流式内容照常写进
    // mergeMsg（数据），切回该会话时 renderAll 会经 live 上下文重建卡片与绑定
    if (MM.sessions.current() === s) {
      const staleCard = byRound('.merge-card', roundId, wrap);
      if (staleCard) staleCard.remove();
      const oldTools = byRound('.round-tools', roundId, wrap);
      if (oldTools) oldTools.replaceWith(roundTools(am, true));
      // 插到本轮回答网格之后（而不是消息列表末尾），旧轮次综合时不会跑到页面最下面
      const gridEl = byRound('.answers', roundId, wrap);
      if (gridEl) gridEl.after(card); else wrap.appendChild(card);
      scrollBottom(true);
    }

    if (source === 'frontend') {
      am.merge.content = MM.merge.frontend(okResults);
      syncMergeToVersion(am);
      finalizeMergeCard({ mergeMsg: am.merge, mergeBody: card.querySelector('.ac-body'), mergeStatus: card.querySelector('.ac-status'), am: am, roundId: roundId });
      MM.save();
      return;
    }

    // 模型二次综合
    const flats = MM.settings.allFlatModels();
    let model = flats.find(m => m.id === source);
    if (!model) model = flats[0];
    if (!model) {
      am.merge.content = '（未找到可用的综合模型，请在设置中配置）';
      syncMergeToVersion(am);
      finalizeMergeCard({ mergeMsg: am.merge, mergeBody: card.querySelector('.ac-body'), mergeStatus: card.querySelector('.ac-status'), am: am, roundId: roundId });
      MM.save();
      return;
    }
    // 模型归因：用量统计面板按模型拆分时综合回答要能落到具体模型（旧数据没有此字段，显示"未记录"）。
    // modelId 用 flat id（providerId::modelId），与回答行的口径一致，否则同一模型被拆成两个系列
    am.merge.modelId = model.id || model.modelId || '';
    am.merge.modelName = model.name || model.modelId || '';
    streaming = s.id;
    if (MM.sessions.current() === s) setSendBtn(true); // 后台会话综合：不能锁当前视图的输入框
    MM.sessions.render(); // 呼吸点
    const t0 = Date.now();
    const reqId = nextReqId('syn');
    // 综合也是一次真实提问：系统提示词同样要带上，否则综合结果会丢掉角色设定
    const sys = effectiveSystemPrompt(s);
    // 按综合模型的上下文给提示词设 token 上限，避免多份长回答顶爆上下文；
    // 系统提示词同样占上下文，一并扣掉
    const promptBudget = Math.max(512, (model.contextTokens || 32768) - (model.maxTokens || 4096) - 2048
      - (sys ? MM.merge.tokensOf(sys) : 0));
    const prompt = MM.merge.synthesisPrompt(userMsg.content, okResults, promptBudget, prevRoundContext(s, idx));
    const synthMsgs = [];
    if (sys) synthMsgs.push({ role: 'system', content: sys });
    synthMsgs.push({ role: 'user', content: prompt });
    pending.set(reqId, {
      mergeMsg: am.merge,
      mergeBody: card.querySelector('.ac-body'),
      mergeStatus: card.querySelector('.ac-status'),
      session: s,
      am: am,
      roundId: roundId
    });
    try {
      await api.synthesize({ requestId: reqId, model: stripModel(model), messages: synthMsgs });
    } catch (e) {
      pending.delete(reqId);
      streaming = null;
      setSendBtn(false);
      U.toast('综合失败：' + e.message, true);
      // 回滚 merge 状态并恢复工具栏，允许再次综合
      if (am) {
        am.merge = null;
        syncMergeToVersion(am);
      }
      const oldTools = byRound('.round-tools', roundId, wrap);
      if (oldTools) oldTools.replaceWith(roundTools(am, true));
      const body = card && card.querySelector('.ac-body'), st = card && card.querySelector('.ac-status');
      if (body) { body.classList.remove('streaming'); body.innerHTML = '<div class="ac-error">失败：' + U.esc(U.stripEmoji(e.message)) + '</div>'; }
      if (st) st.innerHTML = '<span class="badge err">失败</span>';
      addMergeRetryBtn(card, roundId);
    }
  }

  // 把综合回答同步进当前版本快照
  function syncMergeToVersion(am) {
    if (am && Array.isArray(am.versions) && am.versions.length) {
      const i = am.active >= 0 ? am.active : am.versions.length - 1;
      const copy = am.merge ? JSON.parse(JSON.stringify(am.merge)) : null;
      if (copy && copy.deco) delete copy.deco; // 版本池不带装饰缓存（与 snapshotOf 同口径）
      am.versions[i].merge = copy;
    }
  }

  // 综合失败/停止后在卡片角落补一个「重试」，免去到工具栏找入口
  //（失败时 merge 已回滚，redo 无副作用；停止时保留半成品，走「重新综合」确认覆盖）
  function addMergeRetryBtn(card, roundId) {
    if (!card) return;
    const foot = card.querySelector('.card-foot');
    if (!foot || foot.querySelector('.ac-retry')) return;
    foot.insertBefore(U.el('button', {
      class: 'ac-copy ac-retry',
      onclick: function () { doMerge(roundId, { redo: true }); }
    }, '重试'), foot.firstChild);
  }

  function finalizeMergeCard(ctx, failed) {
    const body = ctx.mergeBody, status = ctx.mergeStatus;
    // 作废还在排队的流式绘制：最后一条 delta 与 all-done 同帧到达时，
    // rAF 里的旧回调会把刚写入的 Markdown 整体覆盖回裸文本（与审查条目同源竞态）
    body._paint = null;
    body.classList.remove('streaming');
    body.classList.add('md');
    body.innerHTML = MM.md.render(ctx.mergeMsg.content || '（空）');
    // 综合完成：渲染来源角标与分歧/待验证小节标识（前端合并同样生效）
    decorateMergeSources(body, ctx.mergeMsg, ctx.am && ctx.am.results, ctx.roundId);
    // 失败/已停止时保留失败标记，不能被覆盖成完成状态；
    // 综合请求的 token 用量一并显示（用量存在 mergeMsg 上，会随版本快照一起保留）
    const mu = ctx.mergeMsg.usage;
    const mBadge = { modelId: ctx.mergeMsg.modelId };
    if (failed) status.innerHTML = '<span class="badge err">失败</span>' + usageBadge(mu, mBadge);
    else if (ctx.mergeMsg.stopped) status.innerHTML = '<span class="badge muted">已停止</span>' + usageBadge(mu, mBadge);
    else status.innerHTML = '<span class="badge ok">' + (ctx.mergeMsg.mode === 'model' ? '完成' : '已合并') + '</span>' + usageBadge(mu, mBadge);
    // 恢复工具栏（综合回答入口随 am.merge 状态更新）
    const wrap = U.$('#messages');
    const grid = byRound('.answers', ctx.roundId, wrap);
    const mergeEl = byRound('.merge-card', ctx.roundId, wrap);
    const oldTools = byRound('.round-tools', ctx.roundId, wrap);
    if (oldTools) oldTools.remove();
    // 与 renderAll 的顺序保持一致：回答网格 → 综合卡片 → 工具栏
    const anchor = mergeEl || grid;
    if (anchor && ctx.am) anchor.after(roundTools(ctx.am, true));
  }

  // ---------- 交叉审查（阶段一复用本轮回答；阶段二互审；阶段三仲裁） ----------
  // 汇总口径与 usageBadge 的契约一致：返回 {input, output} 对象（徽标的悬浮分解也要用），
  // 不能返回预求和的数字——usageBadge 对数字取 .input 得 undefined，徽标会永远不显示
  function reviewUsage(review) {
    let input = 0, output = 0, any = false;
    const add = u => {
      if (u && (u.input || u.output)) { any = true; input += u.input || 0; output += u.output || 0; }
    };
    for (const it of (review.items || [])) add(it.usage);
    if (review.verdict) add(review.verdict.usage);
    return any ? { input: input, output: output } : null;
  }
  // 交叉审查卡片的花费合计：互审的各模型 + 仲裁模型，按各自单价分别解析再求和；
  // 一个单价已知的都没有就返回 null（徽标不显示金额）
  function reviewCost(review) {
    let sum = 0, any = false;
    const add = (u, mid) => {
      const c = MM.costOf ? MM.costOf(mid, u) : null;
      if (c != null) { any = true; sum += c; }
    };
    for (const it of (review.items || [])) add(it.usage, it.modelId);
    if (review.verdict) add(review.verdict.usage, review.verdict.modelId);
    return any ? sum : null;
  }
  function reviewHasContent(review) {
    return !!review && (!!review.verdict || (review.items || []).some(i => i.content));
  }

  function reviewProgress(review) {
    const items = (review && review.items) || [];
    const completed = items.filter(i => i && i.status === 'done').length;
    const failed = items.filter(i => i && i.status === 'error').length;
    const stopped = items.filter(i => i && i.status === 'stopped').length;
    return { completed, total: items.length, failed, stopped, settled: completed + failed + stopped };
  }

  function reviewStatusHtml(review, failed) {
    const v = review.verdict;
    const p = reviewProgress(review);
    let cls = 'ok', text = '完成';
    if (failed || (v && (v.error || v.failed)) || (!v && !review.stopped)) { cls = 'err'; text = '失败'; }
    else if ((v && v.stopped) || (!v && review.stopped)) {
      cls = 'muted'; text = p.completed < p.total ? '部分完成 · 已停止' : '已停止';
    } else if (p.completed < p.total) { cls = 'warn'; text = '部分完成 ' + p.completed + '/' + p.total; }
    return '<span class="badge ' + cls + '" title="成功 ' + p.completed + ' · 失败 ' + p.failed + ' · 停止 ' + p.stopped + '">' +
      text + '</span>' + usageBadge(reviewUsage(review), { cost: reviewCost(review) });
  }

  // ---------- 审查版本化（③） ----------
  // am.reviews 数组（旧→新），am.reviewActive 指当前展示份；上限 REVIEW_CAP 份，
  // 裁剪时旧审查用量折进 am.prunedTokens（统计总量不断账）。切换只换显示（档案
  // 语义，与综合版本切换同款交互），不影响综合回答与后续轮。
  // 写入端只新增不覆盖：「重新审查」= 新增一份记录（旧数据 m.review 由 normalizeSessions 迁移）
  const REVIEW_CAP = 5;
  function activeReviewOf(am) {
    if (!Array.isArray(am.reviews) || !am.reviews.length) return null;
    const i = (typeof am.reviewActive === 'number' && am.reviewActive >= 0 && am.reviewActive < am.reviews.length)
      ? am.reviewActive : am.reviews.length - 1;
    return am.reviews[i] || null;
  }
  function hasAnyReview(am) {
    return (am.reviews || []).some(rv => reviewHasContent(rv)) || reviewHasContent(am.review);
  }
  // 被裁剪审查的真实用量合计（与 prunedTokensOf 同口径：input+output）
  function droppedReviewTokens(reviews) {
    let sum = 0;
    const add = u => { if (u) sum += (u.input || 0) + (u.output || 0); };
    for (const rv of (reviews || [])) {
      for (const it of (rv.items || [])) if (it) add(it.usage);
      if (rv.verdict) add(rv.verdict.usage);
    }
    return sum;
  }

  // phase：2=互审进行中 3=仲裁进行中 null=已完成/历史重绘；am 用于审查历史切换（③）
  function reviewCard(review, live, roundId, results, phase, am) {
    const card = U.el('div', { class: 'review-card', 'data-role': 'review', 'data-round': roundId || '' });
    const rStatus = U.el('span', { class: 'ac-status' });
    const headKids = [U.el('span', { class: 'ac-name' }, '交叉审查')];
    // 审查历史切换：多于一份时出现，与综合版本切换同款交互；只换显示不影响数据
    if (am && Array.isArray(am.reviews) && am.reviews.length > 1) {
      const idx = (typeof am.reviewActive === 'number' && am.reviewActive >= 0 && am.reviewActive < am.reviews.length)
        ? am.reviewActive : am.reviews.length - 1;
      const go = d => function () {
        if (streaming) { U.toast('请等待当前任务完成', true); return; }
        const ni = Math.max(0, Math.min(am.reviews.length - 1, idx + d));
        if (ni === idx) return;
        am.reviewActive = ni;
        renderAll();
      };
      headKids.push(U.el('button', { class: 'tool-btn', title: '上一次审查', html: U.svgIcon('left', 9), onclick: go(-1), disabled: idx <= 0 }));
      headKids.push(U.el('span', { class: 'ver-label' }, '审查 ' + (idx + 1) + '/' + am.reviews.length));
      headKids.push(U.el('button', { class: 'tool-btn', title: '下一次审查', html: U.svgIcon('right', 9), onclick: go(1), disabled: idx >= am.reviews.length - 1 }));
    }
    card.appendChild(U.el('div', { class: 'ac-head' }, headKids.concat([rStatus])));
    const body = U.el('div', { class: 'ac-body' });
    card.appendChild(body);
    const findings = U.el('div', { class: 'rv-findings' });
    for (const it of (review.items || [])) {
      const iStatus = U.el('span', { class: 'ac-status' });
      const streamingNow = live && phase === 2 && it.status === 'streaming';
      if (streamingNow) iStatus.innerHTML = '<span class="spinner"></span>';
      else if (it.status === 'done') iStatus.innerHTML = '<span class="badge ok">完成</span>';
      else if (it.status === 'stopped') iStatus.innerHTML = '<span class="badge muted">已停止</span>';
      else if (it.status === 'error') iStatus.innerHTML = '<span class="badge err">失败</span>';
      const iBody = U.el('div', { class: 'rv-item-body' + (streamingNow ? ' streaming' : it.content ? ' md' : '') });
      if (streamingNow) iBody.textContent = U.stripEmoji(it.content || '');
      else if (it.content) iBody.innerHTML = MM.md.render(it.content);
      else if (it.status === 'error') iBody.innerHTML = '<span style="color:var(--danger)">' + U.esc(U.stripEmoji(it.error || '失败')) + '</span>';
      findings.appendChild(U.el('div', { class: 'rv-item', 'data-model-id': it.modelId },
        U.el('div', { class: 'rv-item-head' },
          U.el('span', { class: 'ac-dot', style: 'background:' + MM.settings.dotColor(it.modelId) }),
          U.el('span', { class: 'rv-item-name' }, it.name || it.modelId),
          iStatus),
        iBody));
    }
    body.appendChild(findings);
    if (review.verdict) {
      const v = review.verdict;
      const vBody = U.el('div', { class: 'rv-verdict-body' + (live && phase === 3 ? ' streaming' : ' md') });
      if (live && phase === 3) vBody.textContent = U.stripEmoji(v.content || '');
      else vBody.innerHTML = MM.md.render(v.content || '（空）');
      body.appendChild(U.el('div', { class: 'rv-verdict' },
        U.el('div', { class: 'rv-verdict-head' },
          U.el('span', { class: 'rv-sec-title' }, '仲裁结论'),
          U.el('span', { class: 'ac-status' })),
        vBody));
    }
    // 卡片头部状态
    if (live) rStatus.innerHTML = '<span class="spinner"></span> ' + (phase === 3 ? '仲裁中…' : '互审中…');
    else rStatus.innerHTML = reviewStatusHtml(review);
    card.appendChild(U.el('div', { class: 'card-foot' },
      U.el('button', { class: 'ac-copy', onclick: function () { U.copyTextFrom(body); U.toast('已复制'); } }, '复制')));
    MM.md.bindCopy(card);
    // 历史重绘：仲裁结论渲染来源角标与数值溯源（复用综合回答的后校验，空闲时段补）
    if (!live && review.verdict && review.verdict.content) {
      decorateMergeSourcesDeferred(card.querySelector('.rv-verdict-body'), review.verdict, results, roundId);
    }
    return card;
  }

  function reviewRefsOf(card) {
    const items = new Map();
    for (const el of Array.from(card.querySelectorAll('.rv-item'))) {
      items.set(el.getAttribute('data-model-id'), {
        status: el.querySelector('.ac-status'),
        body: el.querySelector('.rv-item-body')
      });
    }
    const vEl = card.querySelector('.rv-verdict');
    return {
      items: items,
      headStatus: card.querySelector('.ac-head .ac-status'),
      verdict: vEl ? { status: vEl.querySelector('.ac-status'), body: vEl.querySelector('.rv-verdict-body') } : null
    };
  }

  // 仲裁块在阶段三开始时才创建（阶段二的卡片上还没有这块）
  function ensureVerdictBlock(card) {
    let v = card.querySelector('.rv-verdict');
    if (v) return v;
    const body = card.querySelector('.ac-body');
    v = U.el('div', { class: 'rv-verdict' },
      U.el('div', { class: 'rv-verdict-head' },
        U.el('span', { class: 'rv-sec-title' }, '仲裁结论'),
        U.el('span', { class: 'ac-status' })),
      U.el('div', { class: 'rv-verdict-body streaming' }));
    body.appendChild(v);
    return v;
  }

  // 审查失败/停止后在卡片角落补「重试」（与综合卡片的重试同款）
  function addReviewRetryBtn(card, roundId) {
    if (!card) return;
    const foot = card.querySelector('.card-foot');
    if (!foot || foot.querySelector('.ac-retry')) return;
    foot.insertBefore(U.el('button', {
      class: 'ac-copy ac-retry',
      onclick: function () { doReview(roundId, { redo: true }); }
    }, '重试'), foot.firstChild);
  }

  function updateReviewHeadStatus(ctx) {
    const refs = ctx.rvRefs;
    if (!refs || ctx.reviewPhase !== 2) return;
    const p = reviewProgress(ctx.review);
    refs.headStatus.innerHTML = '<span class="spinner"></span> 互审中 ' + p.settled + '/' + p.total + '…' +
      (p.failed ? '（失败 ' + p.failed + '）' : '');
  }

  function finalizeReviewCard(ctx, failed) {
    const review = ctx.review || activeReviewOf(ctx.am || {});
    const card = ctx.rvCard;
    if (card && card.isConnected && ctx.rvRefs) {
      const v = review.verdict;
      const vr = ctx.rvRefs.verdict;
      if (v && vr) {
        // 终态落 Markdown：作废排队中的流式绘制，否则 RAF 会在本赋值之后用
        // textContent 把渲染好的 HTML 覆盖回裸文本（实测必现）
        vr.body._paint = null;
        vr.body.classList.remove('streaming');
        vr.body.classList.add('md');
        vr.body.innerHTML = MM.md.render(v.content || '（空）');
        decorateMergeSources(vr.body, v, ctx.am.results, ctx.roundId);
      }
      ctx.rvRefs.headStatus.innerHTML = reviewStatusHtml(review, failed);
      if (failed || review.stopped || (v && (v.stopped || v.error || v.failed)) || reviewProgress(review).completed < reviewProgress(review).total) {
        addReviewRetryBtn(card, ctx.roundId);
      }
    }
    // 恢复工具栏（交叉审查入口随 am.review 状态更新）
    const wrap = U.$('#messages');
    const oldTools = byRound('.round-tools', ctx.roundId, wrap);
    if (oldTools && ctx.am) oldTools.replaceWith(roundTools(ctx.am, true));
  }

  async function doReview(roundId, opts) {
    opts = opts || {};
    if (streaming || sendLock) { U.toast('请等待当前任务完成', true); return; }
    // 轮次可能属于后台会话：按 roundId 全局定位（与 doMerge 同款）
    let s = MM.sessions.current();
    let idx = s ? s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId) : -1;
    if (idx < 0) {
      for (const cand of MM.state.sessions) {
        if (!cand || !Array.isArray(cand.messages) || cand === s) continue;
        const j = cand.messages.findIndex(m => m && m.role === 'assistant' && m.roundId === roundId);
        if (j >= 0) { s = cand; idx = j; break; }
      }
    }
    if (idx < 0 || !s) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    if (!userMsg) return;
    const okResults = (am.results || [])
      .filter(r => (r.status === 'done' || r.status === 'stopped') && r.content)
      .map(r => ({ modelId: r.modelId, name: r.name, content: r.content }));
    if (okResults.length < 2) { U.toast('交叉审查至少需要两份成功回答', true); return; }
    const sourceMap = new Map();
    for (const result of (am.results || [])) {
      for (const source of (result && result.sources) || []) {
        if (source && source.url && !sourceMap.has(source.url)) sourceMap.set(source.url, source);
      }
    }
    const reviewSources = Array.from(sourceMap.values()).slice(0, 8);
    if (hasAnyReview(am)) {
      if (!opts.redo) { U.toast('该轮已有审查记录，可点「重新审查」新增一份', true); return; }
      const okc = await U.confirm({
        title: '重新审查',
        message: '将用当前设置再进行一次交叉审查，新增一份记录（历史保留，最多 5 份，最旧自动让位）。',
        okText: '重新审查'
      });
      if (!okc) return;
    }
    const flats = MM.settings.allFlatModels();
    // 审查者 = 本轮给出成功回答的模型（模型配置里已删除的跳过）；i 是全局编号，供
    // reviewPrompt 剔除自身回答并让【回答 N】在审查与仲裁提示词间编号一致
    const reviewers = okResults.map((r, i) => ({ r: r, i: i, model: flats.find(m => m.id === r.modelId) }))
      .filter(x => x.model);
    if (reviewers.length < 2) { U.toast('找不到可用的审查模型（模型配置可能已变化）', true); return; }
    const cfg = MM.state.config.synthesis || {};
    // 仲裁模型：综合设置里选定的模型优先；未选（前端合并）或已被删除时，
    // 用本轮第一位回答者的模型兜底——flats[0] 可能是没配密钥的预置服务商，必然失败
    const arbiter = (cfg.synthSource && flats.find(m => m.id === cfg.synthSource)) || reviewers[0].model;

    am.reviews = Array.isArray(am.reviews) ? am.reviews : [];
    const review = {
      items: reviewers.map(x => ({ modelId: x.r.modelId, name: x.r.name, status: 'pending', content: '', usage: null, ms: 0 })),
      verdict: null, stopped: false, createdAt: Date.now()
    };
    am.reviews.push(review);
    if (am.reviews.length > REVIEW_CAP) {
      // 超出上限的旧审查退出历史：其真实用量折进 prunedTokens，统计总量不断账
      const dropped = am.reviews.splice(0, am.reviews.length - REVIEW_CAP);
      am.prunedTokens = (am.prunedTokens || 0) + droppedReviewTokens(dropped);
    }
    am.reviewActive = am.reviews.length - 1;
    s.updatedAt = Date.now();
    MM.save();

    // 渲染实时卡片（插到综合卡片之后，没有综合卡就插到回答网格之后）
    const wrap = U.$('#messages');
    const card = reviewCard(review, true, roundId, am.results, 2, am);
    card.classList.add('anim-in');
    const inView = MM.sessions.current() === s;
    if (inView) {
      const staleCard = byRound('.review-card', roundId, wrap);
      if (staleCard) staleCard.remove();
      const oldTools = byRound('.round-tools', roundId, wrap);
      if (oldTools) oldTools.replaceWith(roundTools(am, true));
      const mergeEl = byRound('.merge-card', roundId, wrap);
      const gridEl = byRound('.answers', roundId, wrap);
      if (mergeEl) mergeEl.after(card); else if (gridEl) gridEl.after(card); else wrap.appendChild(card);
      scrollBottom(true);
    }
    streaming = s.id;
    if (inView) setSendBtn(true);
    MM.sessions.render(); // 呼吸点

    const sys = effectiveSystemPrompt(s);
    const targets = reviewers.map(x => {
      const budget = Math.max(512, (x.model.contextTokens || 32768) - (x.model.maxTokens || 4096) - 2048
        - (sys ? MM.merge.tokensOf(sys) : 0));
      const prompt = MM.merge.reviewPrompt(userMsg.content, okResults, x.i, budget, reviewSources);
      const msgs = sys ? [{ role: 'system', content: sys }] : [];
      msgs.push({ role: 'user', content: prompt });
      return { model: stripModel(x.model), messages: msgs };
    });
    const reqId = nextReqId('rev');
    pending.set(reqId, {
      reviewCtx: true, reviewPhase: 2, reviewStopped: false,
      session: s, am: am, roundId: roundId, review: review,
      arbiter: arbiter, okResults: okResults, reviewSources: reviewSources, userQuestion: userMsg.content,
      rvCard: inView ? card : null,
      rvRefs: inView ? reviewRefsOf(card) : null
    });
    try {
      await api.send({ requestId: reqId, targets: targets, searchOn: false });
    } catch (e) {
      pending.delete(reqId);
      streaming = null;
      setSendBtn(false);
      U.toast('交叉审查失败：' + e.message, true);
      if (review) {
        for (const it of review.items) if (it.status === 'pending' || it.status === 'streaming') { it.status = 'error'; it.error = e.message; }
      }
      // 请求没能启动：把还空着的审查条目标成失败（有内容的保留半成品），再走统一收尾
      if (card && card.isConnected) {
        for (const el of Array.from(card.querySelectorAll('.rv-item'))) {
          const b = el.querySelector('.rv-item-body');
          if (b && !b.textContent) b.innerHTML = '<span style="color:var(--danger)">请求未能启动</span>';
        }
      }
      finalizeReviewCard({ am: am, review: review, roundId: roundId, rvCard: card, rvRefs: inView ? reviewRefsOf(card) : null }, true);
      MM.save();
    }
  }

  // 阶段事件：delta/done/error 按 reviewPhase 分流（2=按审查条目，3=写进仲裁块）
  function onReviewEvent(ev, ctx) {
    const review = ctx.review;
    if (ctx.reviewPhase === 3) {
      const v = review.verdict;
      if (!v) return;
      const refs = ctx.rvRefs && ctx.rvRefs.verdict;
      if (ev.type === 'start') { if (refs) refs.status.innerHTML = '<span class="spinner"></span>'; }
      else if (ev.type === 'delta') {
        v.content = U.stripEmoji(v.content + ev.text);
        if (refs) scheduleStreamPaint(refs.body, function () { paintStreamText(refs.body, v.content); });
      }
      else if (ev.type === 'done') {
        v.status = 'done'; v.usage = ev.usage || null; v.ms = ev.ms || 0;
        if (refs) refs.status.innerHTML = '<span class="badge ok">完成</span>'; // 仲裁块的 status 在此落终态，否则 spinner 永转
      }
      else if (ev.type === 'error') {
        v.ms = ev.ms || 0;
        if (ev.usage) v.usage = ev.usage;
        if (/已停止/.test(ev.message || '')) {
          v.status = 'stopped'; v.stopped = true;
          v.content += '\n\n（已停止，内容不完整，可点「重新审查」重出完整版）';
          if (refs) refs.status.innerHTML = '<span class="badge muted">已停止</span>';
        } else {
          ctx.verdictFailed = true; v.status = 'error'; v.failed = true; v.error = ev.message || '仲裁失败';
          v.content += '\n\n（仲裁失败：' + ev.message + '）';
          if (refs) refs.status.innerHTML = '<span class="badge err">失败</span>';
        }
      }
      return;
    }
    const it = (review.items || []).find(i => i.modelId === ev.modelId);
    if (!it) return;
    const refs = ctx.rvRefs && ctx.rvRefs.items.get(ev.modelId);
    if (ev.type === 'start') {
      it.status = 'streaming';
      // 挂上流式类：流式期间保留换行（CSS .rv-item-body.streaming 的既有钩子）
      if (refs) { refs.status.innerHTML = '<span class="spinner"></span>'; refs.body.classList.add('streaming'); }
    } else if (ev.type === 'delta') {
      it.content = U.stripEmoji(it.content + ev.text);
      if (refs) scheduleStreamPaint(refs.body, function () { paintStreamText(refs.body, it.content); });
    } else if (ev.type === 'done') {
      it.status = 'done'; it.usage = ev.usage || null; it.ms = ev.ms || 0;
      if (refs) {
        // 终态落 Markdown：先作废排队中的流式绘制（RAF 在下一帧才跑，会晚于本赋值执行）
        refs.body._paint = null;
        refs.body.classList.remove('streaming');
        refs.body.classList.add('md');
        refs.body.innerHTML = MM.md.render(it.content || '');
        refs.status.innerHTML = '<span class="badge ok">完成</span>';
      }
      updateReviewHeadStatus(ctx);
    } else if (ev.type === 'error') {
      it.ms = ev.ms || 0;
      if (ev.usage) it.usage = ev.usage;
      if (/已停止/.test(ev.message || '')) {
        it.status = 'stopped';
        ctx.reviewStopped = true;
        if (ev.usage) it.usage = ev.usage;
        if (refs) {
          refs.body._paint = null;
          if (it.content) { refs.body.classList.remove('streaming'); refs.body.classList.add('md'); refs.body.innerHTML = MM.md.render(it.content); }
          refs.status.innerHTML = '<span class="badge muted">已停止</span>';
        }
      } else {
        it.status = 'error'; it.error = ev.message;
        if (refs) {
          refs.body._paint = null;
          if (it.content) { refs.body.classList.remove('streaming'); refs.body.classList.add('md'); refs.body.innerHTML = MM.md.render(it.content); }
          else refs.body.innerHTML = '<span style="color:var(--danger)">' + U.esc(U.stripEmoji(ev.message || '失败')) + '</span>';
          refs.status.innerHTML = '<span class="badge err">失败</span>';
        }
      }
      updateReviewHeadStatus(ctx);
    }
  }

  // 阶段收尾（chat:send 的 all-done）：阶段二结束转仲裁或终止；阶段三结束落终态
  function onReviewAllDone(ctx) {
    const review = ctx.review;
    if (ctx.reviewPhase === 2) {
      const anyDone = (review.items || []).some(i => i.status === 'done' && i.content);
      // 用户按了停止就必须停在这里：哪怕互审已有完成项，也不许再自发起新的仲裁请求
      //（那会重新锁住输入框并继续消耗 token，覆盖用户的停止意图）
      if (!anyDone || ctx.reviewStopped) {
        review.stopped = !!ctx.reviewStopped;
        finalizeReviewCard(ctx, !ctx.reviewStopped);
        MM.save();
        return;
      }
      // 阶段三：仲裁（复用综合模型设置；请求事件仍走 reviewCtx 分支，phase 切 3）
      ctx.reviewPhase = 3;
      streaming = ctx.session.id;
      if (MM.sessions.current() === ctx.session) setSendBtn(true);
      MM.save();
      const sys = effectiveSystemPrompt(ctx.session);
      const budget = Math.max(512, (ctx.arbiter.contextTokens || 32768) - (ctx.arbiter.maxTokens || 4096) - 2048
        - (sys ? MM.merge.tokensOf(sys) : 0));
      const reviews = (review.items || [])
        .filter(i => (i.status === 'done' || i.status === 'stopped') && i.content)
        .map(i => ({ content: i.content }));
      const prompt = MM.merge.verdictPrompt(ctx.userQuestion, ctx.okResults, reviews, budget, ctx.reviewSources);
      const msgs = sys ? [{ role: 'system', content: sys }] : [];
      msgs.push({ role: 'user', content: prompt });
      review.verdict = {
        content: '', usage: null, ms: 0, stopped: false, status: 'streaming',
        // 仲裁也消耗 token：记下仲裁模型（flat id，与回答行口径一致），用量面板按模型拆分时能归因
        modelId: ctx.arbiter.id || ctx.arbiter.modelId || '',
        modelName: ctx.arbiter.name || ctx.arbiter.modelId || ''
      };
      const card = ctx.rvCard;
      if (card && card.isConnected) {
        ensureVerdictBlock(card);
        ctx.rvRefs = reviewRefsOf(card);
        const vr = ctx.rvRefs.verdict;
        if (vr) vr.status.innerHTML = '<span class="spinner"></span>';
        ctx.rvRefs.headStatus.innerHTML = '<span class="spinner"></span> 仲裁中…';
        scrollBottom(true);
      }
      const reqId = nextReqId('rev');
      pending.set(reqId, ctx);
      api.send({ requestId: reqId, targets: [{ model: stripModel(ctx.arbiter), messages: msgs }], searchOn: false })
        .catch(function (e) {
          pending.delete(reqId);
          streaming = null;
          setSendBtn(false);
          U.toast('仲裁失败：' + e.message, true);
          if (review.verdict) {
            review.verdict.status = 'error'; review.verdict.error = e.message || '仲裁失败';
            review.verdict.content += '\n\n（仲裁失败：' + e.message + '）';
          }
          finalizeReviewCard(ctx, true);
          MM.save();
        });
      return;
    }
    finalizeReviewCard(ctx, !!ctx.verdictFailed);
    MM.save();
  }
