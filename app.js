/* ================= 全局错误提示 ================= */
window.addEventListener('error', function(e){
  var bar = document.getElementById('errbar');
  var txt = document.getElementById('errtext');
  if(bar && txt){ bar.style.display='block'; txt.textContent = (e.message||'') + ' @ line ' + (e.lineno||''); }
});

var state = {
  messages: [], loading: false, abort: null, started: false, connected: false,
  components: [], activeComp: 0, history: [], historyIndex: -1,
  editor: null, editorReady: false, isProgrammaticChange: false,
  keyProfiles: [], activeProfile: -1, projects: [], activeProjectId: null,
  allModels: [], currentModel: '', modifyMode: false,
  startTime: 0, timerInterval: null, lastDuration: 0,
  lastRawOutput: '', mobileTab: 'chat',
  searchResults: [], searchIndex: 0,
  pendingTemplate: null,
  pasteTarget: null,
  longPressTimer: null,
  lastScrollY: 0
};

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function isMobile(){ return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches; }

/* ================= 移动端 Tab ================= */
function switchMobileTab(tab){
  state.mobileTab = tab;
  var tabs = document.querySelectorAll('.mtab');
  for(var i = 0; i < tabs.length; i++){
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
  }
  var panels = { chat: 'panelChat', code: 'panelCode', preview: 'panelPreview' };
  for(var key in panels){
    var p = $(panels[key]);
    if(p) p.classList.toggle('mobile-active', key === tab);
  }
  setTimeout(function(){
    if(tab === 'preview'){ applyViewport(); }
    if(tab === 'code' && state.editorReady){ state.editor.layout(); }
  }, 60);
  if(tab === 'chat'){ var b = $('chatBadge'); if(b) b.classList.remove('show'); }
}

/* ================= 计时器 ================= */
function startTimer(){
  state.startTime = Date.now();
  var timer = $('timer'), num = $('timerNum');
  if(!timer || !num) return;
  timer.style.display = 'block';
  num.textContent = '0.0';
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(function(){
    num.textContent = ((Date.now() - state.startTime) / 1000).toFixed(1);
  }, 100);
}
function stopTimer(){
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  if(state.startTime) state.lastDuration = (Date.now() - state.startTime) / 1000;
  var timer = $('timer'); if(timer) timer.style.display = 'none';
  return state.lastDuration;
}

/* ================= 完整性检测 ================= */
function isCodeIncomplete(code){
  if(!code || !code.trim()) return false;
  var trimmed = code.trim();
  if(/<html[\s>]/i.test(trimmed)) return !/<\/html>\s*$/i.test(trimmed);
  if(/<body[\s>]/i.test(trimmed)) return !/<\/body>/i.test(trimmed);
  if(/<\/[a-z]+>\s*$|<script[\s\S]*<\/script>\s*$/i.test(trimmed)) return false;
  if(/[}\;\)]\s*$/.test(trimmed)) return false;
  return true;
}
function showContinueBtn(show){
  var btn = $('contBtn');
  if(btn) btn.classList.toggle('show', !!show);
}

