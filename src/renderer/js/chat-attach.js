'use strict';
// 聊天流·附件：图片压缩落盘/文档提取/附件条与预览/粘贴与拖入/选择框。
  // ---------- 附件（图片 / 文档） ----------
  // 粘贴或拖入的待发送附件。图片经主进程落盘 + 系统 OCR 提取文字（多模态模型看原图、
  // 纯文本模型吃提取的文字）；文档提取全文后拼进消息正文（所有模型都能读到）。
  // 发送时挂到用户消息上：msg.images（引用）/ msg.files（含全文），见 send()。
  let pendingAttach = [];
  const IMAGE_MIMES = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1, 'image/bmp': 1 };
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_DOC_BYTES = 20 * 1024 * 1024;
  const MAX_DOC_CHARS = 30000;
  const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'js', 'mjs', 'ts', 'jsx', 'tsx',
    'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1',
    'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'xml', 'sql', 'css', 'scss', 'vue', 'srt'];
  const DOC_EXTS = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'rtf', 'html', 'htm', 'epub'];

  function bufToBase64(buf) {
    let b64 = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return btoa(b64);
  }

  // 文本附件解码：file.text() 固定按 UTF-8，Windows 上常见的 GBK 编码 txt（旧版记事本
  // ANSI 默认）与 UTF-16 导出文件会整篇乱码发给模型。策略：按 BOM 识别 UTF-16 →
  // 严格 UTF-8（非法序列即抛错，绝不误判）→ GBK 兜底 → 都不行按 UTF-8 有损解码。
  async function decodeTextFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) {
      try { return new TextDecoder('gbk').decode(buf); }
      catch (e2) { return new TextDecoder('utf-8').decode(buf); }
    }
  }

  // 大图等比压缩（长边 2048），控制 vision token 与请求体积；BMP/WebP 统一转 PNG。
  // 小于阈值的 PNG/JPG 原样发送，不重复编码。
  async function prepareImage(file, mime) {
    const bitmap = await createImageBitmap(file);
    const w = bitmap.width, h = bitmap.height;
    const keepMime = (mime === 'image/png' || mime === 'image/jpeg') ? mime : 'image/png';
    let blob = null;
    if (Math.max(w, h) > 2048 || keepMime !== mime) {
      const scale = Math.max(w, h) > 2048 ? 2048 / Math.max(w, h) : 1;
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, cw, ch);
      blob = await new Promise(res => canvas.toBlob(res, keepMime, 0.92));
    } else {
      blob = file;
    }
    if (bitmap.close) bitmap.close();
    if (!blob || !blob.size) throw new Error('图片解码失败');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('图片过大（压缩后仍超过 5MB），请换小图');
    return { mime: keepMime, base64: bufToBase64(new Uint8Array(await blob.arrayBuffer())), w, h, size: blob.size };
  }

  async function addImageBlob(file) {
    if (!file) return;
    if (pendingAttach.filter(a => a.kind === 'image').length >= MAX_IMAGES) {
      U.toast('一次最多附加 ' + MAX_IMAGES + ' 张图片', true);
      return;
    }
    const mime = String(file.type || '').toLowerCase();
    if (!IMAGE_MIMES[mime]) { U.toast('不支持的图片格式（支持 PNG / JPG / WebP / BMP）', true); return; }
    const a = { kind: 'image', name: file.name || '图片', ocrState: 'pending', text: '' };
    pendingAttach.push(a);
    renderAttachBar();
    // ready：发送时若 OCR 仍在跑，send() 会等它完成，避免图片被静默丢掉
    a.ready = (async () => {
      try {
        const prep = await prepareImage(file, mime);
        a.w = prep.w; a.h = prep.h; a.size = prep.size;
        const r = await api.saveImage({ name: a.name, mime: prep.mime, base64: prep.base64 });
        a.id = r.id; a.ext = r.ext; a.text = r.text || '';
      } catch (e) {
        a.failed = true;
        U.toast('图片「' + a.name + '」处理失败：' + ((e && e.message) || e), true);
      }
      a.ocrState = 'done';
      renderAttachBar();
    })();
    await a.ready;
  }

  // 拖入的文件按类型分流：图片走 addImageBlob，文本类直接读，文档类交主进程提取
  async function addDroppedFile(file) {
    if (!file) return;
    const mime = String(file.type || '').toLowerCase();
    if (IMAGE_MIMES[mime] || /\.(png|jpe?g|webp|bmp)$/i.test(file.name || '')) {
      if (!IMAGE_MIMES[mime]) { U.toast('不支持的图片格式（支持 PNG / JPG / WebP / BMP）', true); return; }
      return addImageBlob(file);
    }
    const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
    const isText = TEXT_EXTS.indexOf(ext) >= 0;
    if (!isText && DOC_EXTS.indexOf(ext) < 0) {
      U.toast('暂不支持「' + (file.name || '该文件') + '」：文本类/PDF/Office 文档可直接拖入', true);
      return;
    }
    if (file.size > MAX_DOC_BYTES) { U.toast('文件超过 20MB，无法作为附件', true); return; }
    const a = beginDocAttach(file.name);
    a.ready = (async () => {
      try {
        let text = '';
        if (isText) {
          text = await decodeTextFile(file);
          if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
        } else {
          const r = await api.extractDoc({ name: a.name, base64: bufToBase64(new Uint8Array(await file.arrayBuffer())) });
          text = (r && r.text) || '';
          if (!text.trim()) throw new Error('未能从文档中提取到文字');
        }
        if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + '\n……（内容过长，已截断）';
        a.text = text;
        a.chars = text.length;
      } catch (e) {
        a.failed = true;
        U.toast('附件「' + a.name + '」处理失败：' + ((e && e.message) || e), true);
      }
      renderAttachBar();
    })();
    await a.ready;
  }

  // 文本/文档附件的占位芯片（拖拽与「+」路径单跳共用）
  function beginDocAttach(name) {
    const a = { kind: 'file', name: name || '文档', text: '' };
    pendingAttach.push(a);
    renderAttachBar();
    return a;
  }

  function attachChip(a) {
    const remove = U.el('button', {
      class: 'att-x', title: '移除', html: U.svgIcon('x', 7),
      onclick: function (e) {
        e.stopPropagation();
        pendingAttach = pendingAttach.filter(x => x !== a);
        renderAttachBar();
      }
    });
    let status;
    if (a.failed) status = '处理失败';
    else if (a.kind === 'image') status = a.ocrState === 'done' ? (a.text ? '图中 ' + a.text.length + ' 字' : '图中无文字') : '识别文字中…';
    else status = a.text ? a.chars + ' 字' : '提取中…';
    const chip = U.el('div', { class: 'att-chip' + (a.kind === 'file' ? ' doc' : '') + (a.failed ? ' failed' : ''), title: a.name || '' },
      a.kind === 'image' && a.id
        ? U.el('img', { class: 'att-thumb', src: 'mmimg://' + a.id + '.' + a.ext, alt: '' })
        : U.el('span', { class: 'att-ico' }, '📄'),
      U.el('div', { class: 'att-meta' },
        U.el('div', { class: 'att-name' }, a.name || (a.kind === 'image' ? '图片' : '文档')),
        U.el('div', { class: 'att-status' }, status)),
      remove);
    chip.addEventListener('click', function (e) {
      if (remove === e.target || remove.contains(e.target)) return;
      if (a.kind === 'image' ? a.id : a.text) previewAttachment(a);
    });
    return chip;
  }

  function renderAttachBar() {
    const bar = U.$('#attach-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!pendingAttach.length) {
      bar.classList.add('hidden');
    } else {
      bar.classList.remove('hidden');
      for (const a of pendingAttach) bar.appendChild(attachChip(a));
    }
    refreshChipVisionHints();
  }

  function previewAttachment(a) {
    const ov = U.$('#attach-view');
    const body = U.$('#av-body');
    if (!ov || !body) return;
    body.innerHTML = '';
    if (a.kind === 'image') {
      body.appendChild(U.el('img', { class: 'av-img', src: 'mmimg://' + a.id + '.' + a.ext, alt: a.name || '图片' }));
    } else {
      body.appendChild(U.el('pre', { class: 'av-pre' }, a.text || ''));
    }
    U.$('#av-title').textContent = a.name || (a.kind === 'image' ? '图片' : '附件文本');
    // 淡出动画进行中再次打开：清掉 closing 态和挂起的隐藏定时器，否则浮层看不见
    clearTimeout(closeAttachView._t);
    ov.classList.remove('closing', 'hidden');
  }

  function closeAttachView() {
    const ov = U.$('#attach-view');
    if (!ov || ov.classList.contains('hidden') || ov.classList.contains('closing')) return;
    // 与设置弹窗同款的淡出（150ms 后再隐藏；定时器挂函数上，连点/Esc 连按不会叠）
    ov.classList.add('closing');
    clearTimeout(closeAttachView._t);
    closeAttachView._t = setTimeout(function () {
      ov.classList.add('hidden');
      ov.classList.remove('closing');
    }, 150);
  }

  // 贴了图之后，给不支持看图的模型芯片加「仅文字」提示：发送前就知道谁能看图、谁只能读字
  function refreshChipVisionHints() {
    const hasImg = pendingAttach.some(a => a.kind === 'image' && !a.failed);
    if (!hasImg) {
      for (const c of U.$$('#model-chips .chip.no-vision')) c.classList.remove('no-vision');
      return;
    }
    const flats = MM.settings.allFlatModels();
    for (const c of U.$$('#model-chips .chip')) {
      const m = flats.find(x => x.id === c.getAttribute('data-model-id'));
      c.classList.toggle('no-vision', !!(m && m.multimodal !== true));
    }
  }

  // 本轮该模型是否参与：模型不能看图、图里没提取到文字、也没有任何文字输入
  // （提问/附件文字都算）→ 没事可做，标记跳过，不浪费请求
  function modelSkippedForRound(m, userMsg) {
    if (m && m.multimodal === true) return false;
    const imgs = (userMsg && userMsg.images) || [];
    if (!imgs.length) return false;
    const hasText = !!(String(userMsg.content || '').trim() ||
      ((userMsg.files || []).some(f => f && f.text && String(f.text).trim())));
    const hasOcr = imgs.some(im => im && im.text && String(im.text).trim().length);
    return !hasText && !hasOcr;
  }

  // 历史消息里的用户内容：图片转文字占位（图片本体只发给它那一轮的多模态模型，
  // 后续轮次重发原图会重复计费，这里只带「发过什么图 + 图中文字」）；文档全文保留，
  // 追问时模型仍能引用内容，超出上下文时由裁剪逻辑淘汰。
  function historyUserContent(m) {
    const parts = [];
    if (m.content) parts.push(m.content);
    for (const f of (m.files || [])) {
      if (f && f.text) parts.push('【附件 ' + (f.name || '') + '】\n' + f.text);
    }
    for (const im of (m.images || [])) {
      if (!im) continue;
      let p = '[图片 ' + (im.name || '') + ']';
      if (im.text && String(im.text).trim()) p += '，图中文字：\n' + String(im.text).slice(0, 600);
      parts.push(p);
    }
    return parts.join('\n\n');
  }

  // 当前这轮发给模型的用户条目（按模型能力分流）
  function currentUserEntry(userMsg, mm) {
    const parts = [];
    if (userMsg.content) parts.push(userMsg.content);
    for (const f of (userMsg.files || [])) {
      if (f && f.text) parts.push('【附件 ' + (f.name || '') + '】\n' + f.text);
    }
    if (!mm) {
      // 纯文本：拼上图中提取的文字（调用方已保证不会「无文字且无输入」）
      for (const im of (userMsg.images || [])) {
        if (im && im.text && String(im.text).trim()) {
          parts.push('[图片 ' + (im.name || '') + ' 中的文字]\n' + im.text);
        }
      }
    }
    const entry = { role: 'user', content: parts.join('\n\n') };
    if (mm && (userMsg.images || []).length) {
      // 多模态：图片引用单独带上（主进程转成各家 API 的图片部件）
      entry.images = (userMsg.images || [])
        .map(im => im && ({ id: im.id, ext: im.ext, name: im.name, text: im.text || '' }))
        .filter(Boolean);
    }
    return entry;
  }
  // 「+」按钮：原生文件选择框加附件。单跳路由（E5）：图片回传 base64（渲染层
  // 压缩要用 canvas，保留这一跳）；文本/文档只拿元数据，内容经白名单路径由主进程
  // 直读/直提取——大文档不再 base64 两跳过 IPC、不再写临时文件
  async function pickAttachments() {
    let r;
    try {
      r = await api.pickFiles();
    } catch (e) {
      U.toast('选择文件失败：' + ((e && e.message) || e), true);
      return;
    }
    if (!r) return; // 用户取消了选择框
    for (const name of (r.tooLarge || [])) U.toast('「' + name + '」超过大小上限，已跳过', true);
    for (const f of (r.files || [])) {
      const mime = String(f.mime || '').toLowerCase();
      if (IMAGE_MIMES[mime]) {
        const bin = atob(f.base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        await addImageBlob(new File([arr], f.name || '图片', { type: mime }));
        continue;
      }
      const ext = ((f.name || '').split('.').pop() || '').toLowerCase();
      const isText = TEXT_EXTS.indexOf(ext) >= 0;
      if (!isText && DOC_EXTS.indexOf(ext) < 0) {
        U.toast('暂不支持「' + (f.name || '该文件') + '」：文本类/PDF/Office 文档可直接拖入', true);
        continue;
      }
      if ((f.size || 0) > MAX_DOC_BYTES) { U.toast('文件超过 20MB，无法作为附件', true); continue; }
      const a = beginDocAttach(f.name);
      a.ready = (async () => {
        try {
          let text = '';
          if (isText) {
            const rr = await api.readTextPath({ path: f.path });
            text = (rr && rr.text) || '';
          } else {
            const rr = await api.extractDocPath({ path: f.path, name: f.name });
            text = (rr && rr.text) || '';
            if (!text.trim()) throw new Error('未能从文档中提取到文字');
          }
          if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
          if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS) + '\n……（内容过长，已截断）';
          a.text = text;
          a.chars = text.length;
        } catch (e) {
          a.failed = true;
          U.toast('附件「' + a.name + '」处理失败：' + ((e && e.message) || e), true);
        }
        renderAttachBar();
      })();
      await a.ready;
    }
    const inp = U.$('#input');
    if (inp) inp.focus();
  }
