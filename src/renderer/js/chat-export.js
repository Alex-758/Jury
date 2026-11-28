'use strict';
// 聊天流·导出与删除：轮次 Markdown/会话 Markdown/删除本轮。
  // ---------- 导出本轮 ----------
  // 生成 Markdown：结构用标记（这是文件产物，不是剪贴板纯文本），正文用模型原始输出。
  // Windows 文件名清洗：非法字符、保留设备名（CON/NUL/COM1…）、结尾点与空格。
  // 保留名不处理会导出失败，结尾点/空格会被系统静默裁掉
  function safeFilename(title, fallback) {
    let name = U.stripEmoji(title || fallback).replace(/[\\/:*?"<>|]/g, '_').replace(/[.\s]+$/, '').trim();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = '_' + name;
    return (name || fallback).slice(0, 50);
  }

  async function exportRound(roundId) {
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const am = s.messages[idx];
    const userMsg = s.messages[idx - 1];
    const md = roundToMarkdown(am, s, userMsg);
    const filename = safeFilename(s.title, '对话导出') + '.md';
    try {
      const p = await api.exportText({ content: md, filename: filename });
      if (p) U.toast('已导出到 ' + p);
    } catch (e) {
      U.toast('导出失败：' + ((e && e.message) || e), true);
    }
  }

  function roundToMarkdown(am, s, userMsg) {
    const L = [];
    L.push('# ' + ((userMsg && userMsg.content) || '（图片提问）'));
    L.push('');
    L.push('> 会话「' + (s.title || '') + '」 · 导出于 ' + new Date().toLocaleString('zh-CN'));
    const attLines = attachmentLines(userMsg);
    if (attLines.length) {
      L.push('');
      L.push('**提问附件**：');
      for (const line of attLines) L.push('- ' + line);
    }
    for (const r of (am.results || [])) {
      L.push('');
      L.push('## ' + (r.name || r.modelId));
      const bits = [];
      if (r.status === 'done') bits.push('完成');
      else if (r.status === 'stopped') bits.push('已停止');
      else if (r.status === 'skipped') bits.push('已跳过（' + (r.error || '不支持图片') + '）');
      else if (r.status === 'error') bits.push('失败：' + (r.error || ''));
      if (r.ms) bits.push('用时 ' + U.fmtMs(r.ms));
      if (r.chars) bits.push(r.chars + ' 字');
      if (r.usage && (r.usage.input || r.usage.output)) {
        bits.push(MM.modelInfo.fmtTokens((r.usage.input || 0) + (r.usage.output || 0)) +
          ' tokens（输入 ' + (r.usage.input || 0) + ' / 输出 ' + (r.usage.output || 0) + '）');
      }
      if (bits.length) { L.push('*' + bits.join(' · ') + '*'); L.push(''); }
      L.push(r.content || '');
    }
    if (am.merge && am.merge.content) {
      L.push('');
      L.push('## 综合回答');
      const mu = am.merge.usage;
      if (mu && (mu.input || mu.output)) {
        L.push('*' + MM.modelInfo.fmtTokens((mu.input || 0) + (mu.output || 0)) + ' tokens（输入 ' + (mu.input || 0) + ' / 输出 ' + (mu.output || 0) + '）*');
        L.push('');
      }
      L.push(am.merge.content);
      // 来源对照：报告里匹配到原回答的块，逐条注明来自哪些模型（尽力匹配）
      const srcs = MM.merge.matchSources(am.merge.content, am.results || []);
      if (srcs.length) {
        L.push('');
        L.push('---');
        L.push('');
        L.push('*来源对照（报告要点与各模型原回答）*：');
        for (const s of srcs.slice(0, 24)) {
          L.push('- ' + (s.text.length > 60 ? s.text.slice(0, 60) + '…' : s.text) +
            ' —— 来自 ' + s.models.map(m => m.name).join('、'));
        }
      }
    }
    // 交叉审查：各审查员的发现 + 仲裁结论（导出活跃份——与综合版本导出同语义）
    const reviewOut = activeReviewOf(am);
    if (reviewOut) {
      const rvItems = (reviewOut.items || []).filter(i => i.content);
      const vContent = reviewOut.verdict && reviewOut.verdict.content;
      if (rvItems.length || vContent) {
        L.push('');
        L.push('## 交叉审查');
        for (const it of rvItems) {
          L.push('');
          L.push('### 审查 · ' + (it.name || it.modelId));
          L.push('');
          L.push(it.content);
        }
        if (vContent) {
          L.push('');
          L.push('## 仲裁结论');
          L.push('');
          L.push(vContent);
        }
      }
    }
    // 文档附件全文放附录，导出文件拿到别处也能读到附件内容
    for (const f of ((userMsg && userMsg.files) || [])) {
      if (!f || !f.text) continue;
      L.push('');
      L.push('## 附录：附件「' + (f.name || '') + '」全文');
      L.push('');
      L.push(f.text);
    }
    return U.stripEmoji(L.join('\n'));
  }

  // 提问附件的一句话说明（导出用）
  function attachmentLines(userMsg) {
    const lines = [];
    for (const im of ((userMsg && userMsg.images) || [])) {
      if (!im) continue;
      lines.push('图片 ' + (im.name || '') + (im.text ? '（图中文字：' + String(im.text).slice(0, 120).replace(/\s+/g, ' ') + '…）' : '（未提取到文字）'));
    }
    for (const f of ((userMsg && userMsg.files) || [])) {
      if (!f) continue;
      lines.push('文档 ' + (f.name || '') + '（' + (f.chars || (f.text ? f.text.length : 0)) + ' 字）');
    }
    return lines;
  }

  // ---------- 导出整个会话 ----------
  function sessionToMarkdown(s) {
    const msgs = (s && s.messages) || [];
    const L = [];
    L.push('# ' + (s.title || '会话导出'));
    L.push('');
    L.push('> 导出于 ' + new Date().toLocaleString('zh-CN') + ' · ' + msgs.filter(m => m && m.role === 'user').length + ' 轮对话');
    function statusLabel(r) {
      if (r.status === 'done') return '完成';
      if (r.status === 'stopped') return '已停止';
      if (r.status === 'skipped') return '已跳过';
      if (r.status === 'error') return '失败：' + (r.error || '');
      return '';
    }
    let i = 0, round = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (!m || m.role !== 'user') { i++; continue; }
      round++;
      L.push('');
      L.push('---');
      L.push('');
      L.push('## 提问 ' + round + '：' + (String(m.content || '').trim() || '（图片提问）'));
      const attLines = attachmentLines(m);
      if (attLines.length) {
        L.push('');
        for (const line of attLines) L.push('*[' + line + ']*');
      }
      i++;
      let am = null;
      while (i < msgs.length && (!msgs[i] || msgs[i].role !== 'user')) {
        if (msgs[i] && msgs[i].role === 'assistant') am = msgs[i];
        i++;
      }
      if (am) {
        for (const r of (am.results || [])) {
          L.push('');
          L.push('### ' + (r.name || r.modelId) + (statusLabel(r) ? '（' + statusLabel(r) + '）' : ''));
          L.push('');
          L.push(r.content || '（无内容）');
        }
        if (am.merge && am.merge.content) {
          L.push('');
          L.push('### 综合回答');
          L.push('');
          L.push(am.merge.content);
        }
        // 会话导出只带仲裁结论（互审发现全文较长，按轮导出里有完整版）；取活跃份
        const rvOut = activeReviewOf(am);
        if (rvOut && rvOut.verdict && rvOut.verdict.content) {
          L.push('');
          L.push('### 交叉审查结论');
          L.push('');
          L.push(rvOut.verdict.content);
        }
      } else {
        L.push('');
        L.push('*(本轮没有回答)*');
      }
    }
    // 全部文档附件全文集中在文末附录
    let appendix = 0;
    for (const m of msgs) {
      for (const f of ((m && m.files) || [])) {
        if (!f || !f.text) continue;
        appendix++;
        L.push('');
        L.push('## 附录' + appendix + '：附件「' + (f.name || '') + '」全文');
        L.push('');
        L.push(f.text);
      }
    }
    return U.stripEmoji(L.join('\n'));
  }

  async function exportSession() {
    const s = MM.sessions.current();
    if (!s || !s.messages.length) { U.toast('当前会话还没有内容', true); return; }
    const md = sessionToMarkdown(s);
    const filename = safeFilename(s.title, '会话导出') + '.md';
    try {
      const p = await api.exportText({ content: md, filename: filename, title: '导出整个会话' });
      if (p) U.toast('已导出到 ' + p);
    } catch (e) {
      U.toast('导出失败：' + ((e && e.message) || e), true);
    }
  }

  // ---------- 删除本轮 ----------
  async function deleteRound(roundId) {
    if (streaming) { U.toast('请等待当前任务完成', true); return; }
    const s = MM.sessions.current();
    if (!s) return;
    const idx = s.messages.findIndex(m => m.role === 'assistant' && m.roundId === roundId);
    if (idx < 0) return;
    const ok = await U.confirm({
      title: '删除本轮对话',
      message: '将删除这一轮的提问与全部回答（含综合回答）。此操作不可恢复。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    // 连同它前面的提问一起删；后面若挂着旧格式的独立消息也一并清掉（到下一条 user 为止）
    let start = idx;
    if (s.messages[idx - 1] && s.messages[idx - 1].role === 'user') start = idx - 1;
    let end = idx + 1;
    while (end < s.messages.length && s.messages[end].role !== 'user') end++;
    s.messages.splice(start, end - start);
    s.updatedAt = Date.now();
    MM.save();
    renderAll();
    MM.sessions.render();
    U.toast('已删除本轮对话');
  }
