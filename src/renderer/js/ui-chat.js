'use strict';
// 聊天流·装配：事件绑定、全局订阅、MM.chat 导出面（最后加载）。
// 聊天流：用户消息、多模型并行流式渲染、重新生成、综合回答、联网搜索、图片/文件附件
  // ---------- 绑定 ----------
  function bind() {
    // 会话提示词面板：展开 / 收起 / 清除；内容随输入写入当前会话并防抖落盘
    const spBtn = U.$('#btn-session-prompt');
    const spBox = U.$('#session-prompt-box');
    const spTa = U.$('#session-prompt');
    if (spBtn && spBox && spTa) {
      spBtn.addEventListener('click', function () { togglePromptBox(); });
      U.$('#btn-sp-close').addEventListener('click', function () { togglePromptBox(false); });
      U.$('#btn-sp-clear').addEventListener('click', function () {
        const s = MM.sessions.current();
        if (s) { delete s.systemPrompt; MM.save(); }
        spTa.value = '';
        refreshPromptBadge();
        U.toast('已清除本会话提示词');
      });
      // 输入即写入会话对象：面板可能被直接关掉，不点保存也不会丢
      spTa.addEventListener('input', function () {
        const s = MM.sessions.current();
        if (!s) return;
        const v = spTa.value.trim();
        if (v) s.systemPrompt = spTa.value; else delete s.systemPrompt;
        saveSoonPrompt();
        refreshPromptBadge();
      });
    }

    U.$('#btn-new-chat').addEventListener('click', function () {
      if (streamingHere()) stopAll();
      MM.sessions.create();
      renderAll();
      renderTitle();
      U.$('#input').focus();
    });
    // 发送/停止共用一个按钮：再次点击 = 停止当前会话的生成
    U.$('#btn-send').addEventListener('click', function () {
      if (streamingHere()) stopAll(); else send();
    });
    U.$('#input').addEventListener('input', autoResize);
    // 「+」按钮：原生文件选择框加附件
    const attBtn = U.$('#btn-attach');
    if (attBtn) attBtn.addEventListener('click', pickAttachments);
  // ---------- 附件：粘贴图片 ----------
    // 只拦截文件型剪贴板内容（截图工具、复制的图片文件）；纯文本粘贴走默认行为
    U.$('#input').addEventListener('paste', function (e) {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it && it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) addImageBlob(f);
    });
    // ---------- 附件：拖拽到主区（消息区+输入区都算，防止拖偏触发浏览器打开文件） ----------
    const dropZone = U.$('#main');
    let dragDepth = 0;
    dropZone.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      dropZone.classList.add('dragging');
    });
    dropZone.addEventListener('dragover', function (e) { e.preventDefault(); });
    dropZone.addEventListener('dragleave', function () {
      if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove('dragging'); }
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove('dragging');
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      for (const f of Array.from(files)) addDroppedFile(f);
    });
    // 附件预览浮层：按钮/遮罩关闭，Esc 兜底
    const avClose = U.$('#av-close');
    if (avClose) avClose.addEventListener('click', closeAttachView);
    const av = U.$('#attach-view');
    if (av) av.addEventListener('click', function (e) { if (e.target === av) closeAttachView(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && av && !av.classList.contains('hidden')) { e.stopPropagation(); closeAttachView(); }
    });
    // ---------- 导出整个会话 ----------
    const exBtn = U.$('#btn-export-session');
    if (exBtn) exBtn.addEventListener('click', exportSession);
    // 中文输入法兼容：组合输入（拼音候选）期间不能拦截按键，否则上屏会被打断
    let composing = false;
    U.$('#input').addEventListener('compositionstart', function () { composing = true; });
    U.$('#input').addEventListener('compositionend', function () { composing = false; });
    U.$('#input').addEventListener('keydown', function (e) {
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    U.$('#btn-theme').addEventListener('click', function () {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      // 加临时类播放颜色过渡，结束后移除（避免常驻 transition 干扰元素自身的 hover 过渡）
      document.documentElement.classList.add('theme-anim');
      document.documentElement.setAttribute('data-theme', next);
      setTimeout(function () { document.documentElement.classList.remove('theme-anim'); }, 280);
      try { localStorage.setItem('mmc-theme', next); } catch (e) { }
    });
    // 自绘窗口三键（#win-controls）：最小化/最大化(还原)/关闭。
    // DOM 按钮随主题与弹窗遮罩联动，规避原生 WCO 白条不被遮罩压暗的问题
    if (window.api && window.api.winControl) {
      const maxBtn = U.$('#btn-win-max');
      const setMax = function (m) { if (maxBtn) maxBtn.classList.toggle('is-max', !!m); };
      U.$('#btn-win-min').addEventListener('click', function () { window.api.winControl('min'); });
      maxBtn.addEventListener('click', function () { window.api.winControl('max').then(setMax).catch(function () { }); });
      U.$('#btn-win-close').addEventListener('click', function () { window.api.winControl('close'); });
      if (window.api.onWinState) window.api.onWinState(setMax);
    }
    U.$('#tgl-auto').addEventListener('change', function () {
      MM.state.config.synthesis.autoMerge = this.checked;
      MM.save({ configOnly: true }); // 只改了 config，不需要复制整份会话历史
    });
    U.$('#tgl-review').addEventListener('change', function () {
      MM.state.config.synthesis.crossReview = this.checked;
      MM.save({ configOnly: true });
    });
    // 顶栏开关胶囊的高亮态跟随复选框（开启时文字变 accent 色，一眼可辨）
    for (const id of ['#tgl-search', '#tgl-auto', '#tgl-review']) {
      const input = U.$(id);
      const sync = function () { input.closest('.toggle').classList.toggle('on', input.checked); };
      input.addEventListener('change', sync);
      sync();
    }
    // 回到底部悬浮按钮：离开底部较远时出现
    const wrap = U.$('#messages');
    const sb = U.$('#btn-scroll-bottom');
    wrap.addEventListener('scroll', function () {
      const gap = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
      sb.classList.toggle('show', gap > 240);
      stickBottom = gap < 140; // 用户滚回底部后恢复自动跟随
    }, { passive: true });
    sb.addEventListener('click', function () {
      wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
    });
    U.$('#session-title').addEventListener('dblclick', function () {
      const s = MM.sessions.current();
      if (s) MM.sessions.renameInline(s.id);
    });
    api.onEvent(handleEvent);
    // 启动后聚焦输入框，便于直接打字
    setTimeout(() => {
      const inp = U.$('#input');
      if (inp && document.activeElement === document.body) inp.focus();
    }, 150);
  }

  MM.chat = {
    send, renderAll, renderChips, renderTitle, bind, stopSession, refreshPromptBadge, stopAll,
    // 会话列表用：该会话是否正在后台生成（呼吸点标记）
    isStreamingSession: function (id) { return !!streaming && streaming === id; },
    // 给 smoke 测试用的出口，不影响线上逻辑
    _buildHistoryForTest: buildHistory,
    _statusHtmlForTest: statusHtml,
    _roundToMarkdownForTest: roundToMarkdown,
    _sessionToMarkdownForTest: sessionToMarkdown,
    _modelSkippedForTest: modelSkippedForRound,
    _deleteRoundForTest: deleteRound,
    _retryOneForTest: retryOne,
    _doMergeForTest: doMerge,
    _setVersionForTest: setVersion,
    _handleEventForTest: handleEvent,
    // 最近一次挂载的请求上下文概要（验证重试后节点缓存是否指向活跃 DOM）
    _pendingForTest: function () {
      const entry = Array.from(pending.entries()).pop();
      if (!entry) return null;
      const last = entry[1];
      return {
        requestId: entry[0],
        singleRetry: !!last.singleRetry,
        hasGrid: !!last.grid,
        cardIds: last.cards ? Array.from(last.cards.keys()) : [],
        bodyConnected: !!(last.cards && Array.from(last.cards.values()).every(r => r.body && r.body.isConnected))
      };
    }
  };