/* ================= 语言识别 ================= */
function detectLanguage(code){
  if(!code || !code.trim()) return 'html';
  var s = code.trim();
  if(/<!DOCTYPE|<html[\s>]|<head[\s>]|<body[\s>]/i.test(s)) return 'html';
  if(/^\s*@(media|import|keyframes|font-face|supports|charset)/i.test(s)) return 'css';
  if(/^\s*[\.\#\w\-\[\]\:\*]+\s*\{[^}]*[\w\-]+\s*:/m.test(s) && !/<[a-z]/i.test(s)) return 'css';
  if(/^\s*:root\s*\{/i.test(s)) return 'css';
  if(/^\s*(import\s|export\s|const\s|let\s|var\s|function\s|class\s|async\s|await\s|document\.|window\.|console\.|\$\(|=>|\/\/|\/\*)/m.test(s)) return 'js';
  if(/\b(function|const|let|var|return|if|for|while)\s*[\(\{\w]/i.test(s) && !/<[a-z]/i.test(s)) return 'js';
  if(/^\s*<[a-z][\s\S]*>[\s\S]*<\/[a-z]+>\s*$/i.test(s)) return 'html';
  if(/^\s*<[a-z][^>]*\/?>/i.test(s)) return 'html';
  return 'html';
}

/* ================= 智能分区 ================= */
/* 核心改动：解析 AI 返回的原始文本，识别出所有可拆分的块 */
function smartSplit(raw){
  if(!raw || !raw.trim()) return [];

  var text = raw.trim();
  // 去掉 markdown 代码块标记（如果 AI 还是包了）
  text = text.replace(/^```(?:html|css|js|javascript)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // 如果 AI 用特殊标记分区，优先按标记拆
  var markedParts = parseMarkedSections(text);
  if(markedParts.length > 0) return markedParts;

  // 去开头的解释文字，找到第一个代码标记
  var firstMark = text.search(/<!DOCTYPE|<html|<head|<body|<style|<script|@media|@keyframes|[\.\#\w\-\[\]]+\s*\{|\/\/|\/\*/i);
  if(firstMark > 0) text = text.slice(firstMark);

  var comps = [];

  // 1. 抽取所有 style 块
  var styleBlocks = [];
  var m;
  var styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while((m = styleRe.exec(text))) styleBlocks.push(m[1].trim());

  // 2. 抽取所有内联 script 块
  var scriptBlocks = [];
  var scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while((m = scriptRe.exec(text))) scriptBlocks.push(m[1].trim());

  // 3. 抽取 head 里的外部资源（CDN script/link）
  var headExtras = '';
  var headMatch = text.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if(headMatch){
    var h = headMatch[1];
    h = h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    h = h.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
    h = h.replace(/<meta[^>]*>/gi, '');
    h = h.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '');
    headExtras = h.trim();
  }

  // 4. 抽取 body 内容
  var bodyContent = '';
  var bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if(bodyMatch){
    var b = bodyMatch[1];
    b = b.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    b = b.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi, '');
    bodyContent = b.trim();
  }

  var hasHtmlDoc = /<!DOCTYPE|<html[\s>]/i.test(text);

  if(hasHtmlDoc){
    // 是完整 HTML 文档：拆成 head 额外资源 + body + style + script
    if(headExtras){
      comps.push({ name: 'Head 资源', type: 'html', code: headExtras, enabled: true });
    }
    if(bodyContent){
      // body 里可能还有多个顶层区块，用 <section>/<main>/<header>/<footer>/<div id> 拆
      var bodyParts = splitBodyIntoSections(bodyContent);
      if(bodyParts.length > 1){
        for(var i = 0; i < bodyParts.length; i++){
          comps.push({ name: bodyParts[i].name, type: 'html', code: bodyParts[i].code, enabled: true });
        }
      } else {
        comps.push({ name: '页面结构', type: 'html', code: bodyContent, enabled: true });
      }
    }
    for(var s = 0; s < styleBlocks.length; s++){
      comps.push({ name: styleBlocks.length > 1 ? ('样式 ' + (s+1)) : '样式', type: 'css', code: styleBlocks[s], enabled: true });
    }
    for(var sc = 0; sc < scriptBlocks.length; sc++){
      comps.push({ name: scriptBlocks.length > 1 ? ('交互 ' + (sc+1)) : '交互', type: 'js', code: scriptBlocks[sc], enabled: true });
    }
  } else {
    // 不是完整 HTML：按内容类型判断
    var lang = detectLanguage(text);
    if(lang === 'html'){
      // 可能是一堆 HTML 片段，按顶层标签拆
      var parts = splitBodyIntoSections(text);
      if(parts.length > 1){
        for(var p = 0; p < parts.length; p++){
          comps.push({ name: parts[p].name, type: 'html', code: parts[p].code, enabled: true });
        }
      } else {
        comps.push({ name: '页面结构', type: 'html', code: text, enabled: true });
      }
    } else if(lang === 'css'){
      comps.push({ name: '样式', type: 'css', code: text, enabled: true });
    } else if(lang === 'js'){
      comps.push({ name: '交互', type: 'js', code: text, enabled: true });
    } else {
      comps.push({ name: '页面', type: 'html', code: text, enabled: true });
    }
  }

  // 如果没拆出东西，就整段当一个
  if(comps.length === 0){
    comps.push({ name: '页面', type: detectLanguage(text), code: text, enabled: true });
  }
  return comps;
}

/* 解析 AI 用特殊标记分区的情况 */
function parseMarkedSections(text){
  // 支持的标记格式：
  // <!-- FILE: header.html --> ... 
  // /* === style.css === */ ... 
  // // === script.js ===
  // 或 【样式】... 后面跟代码
  var comps = [];
  var markerPatterns = [
    /<!--\s*(?:FILE|文件)[\s:：]+([^\s>]+)\s*-->/gi,
    /\/\*+\s*([\w\-\.]+\.(?:css|js|html))\s*\*+\//gi,
    /\/\/\s*=+\s*([\w\-\.]+\.(?:css|js|html))\s*=+/gi,
    /【(样式|交互|结构|CSS|JS|HTML)】(?:[\s:：]*)/gi
  ];
  
  // 简单实现：查找所有 <!-- FILE: xxx --> 标记
  var fileMarkers = [];
  var m;
  var fileRe = /<!--\s*(?:FILE|文件)[\s:：]+([^\s>]+)\s*-->/gi;
  while((m = fileRe.exec(text))) fileMarkers.push({ name: m[1], pos: m.index, end: m.index + m[0].length });
  
  if(fileMarkers.length > 0){
    for(var i = 0; i < fileMarkers.length; i++){
      var start = fileMarkers[i].end;
      var end = i + 1 < fileMarkers.length ? fileMarkers[i+1].pos : text.length;
      var content = text.slice(start, end).trim();
      var fname = fileMarkers[i].name;
      var type = 'html';
      if(/\.css$/i.test(fname)) type = 'css';
      else if(/\.js$/i.test(fname)) type = 'js';
      comps.push({ name: fname.replace(/\.(html|css|js)$/i, ''), type: type, code: content, enabled: true });
    }
    return comps;
  }
  return [];
}

/* 把 body 内容按顶层区块拆分 */
function splitBodyIntoSections(html){
  if(!html || !html.trim()) return [];
  // 尝试匹配顶层 <section>/<main>/<header>/<footer>/<nav>/<aside>/<article>
  var sectionRe = /<(section|main|header|footer|nav|aside|article)[^>]*>[\s\S]*?<\/\1>/gi;
  var matches = html.match(sectionRe) || [];
  
  if(matches.length >= 2){
    // 多个顶层区块，按它们拆
    var parts = [];
    var lastEnd = 0;
    var re = /<(section|main|header|footer|nav|aside|article)([^>]*)>/gi;
    var m;
    var depth = 0;
    var openTag = '';
    var startIdx = 0;
    
    // 简化：直接用正则找顶层 section
    var topLevelRe = /<(section|main|header|footer|nav|aside|article)[^>]*>[\s\S]*?<\/\1>/gi;
    var lastPos = 0;
    var idx = 0;
    var match;
    while((match = topLevelRe.exec(html))){
      if(match.index > lastPos){
        var before = html.slice(lastPos, match.index).trim();
        if(before) parts.push({ name: '片段 ' + (++idx), code: before });
      }
      // 提取标签名作为名字
      var tagMatch = match[0].match(/^<(\w+)([^>]*)>/i);
      var tagName = tagMatch ? tagMatch[1].toLowerCase() : 'section';
      var attrs = tagMatch ? tagMatch[2] : '';
      var idMatch = attrs.match(/id=["']([^"']+)["']/i);
      var classMatch = attrs.match(/class=["']([^"']+)["']/i);
      var name = idMatch ? idMatch[1] : (classMatch ? classMatch[1].split(/\s+/)[0] : tagName);
      parts.push({ name: name, code: match[0] });
      lastPos = match.index + match[0].length;
    }
    var tail = html.slice(lastPos).trim();
    if(tail) parts.push({ name: '片段 ' + (++idx), code: tail });
    
    if(parts.length >= 2) return parts;
  }
  
  // 尝试用 <!-- 注释 --> 分段
  var commentRe = /<!--\s*([\s\S]{1,80}?)\s*-->/g;
  var commentMatches = [];
  var cm;
  while((cm = commentRe.exec(html))) commentMatches.push({ text: cm[1], pos: cm.index, end: cm.index + cm[0].length });
  
  if(commentMatches.length >= 2){
    var cparts = [];
    for(var ci = 0; ci < commentMatches.length; ci++){
      var cstart = commentMatches[ci].end;
      var cend = ci + 1 < commentMatches.length ? commentMatches[ci+1].pos : html.length;
      var ccontent = html.slice(cstart, cend).trim();
      if(ccontent){
        cparts.push({ name: commentMatches[ci].text.slice(0, 20) || ('片段 ' + (ci+1)), code: ccontent });
      }
    }
    if(cparts.length >= 2) return cparts;
  }
  
  return [{ name: '页面结构', code: html }];
}

/* ================= 修改模式 ================= */
function onModifyToggle(checked){
  state.modifyMode = checked;
  var btn = $('genBtn'), lbl = $('modifyToggle');
  if(checked){
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>修改';
    btn.classList.add('modify');
    if(lbl) lbl.classList.add('active');
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>生成';
    btn.classList.remove('modify');
    if(lbl) lbl.classList.remove('active');
  }
  try{ localStorage.setItem('cu-modify-mode', checked ? '1' : '0'); }catch(e){}
}

/* 修改模式上下文：合并所有组件成一个完整 HTML 给 AI，确保 CSS/JS 对应得上 */
function buildModifyContext(){
  // 关键修复：把当前所有组件组装成一个完整 HTML 文档，而不是分块给 AI
  // 这样 AI 看到的是一个能跑的完整页面，改完也能对应上
  var html = buildPreviewHtml();
  return { html: html };
}

function buildModifySystemPrompt(ctx){
  return [
    '你是前端代码修改助手。用户会给你一份【现有完整代码】和一条【修改需求】。',
    '你必须基于现有代码进行修改，保留原有的结构、样式和功能，只改动用户要求的部分。',
    '不要从头重写，不要删除无关功能，不要改变整体设计风格（除非用户明确要求）。',
    '',
    '【输出要求】',
    '只返回一个完整的、可以直接运行的 HTML 文件（内嵌所有 style 和 script）。',
    '不要 markdown 代码块，不要解释文字，直接以 <!DOCTYPE html> 开头。',
    '修改后必须保证 CSS、HTML、JS 三者完全对应一致，不能有任何错位。',
    '页面要美观、现代、响应式。',
    '',
    '【现有代码】',
    ctx.html,
    '【代码结束】'
  ].join('\n');
}

/* ================= 工程管理 ================= */
function loadProjects(){
  try{ var raw = localStorage.getItem('cu-projects'); if(raw) state.projects = JSON.parse(raw) || []; }catch(e){ state.projects = []; }
  var activeRaw = localStorage.getItem('cu-active-project'); if(activeRaw) state.activeProjectId = activeRaw;
  if(state.projects.length === 0){ var p = newProjectData('我的第一个工程'); state.projects.push(p); state.activeProjectId = p.id; }
  if(!state.activeProjectId || !state.projects.some(function(x){ return x.id === state.activeProjectId; })) state.activeProjectId = state.projects[0].id;
  saveProjects();
}
function newProjectData(name){
  return {
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: name || '未命名工程', createdAt: Date.now(), updatedAt: Date.now(),
    components: [{ name: '页面结构', type: 'html', code: '<div style="min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#1a1a20,#050506 60%);color:#e8ecf4;font-family:system-ui,sans-serif;text-align:center;padding:20px"><div><div style="width:76px;height:76px;border-radius:24px;margin:0 auto 22px;display:grid;place-items:center;font-size:34px;background:linear-gradient(135deg,#3a3a42,#1a1a20);border:1px solid rgba(255,255,255,.12)">✦</div><h1 style="font-size:22px;margin-bottom:10px">Code Utopia</h1><p style="color:#8b94a8;font-size:13.5px;line-height:1.7;max-width:420px;margin:0 auto">在对话页描述页面，AI 会生成代码并在这里预览。</p></div></div>', enabled: true }],
    history: [], historyIndex: -1
  };
}
function saveProjects(){
  try{ localStorage.setItem('cu-projects', JSON.stringify(state.projects)); }catch(e){}
  try{ localStorage.setItem('cu-active-project', state.activeProjectId); }catch(e){}
}
function getActiveProject(){ for(var i = 0; i < state.projects.length; i++){ if(state.projects[i].id === state.activeProjectId) return state.projects[i]; } return null; }
function openProjects(){ renderProjects(); $('projectsView').classList.add('show'); }
function closeProjects(){ $('projectsView').classList.remove('show'); }
function renderProjects(){
  var q = ($('projSearch').value || '').toLowerCase();
  var grid = $('projGrid');
  var list = state.projects.filter(function(p){ return !q || p.name.toLowerCase().indexOf(q) >= 0; });
  list.sort(function(a, b){ return b.updatedAt - a.updatedAt; });
  var projIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
  var html = '';
  for(var i = 0; i < list.length; i++){
    var p = list[i];
    var active = p.id === state.activeProjectId ? ' active' : '';
    var d = new Date(p.updatedAt);
    var time = d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2) + ' ' + ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2);
    html += '<div class="proj-card' + active + '" onclick="switchProject(\'' + p.id + '\')">' +
      '<button class="del" onclick="event.stopPropagation();deleteProject(\'' + p.id + '\')" title="删除">✕</button>' +
      '<div class="pemoji">' + projIconSvg + '</div>' +
      '<h3>' + esc(p.name) + '</h3>' +
      '<div class="meta">' + (p.components || []).length + ' 个组件 · ' + (p.history || []).length + ' 个版本<br>' + time + '</div>' +
      '</div>';
  }
  html += '<div class="new-proj" onclick="createProject()"><div class="plus">＋</div><span>新建工程</span></div>';
  if(list.length === 0 && q) html = '<div class="pv-empty" style="grid-column:1/-1">没有匹配「' + esc(q) + '」的工程</div>' + html;
  grid.innerHTML = html;
}
function createProject(){
  var name = prompt('新工程名称：', '新工程'); if(name === null) return;
  name = name.trim() || '新工程';
  var p = newProjectData(name);
  state.projects.push(p);
  state.activeProjectId = p.id;
  saveProjects();
  loadActiveProjectIntoState();
  renderProjects();
  closeProjects();
}
function switchProject(id){
  if(id === state.activeProjectId){ closeProjects(); return; }
  saveCurrentProject();
  state.activeProjectId = id;
  saveProjects();
  loadActiveProjectIntoState();
  closeProjects();
  addMsg('assistant', '已切换到工程：' + (getActiveProject() || {}).name, '');
}
function deleteProject(id){
  var p = null;
  for(var i = 0; i < state.projects.length; i++){ if(state.projects[i].id === id){ p = state.projects[i]; break; } }
  if(!p) return;
  if(!confirm('确定删除工程「' + p.name + '」？')) return;
  state.projects = state.projects.filter(function(x){ return x.id !== id; });
  if(state.activeProjectId === id){
    if(state.projects.length > 0) state.activeProjectId = state.projects[0].id;
    else { var np = newProjectData('我的第一个工程'); state.projects.push(np); state.activeProjectId = np.id; }
    loadActiveProjectIntoState();
  }
  saveProjects();
  renderProjects();
}
function saveCurrentProject(){
  var p = getActiveProject(); if(!p) return;
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  p.components = state.components;
  p.history = state.history;
  p.historyIndex = state.historyIndex;
  p.updatedAt = Date.now();
  saveProjects();
}
function loadActiveProjectIntoState(){
  var p = getActiveProject(); if(!p) return;
  state.components = p.components || [];
  if(state.components.length === 0) state.components = [{ name: '页面结构', type: 'html', code: '', enabled: true }];
  state.activeComp = 0;
  state.history = p.history || [];
  state.historyIndex = typeof p.historyIndex === 'number' ? p.historyIndex : state.history.length - 1;
  setEditorValue(getActiveCompCode(), compLang(state.components[0]));
  renderComponents();
  renderHistory();
  refreshPreview();
}

/* ================= 组合预览 ================= */
function compLang(c){ if(!c) return 'html'; return c.type === 'css' ? 'css' : (c.type === 'js' ? 'javascript' : 'html'); }
function buildPreviewHtml(){
  var htmlParts = '', cssParts = '', jsParts = '';
  for(var i = 0; i < state.components.length; i++){
    var c = state.components[i]; if(!c.enabled) continue;
    if(c.type === 'html') htmlParts += '\n' + c.code + '\n';
    else if(c.type === 'css') cssParts += '\n' + c.code + '\n';
    else if(c.type === 'js') jsParts += '\n' + c.code + '\n';
  }
  var hasDoc = /<html[\s>]/i.test(htmlParts);
  if(hasDoc){
    var out = htmlParts;
    if(cssParts) out = out.replace(/<\/head>/i, '<style>\n' + cssParts + '\n</style>\n</head>');
    if(jsParts && out.indexOf('</body>') >= 0) out = out.replace(/<\/body>/i, '<script>\n' + jsParts + '\n<' + '/script>\n</body>');
    return out;
  }
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>\n' + cssParts + '\n</style></head><body>\n' + htmlParts + '\n<script>\n' + jsParts + '\n<' + '/script>\n</body></html>';
}
function refreshPreview(){ $('preview').srcdoc = buildPreviewHtml(); }

function setConn(type, text){
  var el = $('conn');
  el.className = 'conn ' + type;
  el.querySelector('.txt').textContent = text;
}
function updateMode(){
  var live = $('apiKey').value.trim().length > 0 && state.connected;
  var tag = $('modeTag');
  tag.textContent = live ? '真实 API' : '演示模式';
  tag.className = 'tag' + (live ? ' live' : '');
}
function addMsg(role, text, sub){
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  var iconUser = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  var iconAI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
  div.innerHTML = '<div class="av">' + (role==='user' ? iconUser : iconAI) + '</div><div class="bubble"></div>';
  var b = div.querySelector('.bubble');
  b.textContent = text;
  if(sub){ var s = document.createElement('span'); s.className='sub'; s.textContent = sub; b.appendChild(s); }
  $('msgs').appendChild(div);
  $('msgs').scrollTop = $('msgs').scrollHeight;
  if(isMobile() && state.mobileTab !== 'chat' && role === 'assistant'){
    var badge = $('chatBadge');
    if(badge) badge.classList.add('show');
  }
}

/* ================= 密钥管理 ================= */
function loadKeyProfiles(){
  try{ var raw = localStorage.getItem('cu-keys'); if(raw) state.keyProfiles = JSON.parse(raw) || []; }catch(e){ state.keyProfiles = []; }
  if(state.keyProfiles.length === 0){
    try{
      var old = JSON.parse(localStorage.getItem('cu-cfg') || '{}');
      if(old.apiKey) state.keyProfiles.push({ name: '默认配置', baseUrl: old.baseUrl || 'https://api.deepseek.com/v1', apiKey: old.apiKey, model: old.model || '' });
    }catch(e){}
  }
  renderKeySelect();
  if(state.keyProfiles.length > 0) switchKeyProfile('0');
}
function saveKeyProfiles(){ try{ localStorage.setItem('cu-keys', JSON.stringify(state.keyProfiles)); }catch(e){} }
function renderKeySelect(){
  var sel = $('keySelect');
  var html = '<option value="">— 选择配置 —</option>';
  for(var i = 0; i < state.keyProfiles.length; i++) html += '<option value="' + i + '">' + esc(state.keyProfiles[i].name || ('配置 ' + (i+1))) + '</option>';
  sel.innerHTML = html;
  if(state.activeProfile >= 0) sel.value = String(state.activeProfile);
}
function switchKeyProfile(idx){
  if(idx === '' || idx === null){ state.activeProfile = -1; return; }
  var i = parseInt(idx, 10);
  if(isNaN(i) || !state.keyProfiles[i]) return;
  state.activeProfile = i;
  var p = state.keyProfiles[i];
  $('profileName').value = p.name || '';
  $('baseUrl').value = p.baseUrl || '';
  $('apiKey').value = p.apiKey || '';
  state.connected = false;
  state.allModels = [];
  $('model').innerHTML = '<option value="">先测试连接</option>';
  $('model').disabled = true;
  state.currentModel = p.model || '';
  if(p.model && p.model.length){
    state.allModels = [p.model];
    $('model').innerHTML = '<option value="' + esc(p.model) + '">' + esc(p.model) + '</option>';
    $('model').value = p.model;
    $('model').disabled = false;
  }
  setConn('', '已切换配置');
  updateMode();
  renderKeySelect();
}
function newKeyProfile(){
  state.keyProfiles.push({ name: '新配置', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: '' });
  state.activeProfile = state.keyProfiles.length - 1;
  saveKeyProfiles();
  switchKeyProfile(state.activeProfile);
  $('profileName').focus();
}
function saveKeyProfile(ev){
  if(state.activeProfile < 0){ state.keyProfiles.push({}); state.activeProfile = state.keyProfiles.length - 1; }
  var p = state.keyProfiles[state.activeProfile];
  p.name = $('profileName').value.trim() || ('配置 ' + (state.activeProfile + 1));
  p.baseUrl = $('baseUrl').value.trim();
  p.apiKey = $('apiKey').value.trim();
  p.model = $('model').value || state.currentModel || p.model || '';
  saveKeyProfiles();
  renderKeySelect();
  var btn = (ev && ev.target) || (window.event && window.event.target);
  if(btn){ var old = btn.innerHTML; btn.innerHTML = '✓ 已保存'; setTimeout(function(){ btn.innerHTML = old; }, 1200); }
  setConn('ok', '配置已保存（含模型）');
  updateMode();
}
function deleteKeyProfile(){
  if(state.activeProfile < 0) return;
  if(!confirm('确定删除「' + (state.keyProfiles[state.activeProfile].name || '该配置') + '」？')) return;
  state.keyProfiles.splice(state.activeProfile, 1);
  state.activeProfile = state.keyProfiles.length > 0 ? 0 : -1;
  saveKeyProfiles();
  if(state.activeProfile >= 0) switchKeyProfile(state.activeProfile);
  else {
    renderKeySelect();
    $('profileName').value = ''; $('baseUrl').value = 'https://api.deepseek.com/v1'; $('apiKey').value = '';
    $('model').innerHTML = '<option value="">先测试连接</option>'; $('model').disabled = true;
    setConn('', '未连接');
  }
}

/* ================= 模型搜索 ================= */
function populateModels(list){
  state.allModels = list.slice();
  var sel = $('model');
  var html = '';
  for(var i = 0; i < list.length; i++) html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
  sel.innerHTML = html || '<option value="">无可用模型</option>';
  sel.disabled = list.length === 0;
  $('modelCount').textContent = '(' + list.length + ' 个)';
  $('modelFilter').style.display = list.length > 6 ? 'block' : 'none';
  $('modelFilter').value = '';
  $('modelFilterClear').style.display = 'none';

  var currentSel = state.currentModel || '';
  var savedModel = state.keyProfiles[state.activeProfile] ? (state.keyProfiles[state.activeProfile].model || '') : '';
  var finalModel = '';
  if(currentSel && list.indexOf(currentSel) >= 0) finalModel = currentSel;
  else if(savedModel && list.indexOf(savedModel) >= 0) finalModel = savedModel;
  else {
    var prefer = list.find(function(m){ return /gpt-4o|deepseek-chat|qwen-plus|claude-3/i.test(m); });
    finalModel = prefer || list[0] || '';
  }
  if(finalModel) sel.value = finalModel;
  state.currentModel = sel.value;

  if(state.activeProfile >= 0 && state.keyProfiles[state.activeProfile] && state.currentModel){
    state.keyProfiles[state.activeProfile].model = state.currentModel;
    saveKeyProfiles();
  }
}
function filterModels(){
  var q = $('modelFilter').value.trim().toLowerCase();
  $('modelFilterClear').style.display = q ? 'block' : 'none';
  var list = state.allModels.filter(function(m){ return !q || m.toLowerCase().indexOf(q) >= 0; });
  var sel = $('model');
  var cur = sel.value;
  var html = '';
  for(var i = 0; i < list.length; i++) html += '<option value="' + esc(list[i]) + '">' + esc(list[i]) + '</option>';
  sel.innerHTML = html || '<option value="">无匹配模型</option>';
  if(list.indexOf(cur) >= 0) sel.value = cur;
  else if(list.length > 0) sel.value = list[0];
  $('modelCount').textContent = '(' + list.length + '/' + state.allModels.length + ')';
}
function clearModelFilter(){ $('modelFilter').value = ''; filterModels(); }

/* ================= Monaco ================= */
function initEditor(){
  if(typeof require === 'undefined'){
    $('fallbackTa').style.display = 'block';
    $('editor').style.display = 'none';
    $('fallbackTa').value = getActiveCompCode();
    $('fallbackTa').addEventListener('input', function(){ setActiveCompCode(this.value); debouncePreview(); });
    return;
  }
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], function(){
    $('editor').innerHTML = '';
    state.editor = monaco.editor.create($('editor'), {
      value: getActiveCompCode(),
      language: compLang(state.components[state.activeComp]),
      theme: 'vs-dark', automaticLayout: true, fontSize: 13,
      minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: 'on',
      tabSize: 2, lineNumbers: 'on', fontFamily: 'Consolas, "Cascadia Code", monospace',
      padding: { top: 12 }
    });
    state.editorReady = true;
    state.editor.onDidChangeModelContent(function(){
      if(state.isProgrammaticChange) return;
      setActiveCompCode(state.editor.getValue());
      debouncePreview();
    });
    // 长按菜单
    bindLongPress($('editor'));
    console.log('✅ Monaco 就绪');
  });
}
function getActiveCompCode(){ var c = state.components[state.activeComp]; return c ? (c.code || '') : ''; }
function setActiveCompCode(val){ var c = state.components[state.activeComp]; if(c) c.code = val; }
function getEditorValue(){ return state.editorReady ? state.editor.getValue() : $('fallbackTa').value; }
function setEditorValue(val, lang){
  state.isProgrammaticChange = true;
  if(state.editorReady){
    if(lang) monaco.editor.setModelLanguage(state.editor.getModel(), lang);
    state.editor.setValue(val || '');
  } else { $('fallbackTa').value = val || ''; }
  state.isProgrammaticChange = false;
}
var previewTimer;
function debouncePreview(){ clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 500); }

/* ================= 组件管理 ================= */
function renderComponents(){
  var list = $('compList');
  var html = '';
  for(var i = 0; i < state.components.length; i++){
    var c = state.components[i];
    var cls = 'comp-item' + (i === state.activeComp ? ' active' : '') + (c.enabled ? '' : ' disabled');
    html += '<div class="' + cls + '" onclick="selectComponent(' + i + ')" ondblclick="toggleComponentAt(' + i + ')">' +
      '<span class="cdot"></span><span class="cname">' + esc(c.name || '未命名') + '</span>' +
      '<span class="ctype ' + c.type + '">' + c.type.toUpperCase() + '</span></div>';
  }
  if(state.components.length === 0) html = '<div style="padding:20px 10px;text-align:center;color:#5a6478;font-size:11px">还没有组件</div>';
  list.innerHTML = html;
  $('compCount').textContent = '(' + state.components.length + ')';
  var c = state.components[state.activeComp];
  if(c){ $('compName').value = c.name || ''; $('compType').value = c.type; $('compOrder').textContent = (state.activeComp + 1) + ' / ' + state.components.length; }
  else { $('compName').value = ''; $('compOrder').textContent = ''; }
}
function selectComponent(i){
  if(i < 0 || i >= state.components.length) return;
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  state.activeComp = i;
  setEditorValue(state.components[i].code || '', compLang(state.components[i]));
  renderComponents();
}
function addComponent(){
  state.components.push({ name: '新组件', type: 'html', code: '', enabled: true });
  state.activeComp = state.components.length - 1;
  setEditorValue('', 'html');
  renderComponents();
  $('compName').focus(); $('compName').select();
}
function deleteComponent(){
  if(state.components.length === 0) return;
  var c = state.components[state.activeComp];
  if(!confirm('确定删除「' + (c.name || '该组件') + '」？')) return;
  state.components.splice(state.activeComp, 1);
  if(state.activeComp >= state.components.length) state.activeComp = state.components.length - 1;
  var nc = state.components[state.activeComp];
  setEditorValue(nc ? nc.code : '', compLang(nc));
  renderComponents();
  refreshPreview();
}
function toggleComponent(){ if(state.components[state.activeComp]) toggleComponentAt(state.activeComp); }
function toggleComponentAt(i){
  if(!state.components[i]) return;
  state.components[i].enabled = !state.components[i].enabled;
  renderComponents();
  refreshPreview();
}
function renameComponent(val){ var c = state.components[state.activeComp]; if(c){ c.name = val; renderComponents(); } }
function changeComponentType(val){
  var c = state.components[state.activeComp];
  if(c){ c.type = val; setEditorValue(getEditorValue(), compLang(c)); renderComponents(); }
}
function moveComponent(dir){
  var i = state.activeComp, j = i + dir;
  if(j < 0 || j >= state.components.length) return;
  var tmp = state.components[i];
  state.components[i] = state.components[j];
  state.components[j] = tmp;
  state.activeComp = j;
  renderComponents();
  refreshPreview();
}

/* ================= 合并为单个 HTML ================= */
function mergeToSingleHtml(){
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  var merged = buildPreviewHtml();
  state.components = [{ name: '完整页面', type: 'html', code: merged, enabled: true }];
  state.activeComp = 0;
  setEditorValue(merged, 'html');
  renderComponents();
  refreshPreview();
  addMsg('assistant', '✅ 所有组件已合并成一个完整 HTML 文件。', '现在编辑这一个文件即可，CSS/JS 都已内联。');
}

/* ================= 智能重分区 ================= */
function resplitComponents(){
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  // 先合并成完整 HTML 再拆
  var merged = buildPreviewHtml();
  var comps = smartSplit(merged);
  if(comps.length === 0){ addMsg('assistant', '没有识别到可分区的内容。'); return; }
  state.components = comps;
  state.activeComp = 0;
  setEditorValue(getActiveCompCode(), compLang(comps[0]));
  renderComponents();
  refreshPreview();
  var summary = comps.map(function(c){ return c.name + ' (' + c.type.toUpperCase() + ')'; }).join(' · ');
  addMsg('assistant', '已重新分区为 ' + comps.length + ' 个组件。', summary);
}

/* ================= 历史 ================= */
function renderHistory(){
  var list = $('histList');
  if(state.history.length === 0){ list.innerHTML = '<div class="hist-empty">还没有历史版本。<br>生成一次页面或点「快照」后出现。</div>'; return; }
  var html = '';
  for(var i = state.history.length - 1; i >= 0; i--){
    var item = state.history[i];
    var d = new Date(item.time);
    var time = ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2) + ':' + ('0'+d.getSeconds()).slice(-2);
    var cls = i === state.historyIndex ? 'current' : '';
    html += '<div class="hist-item ' + cls + '" onclick="restoreHistory(' + i + ')">' +
      '<div class="v">v' + item.version + (i === state.historyIndex ? ' · 当前' : '') + '</div>' +
      '<div class="p">' + esc(item.prompt || '').slice(0, 80) + '</div>' +
      '<div class="t">' + time + ' · ' + (item.components || []).length + ' 个组件</div></div>';
  }
  list.innerHTML = html;
}
function snapshot(prompt){
  var comps = [];
  for(var i = 0; i < state.components.length; i++){
    var c = state.components[i];
    comps.push({ name: c.name, type: c.type, code: (i === state.activeComp && state.editorReady) ? getEditorValue() : c.code, enabled: c.enabled });
  }
  state.history.push({ prompt: prompt || '(手动快照)', components: comps, time: Date.now(), version: state.history.length + 1 });
  if(state.history.length > 30) state.history = state.history.slice(-30);
  state.historyIndex = state.history.length - 1;
  renderHistory();
  saveCurrentProject();
}
function manualSnapshot(){
  snapshot('📌 手动存快照');
  var b = $('snapBtn'); b.classList.add('ok');
  var old = b.innerHTML; b.innerHTML = '✓ 已保存';
  setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400);
}
function restoreHistory(i){
  if(!state.history[i]) return;
  var item = state.history[i];
  state.historyIndex = i;
  state.components = [];
  var src = item.components || [];
  for(var k = 0; k < src.length; k++) state.components.push({ name: src[k].name, type: src[k].type, code: src[k].code, enabled: src[k].enabled !== false });
  state.activeComp = 0;
  var nc = state.components[0];
  setEditorValue(nc ? nc.code : '', compLang(nc));
  renderComponents();
  refreshPreview();
  renderHistory();
  saveCurrentProject();
  addMsg('assistant', '已回滚到 v' + item.version, item.prompt || '');
  if(isMobile()) switchMobileTab('preview');
}
function toggleHistory(){ $('hist').classList.toggle('show'); }

/* ================= 代码搜索 ================= */
function toggleSearch(){
  var bar = $('searchBar');
  var showing = bar.classList.toggle('show');
  if(showing){ $('searchInput').focus(); }
  else { clearSearchHighlight(); }
}
function doSearch(q){
  if(!q || !q.trim()){
    $('searchCount').textContent = '0/0';
    state.searchResults = [];
    return;
  }
  state.searchResults = [];
  for(var i = 0; i < state.components.length; i++){
    var code = (i === state.activeComp && state.editorReady) ? getEditorValue() : (state.components[i].code || '');
    var lower = code.toLowerCase();
    var query = q.toLowerCase();
    var idx = 0;
    while((idx = lower.indexOf(query, idx)) >= 0){
      state.searchResults.push({ comp: i, start: idx, end: idx + query.length, text: code.slice(idx, idx + query.length) });
      idx += query.length;
    }
  }
  state.searchIndex = 0;
  $('searchCount').textContent = state.searchResults.length > 0 ? (1 + '/' + state.searchResults.length) : '0/0';
  if(state.searchResults.length > 0) gotoSearchResult(0);
}
function searchNav(dir){
  if(state.searchResults.length === 0) return;
  state.searchIndex = (state.searchIndex + dir + state.searchResults.length) % state.searchResults.length;
  $('searchCount').textContent = (state.searchIndex + 1) + '/' + state.searchResults.length;
  gotoSearchResult(state.searchIndex);
}
function gotoSearchResult(idx){
  var r = state.searchResults[idx];
  if(!r) return;
  if(state.activeComp !== r.comp) selectComponent(r.comp);
  setTimeout(function(){
    if(state.editorReady){
      var model = state.editor.getModel();
      var pos = model.getPositionAt(r.start);
      state.editor.revealPositionInCenter(pos);
      state.editor.setPosition(pos);
      state.editor.focus();
      // 选中
      var endPos = model.getPositionAt(r.end);
      state.editor.setSelection({ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: endPos.lineNumber, endColumn: endPos.column });
    }
  }, 100);
}
function searchKeydown(e){
  if(e.key === 'Enter'){ e.preventDefault(); searchNav(e.shiftKey ? -1 : 1); }
  else if(e.key === 'Escape'){ toggleSearch(); }
}
function clearSearchHighlight(){ $('searchCount').textContent = '0/0'; state.searchResults = []; }

/* ================= 换色板 ================= */
var COLOR_PALETTES = [
  { name: '深空黑', primary: '#0a0a0f', secondary: '#1a1a24', accent: '#6d5cff', text: '#e8ecf4' },
  { name: '纯净白', primary: '#ffffff', secondary: '#f5f5f7', accent: '#0066cc', text: '#1a1a1a' },
  { name: '暖橙', primary: '#1a0f08', secondary: '#2d1a0f', accent: '#ff6b35', text: '#fff5eb' },
  { name: '森绿', primary: '#0a1a0f', secondary: '#0f2d1a', accent: '#22c55e', text: '#ebfff5' },
  { name: '海洋蓝', primary: '#0a1220', secondary: '#0f1a30', accent: '#3b82f6', text: '#ebf3ff' },
  { name: '玫瑰粉', primary: '#1a0a12', secondary: '#2d0f1a', accent: '#ec4899', text: '#fff0f5' },
  { name: '莫兰迪', primary: '#f0ebe3', secondary: '#e8e0d5', accent: '#8b7d6b', text: '#3d3529' },
  { name: '赛博朋克', primary: '#0a0a0a', secondary: '#1a0a1a', accent: '#ff00ff', text: '#00ffcc' },
  { name: '日落', primary: '#2d1810', secondary: '#4a2515', accent: '#ff8c42', text: '#fff2e6' },
  { name: '极简灰', primary: '#1a1a1a', secondary: '#2a2a2a', accent: '#999999', text: '#e8e8e8' }
];
function showColorPalette(){
  var row = $('colorPaletteRow');
  row.innerHTML = '';
  for(var i = 0; i < COLOR_PALETTES.length; i++){
    var p = COLOR_PALETTES[i];
    var sw = document.createElement('div');
    sw.className = 'color-swatch';
    sw.title = p.name;
    sw.style.background = p.primary;
    sw.innerHTML = '<div style="background:linear-gradient(135deg,' + p.secondary + ',' + p.accent + ')"></div>';
    (function(pal){
      sw.addEventListener('click', function(){ applyPalette(pal); });
    })(p);
    row.appendChild(sw);
  }
  $('colorPalette').classList.toggle('show');
}
function applyPalette(p){
  // 替换当前所有组件里的主要颜色
  var replaceInCode = function(code){
    // 常见的深色背景 → 新背景
    code = code.replace(/#0a0a0f|#0f0f14|#1a1a20|#1a1a24|#050506|#08090d/gi, p.primary);
    code = code.replace(/#3a3a42|#2a2a32|#141824|#1f2433/gi, p.secondary);
    code = code.replace(/#6d5cff|#8b5cf6|#a78bfa|#6d5cff/gi, p.accent);
    code = code.replace(/#e8ecf4|#c9d1e3|#dbe4f5/gi, p.text);
    return code;
  };
  for(var i = 0; i < state.components.length; i++){
    state.components[i].code = replaceInCode(state.components[i].code);
  }
  setEditorValue(getActiveCompCode(), compLang(state.components[state.activeComp]));
  renderComponents();
  refreshPreview();
  $('colorPalette').classList.remove('show');
  addMsg('assistant', '✅ 已应用色板：' + p.name, '主色 ' + p.accent + ' · 背景 ' + p.primary);
}

/* ================= Prompt 模板 ================= */
var PROMPT_TEMPLATES = [
  { name: '登录页', icon: 'login', prompt: '生成一个{brand}品牌的登录页，主题色{color}，{dark}风格，包含邮箱输入框、密码输入框、登录按钮、忘记密码链接。', vars: [
    { key: 'brand', label: '品牌名', default: 'Acme' },
    { key: 'color', label: '主题色', default: '紫色' },
    { key: 'dark', label: '风格', default: '深色' }
  ]},
  { name: '落地页', icon: 'landing', prompt: '生成一个{brand}产品的落地页，包含顶部导航、Hero 区（大标题+副标题+CTA 按钮）、三个特性卡片、底部 footer，主题色{color}。', vars: [
    { key: 'brand', label: '品牌名', default: 'Acme' },
    { key: 'color', label: '主题色', default: '蓝色' }
  ]},
  { name: '定价页', icon: 'pricing', prompt: '生成一个 SaaS 定价页，三档套餐（基础/专业/企业），每档包含价格、功能列表、CTA 按钮，中间档突出显示。主题色{color}。', vars: [
    { key: 'color', label: '主题色', default: '紫色' }
  ]},
  { name: '待办清单', icon: 'todo', prompt: '生成一个待办清单应用，支持添加、删除、勾选完成，带本地存储，圆角卡片风格，{dark}主题。', vars: [
    { key: 'dark', label: '风格', default: '浅色' }
  ]},
  { name: '数据仪表盘', icon: 'dash', prompt: '生成一个数据仪表盘，左侧导航栏，顶部三个数据卡片（销售额/用户/订单），下方柱状图和折线图，{dark}主题。', vars: [
    { key: 'dark', label: '风格', default: '深色' }
  ]},
  { name: '个人博客', icon: 'blog', prompt: '生成一个个人博客首页，包含作者头像、简介、文章列表（卡片式）、标签分类，{dark}主题，{color}作为强调色。', vars: [
    { key: 'dark', label: '风格', default: '浅色' },
    { key: 'color', label: '强调色', default: '橙色' }
  ]},
  { name: '联系表单', icon: 'form', prompt: '生成一个联系表单页面，包含姓名、邮箱、留言内容、提交按钮，表单下方显示公司地址和联系方式，{dark}主题。', vars: [
    { key: 'dark', label: '风格', default: '深色' }
  ]},
  { name: '产品展示', icon: 'product', prompt: '生成一个产品展示页，左侧产品大图，右侧产品名、价格、描述、加购按钮，下方三个卖点图标，主题色{color}。', vars: [
    { key: 'color', label: '主题色', default: '绿色' }
  ]}
];
function showTemplates(){
  var list = $('templateList');
  list.innerHTML = '';
  for(var i = 0; i < PROMPT_TEMPLATES.length; i++){
    var t = PROMPT_TEMPLATES[i];
    var btn = document.createElement('button');
    btn.className = 'qcard';
    btn.style.cssText = 'width:100%;text-align:left';
    btn.innerHTML = '<div class="txt"><b>' + t.name + '</b><span>' + esc(t.prompt.slice(0, 60)) + '…</span></div><span class="arrow">→</span>';
    (function(tpl){
      btn.addEventListener('click', function(){ openTemplateForm(tpl); });
    })(t);
    list.appendChild(btn);
  }
  $('templateModal').classList.add('show');
}
function closeTemplates(){ $('templateModal').classList.remove('show'); }
function openTemplateForm(t){
  state.pendingTemplate = t;
  $('templateFormTitle').textContent = t.name;
  var body = $('templateFormBody');
  body.innerHTML = '';
  for(var i = 0; i < t.vars.length; i++){
    var v = t.vars[i];
    var field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = '<label>' + v.label + '</label><input type="text" data-key="' + v.key + '" value="' + esc(v.default || '') + '">';
    body.appendChild(field);
  }
  $('templateModal').classList.remove('show');
  $('templateFormModal').classList.add('show');
}
function closeTemplateForm(){ $('templateFormModal').classList.remove('show'); state.pendingTemplate = null; }
function applyTemplate(){
  if(!state.pendingTemplate) return;
  var t = state.pendingTemplate;
  var inputs = $('templateFormBody').querySelectorAll('input');
  var vars = {};
  for(var i = 0; i < inputs.length; i++){
    vars[inputs[i].getAttribute('data-key')] = inputs[i].value.trim();
  }
  var prompt = t.prompt;
  for(var key in vars){ prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), vars[key]); }
  $('prompt').value = prompt;
  closeTemplateForm();
  generate();
}

/* ================= 快捷键面板 ================= */
var SHORTCUTS = [
  { keys: ['Ctrl', 'Enter'], desc: '生成 / 修改' },
  { keys: ['Ctrl', 'F'], desc: '搜索代码' },
  { keys: ['Ctrl', 'S'], desc: '存快照' },
  { keys: ['Ctrl', 'K'], desc: '切换工程' },
  { keys: ['Ctrl', '/'], desc: '切换 Tab' },
  { keys: ['Ctrl', 'M'], desc: '合并 HTML' },
  { keys: ['?'], desc: '快捷键面板' },
  { keys: ['Esc'], desc: '关闭弹层' }
];
function showKbdPanel(){
  var grid = $('kbdGrid');
  grid.innerHTML = '';
  for(var i = 0; i < SHORTCUTS.length; i++){
    var s = SHORTCUTS[i];
    var item = document.createElement('div');
    item.className = 'kbd-item';
    var keysHtml = '';
    for(var k = 0; k < s.keys.length; k++){
      keysHtml += '<kbd>' + s.keys[k] + '</kbd>';
      if(k < s.keys.length - 1) keysHtml += '+';
    }
    item.innerHTML = keysHtml + '<span>' + s.desc + '</span>';
    grid.appendChild(item);
  }
  $('kbdPanel').classList.add('show');
}
function closeKbdPanel(){ $('kbdPanel').classList.remove('show'); }

/* ================= 测试连接 ================= */
function testConnection(){
  var base = $('baseUrl').value.trim().replace(/\/$/, '');
  var key = $('apiKey').value.trim();
  if(!base){ setConn('err','请填写 Base URL'); return; }
  if(!key){ setConn('err','请填写 API Key'); return; }
  $('testBtn').disabled = true;
  setConn('loading','正在连接…');
  $('model').disabled = true;
  $('model').innerHTML = '<option value="">连接中…</option>';
  $('modelCount').textContent = '';
  fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } })
    .then(function(resp){ if(!resp.ok) throw new Error('HTTP ' + resp.status); return resp.json(); })
    .then(function(data){
      var list = [];
      if(Array.isArray(data.data)) list = data.data.map(function(m){ return m.id || m.name; }).filter(Boolean);
      else if(Array.isArray(data.models)) list = data.models.map(function(m){ return m.id || m.name || m; }).filter(Boolean);
      else if(Array.isArray(data)) list = data.map(function(m){ return m.id || m.name || m; }).filter(Boolean);
      if(list.length === 0) throw new Error('未返回模型列表');
      list.sort();
      populateModels(list);
      state.connected = true;
      setConn('ok', '已连接 · ' + list.length + ' 个模型可用');
      updateMode();
      if(state.activeProfile >= 0 && state.keyProfiles[state.activeProfile] && state.currentModel){
        state.keyProfiles[state.activeProfile].model = state.currentModel;
        saveKeyProfiles();
      }
    })
    .catch(function(e){
      state.connected = false;
      $('model').disabled = true;
      $('model').innerHTML = '<option value="">拉取失败</option>';
      $('modelCount').textContent = '';
      var msg = String(e.message).indexOf('Failed to fetch') >= 0
        ? '连接失败：CORS 拦截或网络错误（该服务可能不允许浏览器直连）'
        : '连接失败：' + e.message;
      setConn('err', msg);
      updateMode();
    })
    .then(function(){ $('testBtn').disabled = false; });
}

/* ================= 生成 ================= */
function generate(){
  var p = $('prompt').value.trim();
  if(!p || state.loading) return;
  if(!state.started){ $('msgs').innerHTML = ''; state.started = true; }

  var isModify = state.modifyMode;
  var ctx = isModify ? buildModifyContext() : null;
  var hasCode = ctx && ctx.html;

  addMsg('user', p, isModify ? (hasCode ? '基于当前代码修改' : '修改模式（当前代码为空）') : '');
  $('prompt').value = '';
  state.loading = true;
  $('genBtn').disabled = true;
  showContinueBtn(false);
  $('overlay').classList.add('show');
  $('overlayText').textContent = isModify ? '正在理解现有代码…' : '正在思考页面结构…';
  startTimer();

  if(isMobile()) switchMobileTab('preview');

  var useReal = $('apiKey').value.trim() && state.connected && $('model').value;

  if(useReal){
    state.abort = new AbortController();
    $('overlayText').textContent = '正在调用 ' + $('model').value + (isModify ? ' 修改代码…' : '…');
    var full = '';
    var systemPrompt = (isModify && hasCode)
      ? buildModifySystemPrompt(ctx)
      : '你是前端代码生成器。用户用自然语言描述页面，你只返回一个完整 HTML 文件（含 style 和 script），可用 CDN 引入 Tailwind。不要 markdown 代码块，不要解释，直接以 <!DOCTYPE html> 开头。页面要美观、现代、响应式。';
    var body = {
      model: $('model').value,
      temperature: (isModify && hasCode) ? 0.4 : 0.7,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }].concat(state.messages, [{ role: 'user', content: p }])
    };
    fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() },
      body: JSON.stringify(body), signal: state.abort.signal
    })
    .then(function(resp){
      if(!resp.ok) throw new Error('API ' + resp.status);
      var reader = resp.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump(){
        return reader.read().then(function(r){
          if(r.done){
            full = full.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
            state.lastRawOutput = full;
            applyGenerated(full, p, isModify);
            return;
          }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop() || '';
          for(var i = 0; i < lines.length; i++){
            var t = lines[i].trim();
            if(t.indexOf('data:') !== 0) continue;
            var d = t.slice(5).trim();
            if(d === '[DONE]') continue;
            try{
              var j = JSON.parse(d);
              var dd = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
              if(dd){ full += dd; }
            }catch(e){}
          }
          return pump();
        });
      }
      return pump();
    })
    .catch(function(e){
      if(e.name === 'AbortError') addMsg('assistant', '已停止生成。');
      else {
        var m = String(e.message).indexOf('Failed to fetch') >= 0 ? '请求失败：CORS 限制或网络问题。' : e.message;
        addMsg('assistant', '生成失败：' + m);
      }
    })
    .then(function(){
      stopTimer();
      state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); state.abort = null;
      var code = getEditorValue();
      showContinueBtn(!!(code && code.trim().length > 100));
    });
  } else {
    if(isModify && hasCode){
      $('overlayText').textContent = '演示模式无法真实修改';
      addMsg('assistant', '演示模式无法基于现有代码修改。', '请先在 API 配置里填 Key、点「测试连接」拉取模型，再打开「修改现有代码」开关。');
      stopTimer();
      state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show');
      return;
    }
    $('overlayText').textContent = '正在渲染页面…';
    var demo = pickDemo(p);
    var chunks = demo.match(/[\s\S]{1,60}/g) || [demo];
    var idx = 0, fullDemo = '';
    function next(){
      if(idx >= chunks.length){
        state.lastRawOutput = fullDemo;
        applyGenerated(fullDemo, p, false);
        stopTimer();
        state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show');
        showContinueBtn(true);
        return;
      }
      fullDemo += chunks[idx++];
      setTimeout(next, 16);
    }
    next();
  }
}

/* ================= 继续生成（常驻） ================= */
function continueGenerate(){
  if(state.loading) return;
  var currentCode = getEditorValue();
  if(!currentCode || !currentCode.trim()){
    addMsg('assistant', '当前没有可续写的代码。', '请先生成一部分代码再试。');
    return;
  }
  if(state.modifyMode){ onModifyToggle(false); }

  addMsg('user', '⏩ 继续生成后续代码', '从当前代码末尾接着写，不重复已有内容');
  state.loading = true;
  $('genBtn').disabled = true;
  showContinueBtn(false);
  $('overlay').classList.add('show');
  $('overlayText').textContent = '正在续写代码…';
  startTimer();
  if(isMobile()) switchMobileTab('preview');

  var systemPrompt = [
    '你是前端代码续写助手。用户会给你一份【已生成的代码】，你需要从末尾继续写，补全剩余部分。',
    '绝对不要重复已有代码，不要重新开始，不要输出 <!DOCTYPE html> 或 <html> 开头（除非原代码还没写到这里）。',
    '只输出需要追加的新内容，保持原有的缩进和风格。',
    '如果原代码已经接近完整，只补全缺失的闭合标签即可。',
    '不要任何解释文字，不要 markdown 代码块，直接输出后续代码。',
    '',
    '【已生成的代码】',
    currentCode,
    '--- 代码结束 ---',
    '',
    '请从上面代码的末尾继续写，输出后续部分：'
  ].join('\n');

  var useReal = $('apiKey').value.trim() && state.connected && $('model').value;

  if(useReal){
    state.abort = new AbortController();
    var appended = '';
    var body = {
      model: $('model').value,
      temperature: 0.3,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请继续补全代码' }
      ]
    };
    fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() },
      body: JSON.stringify(body), signal: state.abort.signal
    })
    .then(function(resp){
      if(!resp.ok) throw new Error('API ' + resp.status);
      var reader = resp.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump(){
        return reader.read().then(function(r){
          if(r.done){
            var merged = currentCode + appended;
            merged = merged.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
            state.lastRawOutput = merged;
            // 关键修复：合并成一个完整文件，再智能拆
            var comps = smartSplit(merged);
            state.components = comps;
            state.activeComp = 0;
            setEditorValue(getActiveCompCode(), compLang(comps[0]));
            renderComponents();
            refreshPreview();
            snapshot('⏩ 续写补全');
            var dur = stopTimer();
            addMsg('assistant', '✅ 续写完成。', '耗时 ' + dur.toFixed(1) + ' 秒 · 可继续点「继续」');
            showContinueBtn(true);
            return;
          }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop() || '';
          for(var i = 0; i < lines.length; i++){
            var t = lines[i].trim();
            if(t.indexOf('data:') !== 0) continue;
            var d = t.slice(5).trim();
            if(d === '[DONE]') continue;
            try{
              var j = JSON.parse(d);
              var dd = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || '';
              if(dd){ appended += dd; }
            }catch(e){}
          }
          return pump();
        });
      }
      return pump();
    })
    .catch(function(e){
      if(e.name === 'AbortError') addMsg('assistant', '已停止续写。');
      else addMsg('assistant', '续写失败：' + e.message);
    })
    .then(function(){
      state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); state.abort = null;
      showContinueBtn(true);
    });
  } else {
    addMsg('assistant', '演示模式无法续写代码。', '请先配置 API Key 并拉取模型。');
    stopTimer();
    state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show');
  }
}

/* ================= 应用生成结果 ================= */
function applyGenerated(html, prompt, isModify){
  var comps = smartSplit(html);
  state.components = comps;
  state.activeComp = 0;
  setEditorValue(getActiveCompCode(), compLang(comps[0]));
  renderComponents();
  refreshPreview();
  snapshot(prompt);
  state.messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: html });
  var summary = comps.map(function(c){ return c.name + ' (' + c.type.toUpperCase() + ')'; }).join(' · ');
  addMsg('assistant',
    (isModify ? '已根据你的需求修改现有代码。' : '页面已生成，已智能分区为 ' + comps.length + ' 个组件。'),
    '耗时 ' + state.lastDuration.toFixed(1) + ' 秒 · 组件：' + summary
  );
  showContinueBtn(true);
}

/* ================= 演示模板 ================= */
var CLOSE = '<' + '/script>';
var DEMOS = [
  { k:['登录','login','登陆'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-gray-900 to-slate-800 px-4"><div class="w-full max-w-md bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 border border-white/20"><h1 class="text-3xl font-bold text-white mb-2 text-center">欢迎回来</h1><p class="text-white/60 text-sm text-center mb-8">登录你的账户以继续</p><form class="space-y-5" onsubmit="event.preventDefault();alert(\'演示\')"><div><label class="block text-white/80 text-sm mb-2">邮箱</label><input type="email" placeholder="you@example.com" class="w-full px-4 py-3 rounded-lg bg-white/10 border border-white/20 text-white"></div><div><label class="block text-white/80 text-sm mb-2">密码</label><input type="password" placeholder="••••••••" class="w-full px-4 py-3 rounded-lg bg-white/10 border border-white/20 text-white"></div><button class="w-full py-3 rounded-lg bg-gray-600 hover:bg-gray-500 text-white font-semibold">登 录</button></form></div></body></html>' },
  { k:['番茄','计时','倒计时','timer','pomodoro'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900 p-4"><div class="bg-white/95 rounded-3xl shadow-2xl p-10 w-full max-w-sm text-center"><h1 class="text-xl font-semibold text-gray-500 mb-6">POMODORO</h1><div class="relative w-56 h-56 mx-auto mb-8"><svg class="transform -rotate-90 w-56 h-56"><circle cx="112" cy="112" r="100" stroke="#f1f5f9" stroke-width="12" fill="none"/><circle id="ring" cx="112" cy="112" r="100" stroke="#6b7280" stroke-width="12" fill="none"/></svg><div class="absolute inset-0 flex items-center justify-center"><span id="d" class="text-5xl font-bold">25:00</span></div></div><div class="flex gap-3 justify-center"><button id="s" class="px-6 py-2.5 rounded-full bg-gray-700 text-white">开始</button><button id="r" class="px-6 py-2.5 rounded-full bg-gray-200">重置</button></div></div><script>var t=1500,l=t,tm=null;function rn(){document.getElementById("d").textContent=String(Math.floor(l/60)).padStart(2,"0")+":"+String(l%60).padStart(2,"0")}document.getElementById("s").onclick=function(){if(tm)return;tm=setInterval(function(){if(l<=0){clearInterval(tm);tm=null;return}l--;rn()},1000)};document.getElementById("r").onclick=function(){clearInterval(tm);tm=null;l=t;rn()};rn();' + CLOSE + '</body></html>' },
  { k:['待办','todo','任务','清单'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen bg-gray-100 py-12 px-4"><div class="max-w-md mx-auto bg-white rounded-2xl shadow-lg p-6"><h1 class="text-2xl font-bold text-gray-800 mb-6">✅ 待办清单</h1><form id="f" class="flex gap-2 mb-5"><input id="t" placeholder="添加任务…" class="flex-1 px-4 py-2.5 rounded-lg border"><button class="px-5 py-2.5 rounded-lg bg-gray-700 text-white">添加</button></form><ul id="l" class="space-y-2"></ul></div><script>var it=[{text:"学习 Tailwind",done:false},{text:"构建 AI 应用",done:true}];function rn(){document.getElementById("l").innerHTML=it.map(function(x,i){return "<li class=\\"flex items-center gap-3 p-3 rounded-lg bg-gray-50\\"><input type=\\"checkbox\\" "+(x.done?"checked":"")+" onchange=\\"window.tg("+i+")\\" class=\\"w-4 h-4\\"><span class=\\"flex-1 "+(x.done?"line-through text-gray-400":"")+"\\">"+x.text+"</span></li>"}).join("")}window.tg=function(i){it[i].done=!it[i].done;rn()};document.getElementById("f").onsubmit=function(e){e.preventDefault();var v=document.getElementById("t").value.trim();if(!v)return;it.push({text:v,done:false});document.getElementById("t").value="";rn()};rn();' + CLOSE + '</body></html>' },
  { k:['仪表','dashboard','数据','图表','admin'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen bg-gray-100"><div class="flex flex-col md:flex-row"><aside class="w-full md:w-56 md:min-h-screen bg-gray-900 text-white p-5"><h1 class="text-xl font-bold mb-8">📊 Admin</h1><nav class="space-y-1 text-sm"><a class="block px-3 py-2 rounded-lg bg-gray-700">仪表盘</a><a class="block px-3 py-2 rounded-lg">订单</a></nav></aside><main class="flex-1 p-6 md:p-8"><h2 class="text-2xl font-bold mb-6">数据概览</h2><div class="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8"><div class="bg-white p-5 rounded-xl shadow"><p class="text-gray-500 text-sm">今日销售额</p><p class="text-3xl font-bold mt-2">¥ 12,480</p></div><div class="bg-white p-5 rounded-xl shadow"><p class="text-gray-500 text-sm">新增用户</p><p class="text-3xl font-bold mt-2">+ 128</p></div><div class="bg-white p-5 rounded-xl shadow"><p class="text-gray-500 text-sm">订单数</p><p class="text-3xl font-bold mt-2">342</p></div></div></main></div></body></html>' }
];
function pickDemo(p){
  var pl = p.toLowerCase();
  for(var i = 0; i < DEMOS.length; i++) for(var j = 0; j < DEMOS[i].k.length; j++) if(pl.indexOf(DEMOS[i].k[j]) >= 0) return DEMOS[i].h;
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900 p-8"><div class="bg-white rounded-2xl shadow-2xl p-10 max-w-lg"><div class="text-4xl mb-4">🤖</div><h1 class="text-2xl font-bold text-gray-800 mb-3">演示模式</h1><p class="text-gray-600 mb-4">你的需求：</p><blockquote class="border-l-4 border-gray-400 pl-4 italic mb-5">' + esc(p) + '</blockquote><p class="text-sm text-gray-500">内置演示模板。连接真实 API 后可生成任意页面。</p></div></body></html>';
}

/* ================= 复制/下载/格式化 ================= */
function copyCode(){
  var b = $('copyBtn'); var ta = getEditorValue();
  function fallback(){
    var tmp = document.createElement('textarea'); tmp.value = ta;
    document.body.appendChild(tmp); tmp.select();
    try{ document.execCommand('copy'); b.classList.add('ok'); var old = b.innerHTML; b.innerHTML = '✓ 已复制'; setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400); }
    catch(e){}
    document.body.removeChild(tmp);
  }
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(ta).then(function(){
        b.classList.add('ok'); var old = b.innerHTML; b.innerHTML = '✓ 已复制';
        setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400);
      }).catch(fallback);
    } else fallback();
  }catch(e){ fallback(); }
}
function downloadZip(){
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  var htmlParts = '', cssParts = '', jsParts = '';
  for(var i = 0; i < state.components.length; i++){
    var c = state.components[i]; if(!c.enabled) continue;
    if(c.type === 'html') htmlParts += '\n' + c.code + '\n';
    else if(c.type === 'css') cssParts += '\n' + c.code + '\n';
    else if(c.type === 'js') jsParts += '\n' + c.code + '\n';
  }
  if(typeof JSZip === 'undefined'){
    var blob = new Blob([getEditorValue()], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'component.txt';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000); return;
  }
  var zip = new JSZip();
  var finalHtml = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>' + esc((getActiveProject() || {}).name || 'Code Utopia') + '</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n' + htmlParts + '\n<script src="script.js"><' + '/script>\n</body>\n</html>';
  zip.file('index.html', finalHtml);
  zip.file('style.css', cssParts);
  zip.file('script.js', jsParts);
  zip.file('README.md', '# ' + ((getActiveProject() || {}).name || 'Code Utopia') + '\n\n由 Code Utopia 导出。\n\n- `index.html` — 页面结构\n- `style.css` — 样式\n- `script.js` — 交互\n\n生成时间: ' + new Date().toLocaleString() + '\n');
  zip.generateAsync({ type: 'blob' }).then(function(content){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(content); a.download = ((getActiveProject() || {}).name || 'code-utopia') + '.zip';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  });
}
function formatCode(){
  var b = $('fmtBtn'); var current = getEditorValue();
  var type = state.components[state.activeComp] ? state.components[state.activeComp].type : detectLanguage(current);
  if(type === 'css'){
    var out = [], indent = 0;
    current.replace(/\s*([\{\};])\s*/g, '$1\n').split('\n').forEach(function(line){
      line = line.trim(); if(!line) return;
      if(line === '}') indent = Math.max(0, indent - 1);
      out.push('  '.repeat(indent) + line);
      if(line === '{') indent++;
    });
    var cssFormatted = out.join('\n');
    setActiveCompCode(cssFormatted); setEditorValue(cssFormatted, 'css'); refreshPreview();
    b.classList.add('ok'); var old = b.innerHTML; b.innerHTML = '✓ 已格式化';
    setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400);
    return;
  }
  var indent = 0, res = [];
  current.replace(/>\s*</g, '>\n<').split('\n').forEach(function(line){
    line = line.trim(); if(!line) return;
    if(/^<\//.test(line)) indent = Math.max(0, indent - 1);
    res.push('  '.repeat(indent) + line);
    if(/^<[^/!][^>]*[^/]>$/.test(line) && !/<\/.+>$/.test(line)) indent++;
  });
  var formatted = res.join('\n');
  setActiveCompCode(formatted); setEditorValue(formatted); refreshPreview();
  b.classList.add('ok'); var old2 = b.innerHTML; b.innerHTML = '✓ 已格式化';
  setTimeout(function(){ b.innerHTML = old2; b.classList.remove('ok'); }, 1400);
}

/* ================= 视口 ================= */
var DEVICES = {
  desktop: { w: null, h: null, label: '100% · 铺满', addr: 'preview://live' },
  tablet: { w: 768, h: 1024, label: '768 × 1024 · 平板', addr: 'preview://tablet' },
  mobile: { w: 390, h: 844, label: '390 × 844 · 手机', addr: 'preview://mobile' }
};
var currentDevice = 'desktop';
var manualSize = null;
var rotated = false;

function applyViewport(){
  var d = DEVICES[currentDevice];
  var pv = $('pv');
  var wrapW = $('pvWrap').clientWidth - 20;
  var wrapH = $('pvWrap').clientHeight - 20;
  pv.classList.remove('nosmooth');
  var w = manualSize ? manualSize.w : (d.w ? (rotated ? d.h : d.w) : null);
  var h = manualSize ? manualSize.h : (d.h ? (rotated ? d.w : d.h) : null);
  if(w){
    pv.style.width = Math.min(w, wrapW) + 'px';
    pv.style.height = h ? Math.min(h, wrapH) + 'px' : '';
    pv.style.maxWidth = '100%'; pv.style.maxHeight = '100%';
    pv.classList.add('pv-frame');
    $('vpSize').textContent = Math.round(w) + ' × ' + (h ? Math.round(h) : 'auto');
    $('addr').textContent = rotated ? d.addr + ' (landscape)' : d.addr;
  } else {
    pv.style.width = '100%'; pv.style.height = '';
    pv.style.maxWidth = '100%'; pv.style.maxHeight = '';
    pv.classList.remove('pv-frame');
    $('vpSize').textContent = d.label;
    $('addr').textContent = d.addr;
  }
  if(manualSize){ $('winW').value = manualSize.w; $('winH').value = manualSize.h; }
}
function setViewport(name){
  currentDevice = name; manualSize = null; rotated = false;
  $('vpDesktop').classList.toggle('active', name === 'desktop');
  $('vpTablet').classList.toggle('active', name === 'tablet');
  $('vpMobile').classList.toggle('active', name === 'mobile');
  if(name === 'desktop'){ $('winW').value = ''; $('winH').value = ''; }
  applyViewport();
}
function applyCustomSize(){
  var w = parseInt($('winW').value, 10);
  var h = parseInt($('winH').value, 10);
  if(!w || w < 180) return;
  manualSize = { w: w, h: h && h >= 140 ? h : null };
  applyViewport();
}
function toggleRotate(){ rotated = !rotated; applyViewport(); }
function fillPreview(){
  manualSize = null; currentDevice = 'desktop';
  $('vpDesktop').classList.add('active');
  $('vpTablet').classList.remove('active');
  $('vpMobile').classList.remove('active');
  $('winW').value = ''; $('winH').value = '';
  applyViewport();
}
function resetViewport(){
  manualSize = null; rotated = false;
  $('winW').value = ''; $('winH').value = '';
  setViewport(currentDevice);
}

/* 八向拖拽 —— 修复上下不可拖，使用 pointer capture + 遮罩 */
(function(){
  var pv = $('pv'); if(!pv) return;
  var handles = pv.querySelectorAll('.rz');
  for(var i = 0; i < handles.length; i++){
    (function(handle){
      handle.addEventListener('pointerdown', function(e){
        if(e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault(); e.stopPropagation();
        var dir = handle.getAttribute('data-dir');
        var r = pv.getBoundingClientRect();
        var start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
        manualSize = { w: Math.round(r.width), h: Math.round(r.height) };
        pv.classList.add('nosmooth');
        // 全屏遮罩，防止 iframe 抢事件
        var mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent;cursor:' + getComputedStyle(handle).cursor + ';touch-action:none';
        document.body.appendChild(mask);
        var wrapW = $('pvWrap').clientWidth - 20;
        var wrapH = $('pvWrap').clientHeight - 20;
        var activePointerId = e.pointerId;
        
        function onMove(ev){
          if(ev.pointerId !== undefined && activePointerId !== undefined && ev.pointerId !== activePointerId) return;
          var dx = ev.clientX - start.x;
          var dy = ev.clientY - start.y;
          var nw = start.w, nh = start.h;
          if(dir.indexOf('e') >= 0) nw = start.w + dx;
          if(dir.indexOf('w') >= 0) nw = start.w - dx;
          if(dir.indexOf('s') >= 0) nh = start.h + dy;
          if(dir.indexOf('n') >= 0) nh = start.h - dy;
          nw = Math.max(180, Math.min(nw, wrapW));
          nh = Math.max(140, Math.min(nh, wrapH));
          manualSize = { w: Math.round(nw), h: Math.round(nh) };
          applyViewport();
        }
        function onUp(){
          pv.classList.remove('nosmooth');
          if(mask.parentNode) mask.parentNode.removeChild(mask);
          mask.removeEventListener('pointermove', onMove);
          mask.removeEventListener('pointerup', onUp);
          mask.removeEventListener('pointercancel', onUp);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        }
        mask.addEventListener('pointermove', onMove);
        mask.addEventListener('pointerup', onUp);
        mask.addEventListener('pointercancel', onUp);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    })(handles[i]);
  }
})();

/* ================= 长按复制粘贴菜单 ================= */
function showCopyMenu(x, y, target){
  state.pasteTarget = target || null;
  var menu = $('copyMenu');
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
  menu.classList.add('show');
}
function hideCopyMenu(){
  $('copyMenu').classList.remove('show');
}
function getActiveSelectable(){
  var active = document.activeElement;
  if(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return active;
  if(state.editorReady && state.editor.hasTextFocus && state.editor.hasTextFocus()) return null; // Monaco 用自己逻辑
  return state.pasteTarget;
}
function doCopy(){
  var el = getActiveSelectable();
  var text = '';
  if(state.editorReady && state.editor.hasTextFocus && state.editor.hasTextFocus()){
    var sel = state.editor.getSelection();
    if(sel && !sel.isEmpty()) text = state.editor.getModel().getValueInRange(sel);
    else text = state.editor.getValue();
  } else if(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')){
    if(el.selectionStart !== undefined && el.selectionEnd !== undefined && el.selectionStart !== el.selectionEnd){
      text = el.value.slice(el.selectionStart, el.selectionEnd);
    } else {
      text = el.value;
    }
  } else {
    var sel2 = window.getSelection();
    if(sel2 && sel2.toString()) text = sel2.toString();
  }
  if(text){
    copyText(text);
  }
  hideCopyMenu();
}
function doCut(){
  var el = getActiveSelectable();
  if(!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')){ hideCopyMenu(); return; }
  var start = el.selectionStart || 0;
  var end = el.selectionEnd || 0;
  var text = el.value.slice(start, end);
  if(text){
    copyText(text);
    el.value = el.value.slice(0, start) + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start;
  }
  hideCopyMenu();
}
function doPaste(){
  var el = getActiveSelectable();
  if(!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')){ hideCopyMenu(); return; }
  if(navigator.clipboard && navigator.clipboard.readText){
    navigator.clipboard.readText().then(function(text){
      var start = el.selectionStart || 0;
      var end = el.selectionEnd || 0;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input'));
    }).catch(function(){});
  }
  hideCopyMenu();
}
function doSelectAll(){
  var el = getActiveSelectable();
  if(state.editorReady && state.editor.hasTextFocus && state.editor.hasTextFocus()){
    state.editor.setSelection(state.editor.getModel().getFullModelRange());
  } else if(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')){
    el.select();
  } else {
    var sel = window.getSelection();
    if(sel){ sel.selectAllChildren(document.body); }
  }
  hideCopyMenu();
}
function copyText(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).catch(function(){
      var tmp = document.createElement('textarea');
      tmp.value = text; document.body.appendChild(tmp); tmp.select();
      try{ document.execCommand('copy'); }catch(e){}
      document.body.removeChild(tmp);
    });
  } else {
    var tmp = document.createElement('textarea');
    tmp.value = text; document.body.appendChild(tmp); tmp.select();
    try{ document.execCommand('copy'); }catch(e){}
    document.body.removeChild(tmp);
  }
}
function bindLongPress(el){
  if(!el) return;
  var timer = null;
  var startX = 0, startY = 0, moved = false;
  el.addEventListener('touchstart', function(e){
    if(e.touches.length !== 1) return;
    var touch = e.touches[0];
    startX = touch.clientX; startY = touch.clientY; moved = false;
    timer = setTimeout(function(){
      if(!moved){
        var target = document.activeElement;
        showCopyMenu(touch.clientX, touch.clientY - 20, target);
        if(navigator.vibrate) navigator.vibrate(15);
      }
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', function(e){
    if(!timer) return;
    var touch = e.touches[0];
    var dx = Math.abs(touch.clientX - startX);
    var dy = Math.abs(touch.clientY - startY);
    if(dx > 10 || dy > 10){ moved = true; clearTimeout(timer); timer = null; }
  }, { passive: true });
  el.addEventListener('touchend', function(){
    if(timer){ clearTimeout(timer); timer = null; }
  });
  el.addEventListener('touchcancel', function(){
    if(timer){ clearTimeout(timer); timer = null; }
  });
}
// 在输入框和消息区也绑定
(function(){
  var targets = [$('prompt'), $('msgs'), $('fallbackTa')];
  for(var i = 0; i < targets.length; i++) if(targets[i]) bindLongPress(targets[i]);
})();
document.addEventListener('click', function(e){
  var menu = $('copyMenu');
  if(menu && menu.classList.contains('show') && !menu.contains(e.target)) hideCopyMenu();
});
document.addEventListener('touchstart', function(e){
  var menu = $('copyMenu');
  if(menu && menu.classList.contains('show') && !menu.contains(e.target)) hideCopyMenu();
}, { passive: true });

/* ================= 输入监听 + 启动 ================= */
(function(){
  var apiKey = $('apiKey'), baseUrl = $('baseUrl'), model = $('model'), profileName = $('profileName');
  function onChange(){ updateMode(); }
  if(apiKey) apiKey.addEventListener('input', onChange);
  if(baseUrl) baseUrl.addEventListener('input', onChange);
  if(model) model.addEventListener('change', function(){
    state.currentModel = model.value;
    if(state.activeProfile >= 0 && state.keyProfiles[state.activeProfile]){
      state.keyProfiles[state.activeProfile].model = model.value;
      saveKeyProfiles();
    }
  });
  if(profileName) profileName.addEventListener('input', onChange);
  var prompt = $('prompt');
  if(prompt) prompt.addEventListener('keydown', function(e){
    if(e.key === 'Enter' && (e.metaKey || e.ctrlKey)){ e.preventDefault(); generate(); }
  });
})();

/* 快捷键 */
document.addEventListener('keydown', function(e){
  if(e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.key !== '?'){
    // 输入框里不触发大部分快捷键
    if(e.key === 'Escape'){ e.target.blur(); }
    return;
  }
  var ctrl = e.ctrlKey || e.metaKey;
  if(ctrl && e.key === 'f'){ e.preventDefault(); toggleSearch(); }
  else if(ctrl && e.key === 's'){ e.preventDefault(); manualSnapshot(); }
  else if(ctrl && e.key === 'k'){ e.preventDefault(); openProjects(); }
  else if(ctrl && e.key === 'm'){ e.preventDefault(); mergeToSingleHtml(); }
  else if(ctrl && e.key === '/'){ e.preventDefault(); if(isMobile()) switchMobileTab(state.mobileTab === 'chat' ? 'code' : (state.mobileTab === 'code' ? 'preview' : 'chat')); }
  else if(e.key === '?'){ e.preventDefault(); showKbdPanel(); }
  else if(e.key === 'Escape'){
    closeTemplates();
    closeTemplateForm();
    closeKbdPanel();
    hideCopyMenu();
    $('colorPalette').classList.remove('show');
  }
});

window.addEventListener('load', function(){
  loadProjects();
  loadKeyProfiles();
  loadActiveProjectIntoState();
  initEditor();
  try{
    var savedModify = localStorage.getItem('cu-modify-mode') === '1';
    var cb = $('modifyMode');
    if(cb){ cb.checked = savedModify; onModifyToggle(savedModify); }
  }catch(e){}
  renderGuide();
  refreshPreview();
  applyViewport();
  if(isMobile()) switchMobileTab('chat');
  window.addEventListener('resize', function(){
    applyViewport();
    if(state.editorReady && isMobile() && state.mobileTab === 'code') state.editor.layout();
  });
  console.log('✅ Code Utopia 初始化完成');
});

/* ================= 引导 ================= */
function renderGuide(){
  var msgs = $('msgs'); msgs.innerHTML = '';
  var g = document.createElement('div'); g.className = 'guide';
  var iconSpark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
  var iconLogin = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  var iconTimer = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  var iconList = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
  var iconDash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
  g.innerHTML =
    '<div class="orb">' + iconSpark + '</div>' +
    '<h3>开始创造</h3>' +
    '<p>用一句话描述页面，AI 生成代码并实时预览。也可以勾选「修改现有代码」让 AI 改。</p>' +
    '<div class="steps">' +
      '<div class="step"><div class="num">1</div><div class="txt"><b>描述需求</b><br>越具体越好：配色、布局、交互</div></div>' +
      '<div class="step"><div class="num">2</div><div class="txt"><b>AI 生成代码</b><br>自动识别格式，按需分区</div></div>' +
      '<div class="step"><div class="num">3</div><div class="txt"><b>预览调整</b><br>切换设备尺寸，导出 ZIP 带走</div></div>' +
    '</div>' +
    '<div class="quick"><div class="qlabel">试试这些示例</div>' +
    '<button class="qcard" onclick="quickGen(\'生成一个深色玻璃质感的登录页\')"><span class="ic">' + iconLogin + '</span><div class="txt"><b>登录页</b><span>玻璃质感 · 品牌插画</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="quickGen(\'生成一个番茄钟计时器，圆形进度环\')"><span class="ic">' + iconTimer + '</span><div class="txt"><b>番茄钟</b><span>圆形进度 · 倒计时</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="quickGen(\'生成一个现代待办清单应用\')"><span class="ic">' + iconList + '</span><div class="txt"><b>待办清单</b><span>增删改 · 圆角卡片</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="quickGen(\'生成一个 SaaS 数据仪表盘\')"><span class="ic">' + iconDash + '</span><div class="txt"><b>数据仪表盘</b><span>导航 · 卡片 · 图表</span></div><span class="arrow">→</span></button>' +
    '</div>';
  msgs.appendChild(g);
}
function quickGen(p){ $('prompt').value = p; generate(); }
