'use strict';
// 聊天流·核心：命名空间、共享可变状态与微助手。
// 拆分说明：chat-* 六个文件共享同一全局词法作用域（经典脚本顶层声明跨文件可见），
// 全部代码从原 ui-chat.js 逐字搬移，跨文件引用靠全局函数/词法声明在调用时解析。
// 聊天流：用户消息、多模型并行流式渲染、重新生成、综合回答、联网搜索、图片/文件附件
window.MM = window.MM || {};

  const U = MM.util;
  let seq = 0;
  // requestId 带随机后缀：渲染层重载后 seq 归零会复用旧 id，主进程的
  // activeRequests 表被同名新请求覆盖后，旧请求从此无法停止（静默跑完烧钱）
  function nextReqId(prefix) {
    return prefix + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
  }
  // 正在生成的会话 id（null = 空闲）。全局同一时刻只跑一轮；
  // 存会话 id 是为了区分"当前会话在生成"和"别的会话在生成"。
  let streaming = null;
  // 轮次令牌：每次 dispatchRound 自增。停止或开始新一轮后，仍停留在搜索阶段的旧轮次
  // 醒来时令牌已过期，必须放弃——只看 streaming 是否为真值会把新轮次误当成"没被取消"。
  let runToken = 0;
  // 当前搜索阶段的请求 id：stopAll 同时中止它（此前停止只覆盖 chat，搜索会在
  // 主进程空跑到 15s 超时）
  let curSearchId = null;
  let curSearchSessionId = null; // 搜索所属会话：删除会话时要能中止对应的搜索请求
  // 处于联网搜索阶段（尚未建立 pending）的轮次数。此时收到上一轮的 all-done 不能把
  // streaming 清空，否则刚开始的新一轮会被误判为"已取消"。
  let searchPhase = 0;
  const pending = new Map(); // requestId -> 请求上下文
  // 一次性抑制消息区淡入：版本切换走局部 ver-swap 过渡，不该整页重淡入
  let suppressFade = false;
  // 会话提示词是长文本，防抖要更长，避免边打字边写盘。
  // 注意会话级提示词存在 session 上（不是 config），必须整份保存。
  const saveSoonPrompt = U.debounce(() => { MM.save(); }, 800);
  function streamingHere() { return !!streaming && streaming === MM.state.currentId; }
  function streamingSessionName() {
    const s = MM.state.sessions.find(x => x.id === streaming);
    return (s && s.title) || '其它会话';
  }
  // 切会话/轮次结束时同步发送按钮：别的会话在生成时，当前会话仍应可输入、可发送
  function refreshSendBtn() { setSendBtn(streamingHere()); }

  function stripModel(m) {
    // 不携带 apiKey：密钥由主进程按 providerId 保管并在请求时解析
    return { id: m.id, providerId: m.providerId, name: m.name, provider: m.provider, apiFormat: m.apiFormat, baseUrl: m.baseUrl, modelId: m.modelId, fullUrl: m.fullUrl, maxTokens: m.maxTokens };
  }

  // 按 data-round 查找元素：roundId 可能来自导入数据，不能直接拼进 CSS 选择器
  function byRound(sel, roundId, root) {
    const box = root || U.$('#messages');
    if (!box) return null;
    const want = roundId == null ? '' : String(roundId);
    for (const el of Array.from(box.querySelectorAll(sel))) {
      if ((el.getAttribute('data-round') || '') === want) return el;
    }
    return null;
  }

  function setSendBtn(on) {
    const b = U.$('#btn-send');
    const inp = U.$('#input');
    inp.readOnly = on; // 生成中禁改（内容保留可复制）
    b.classList.toggle('stop', on);
    b.innerHTML = on ? U.svgIcon('stop', 10) : U.svgIcon('send', 13);
    b.title = on ? '停止生成' : '发送';
    b.classList.toggle('ready', on || inp.value.trim().length > 0);
    U.$('.input-row').classList.toggle('off', on);
    if (on) inp.placeholder = '生成中，请稍候…';
    else inp.placeholder = '输入消息…  Enter 发送，Shift+Enter 换行，可粘贴/拖入或点 + 加附件';
  }

  function selectedModels() {
    const ids = Array.from(U.$$('#model-chips .chip.on')).map(c => c.getAttribute('data-model-id'));
    return MM.settings.allFlatModels().filter(m => ids.includes(m.id));
  }
