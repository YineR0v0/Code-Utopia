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
  pendingTemplate: null, pasteTarget: null, longPressTimer: null,
  editingTemplateIdx: -1, renamingProjectId: null,
  diffMode: false, diffSelections: [],
  inspectorActive: false, inspectorTarget: null, inspectorStyles: {},
  dragSrcIdx: -1, dragOverIdx: -1,
  attachedFiles: [], favorites: [], galleryTab: 'history',
  _lastEditorUpdate: 0, _lastPreviewUpdate: 0, _streamingComp: false,
  mobileInspectorActive: false, _lastSharedUrl: '',
  _undoStack: [], _redoStack: [],
  zoomMode: false, zoomScale: 1, zoomPanX: 0, zoomPanY: 0,
  compMenuTarget: -1, compRenameTarget: -1,
  toastTimer: null
};

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function isMobile(){ return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches; }

/* ================= Toast ================= */
function toast(msg, ms){
  var t = $('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function(){ t.classList.remove('show'); }, ms || 1800);
}

/* ================= 移动端 Tab ================= */
function switchMobileTab(tab){
  state.mobileTab = tab;
  var tabs = document.querySelectorAll('.mtab');
  for(var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
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
function smartSplit(raw){
  if(!raw || !raw.trim()) return [];
  var text = raw.trim();
  text = text.replace(/^```(?:html|css|js|javascript)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  var markedParts = parseMarkedSections(text);
  if(markedParts.length > 0) return markedParts;
  var firstMark = text.search(/<!DOCTYPE|<html|<head|<body|<style|<script|@media|@keyframes|[\.\#\w\-\[\]]+\s*\{|\/\/|\/\*/i);
  if(firstMark > 0) text = text.slice(firstMark);
  var comps = [];
  var styleBlocks = [], scriptBlocks = [];
  var m;
  var styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while((m = styleRe.exec(text))) styleBlocks.push(m[1].trim());
  var scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while((m = scriptRe.exec(text))) scriptBlocks.push(m[1].trim());
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
    if(headExtras) comps.push({ name: 'Head 资源', type: 'html', code: headExtras, enabled: true });
    if(bodyContent){
      var bodyParts = splitBodyIntoSections(bodyContent);
      if(bodyParts.length > 1){ for(var i = 0; i < bodyParts.length; i++) comps.push({ name: bodyParts[i].name, type: 'html', code: bodyParts[i].code, enabled: true }); }
      else comps.push({ name: '页面结构', type: 'html', code: bodyContent, enabled: true });
    }
    for(var s = 0; s < styleBlocks.length; s++) comps.push({ name: styleBlocks.length > 1 ? ('样式 ' + (s+1)) : '样式', type: 'css', code: styleBlocks[s], enabled: true });
    for(var sc = 0; sc < scriptBlocks.length; sc++) comps.push({ name: scriptBlocks.length > 1 ? ('交互 ' + (sc+1)) : '交互', type: 'js', code: scriptBlocks[sc], enabled: true });
  } else {
    var lang = detectLanguage(text);
    if(lang === 'html'){
      var parts = splitBodyIntoSections(text);
      if(parts.length > 1){ for(var p = 0; p < parts.length; p++) comps.push({ name: parts[p].name, type: 'html', code: parts[p].code, enabled: true }); }
      else comps.push({ name: '页面结构', type: 'html', code: text, enabled: true });
    } else if(lang === 'css') comps.push({ name: '样式', type: 'css', code: text, enabled: true });
    else if(lang === 'js') comps.push({ name: '交互', type: 'js', code: text, enabled: true });
    else comps.push({ name: '页面', type: 'html', code: text, enabled: true });
  }
  if(comps.length === 0) comps.push({ name: '页面', type: detectLanguage(text), code: text, enabled: true });
  return comps;
}
function parseMarkedSections(text){
  var comps = [];
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
function splitBodyIntoSections(html){
  if(!html || !html.trim()) return [];
  var re = /<(section|main|header|footer|nav|aside|article)[^>]*>[\s\S]*?<\/\1>/gi;
  var matches = html.match(re) || [];
  if(matches.length >= 2){
    var parts = [];
    var lastPos = 0, idx = 0, match;
    while((match = re.exec(html))){
      if(match.index > lastPos){
        var before = html.slice(lastPos, match.index).trim();
        if(before) parts.push({ name: '片段 ' + (++idx), code: before });
      }
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
function buildModifyContext(){ return { html: buildPreviewHtml() }; }
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
  for(var i = 0; i < state.projects.length; i++){
    if(!state.projects[i].messages) state.projects[i].messages = [];
    if(!state.projects[i].history) state.projects[i].history = [];
    if(!state.projects[i].favorites) state.projects[i].favorites = [];
    if(!state.projects[i].gallery) state.projects[i].gallery = [];
  }
  saveProjects();
}
function newProjectData(name){
  return {
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: name || '未命名工程', createdAt: Date.now(), updatedAt: Date.now(),
    components: [{ name: '页面结构', type: 'html', code: '<div style="min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#1a1a20,#050506 60%);color:#e8ecf4;font-family:system-ui,sans-serif;text-align:center;padding:20px"><div><div style="width:76px;height:76px;border-radius:24px;margin:0 auto 22px;display:grid;place-items:center;font-size:34px;background:linear-gradient(135deg,#3a3a42,#1a1a20);border:1px solid rgba(255,255,255,.12)">✦</div><h1 style="font-size:22px;margin-bottom:10px">Code Utopia</h1><p style="color:#8b94a8;font-size:13.5px;line-height:1.7;max-width:420px;margin:0 auto">在对话页描述页面，AI 会生成代码并在这里预览。</p></div></div>', enabled: true }],
    history: [], historyIndex: -1, messages: [], favorites: [], gallery: []
  };
}
function saveProjects(){
  try{ localStorage.setItem('cu-projects', JSON.stringify(state.projects)); }catch(e){}
  try{ localStorage.setItem('cu-active-project', state.activeProjectId); }catch(e){}
}
function getActiveProject(){ for(var i = 0; i < state.projects.length; i++){ if(state.projects[i].id === state.activeProjectId) return state.projects[i]; } return null; }
function openProjects(){ renderProjects(); $('projectsView').classList.add('show'); }
function closeProjects(){ $('projectsView').classList.remove('show'); }/* ================= 全局错误提示 ================= */
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
  pendingTemplate: null, pasteTarget: null, longPressTimer: null,
  editingTemplateIdx: -1, renamingProjectId: null,
  diffMode: false, diffSelections: [],
  inspectorActive: false, inspectorTarget: null, inspectorStyles: {},
  dragSrcIdx: -1, dragOverIdx: -1,
  attachedFiles: [], favorites: [], galleryTab: 'history',
  _lastEditorUpdate: 0, _lastPreviewUpdate: 0, _streamingComp: false,
  mobileInspectorActive: false, _lastSharedUrl: '',
  _undoStack: [], _redoStack: [],
  zoomMode: false, zoomScale: 1, zoomPanX: 0, zoomPanY: 0,
  compMenuTarget: -1, compRenameTarget: -1,
  toastTimer: null
};

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function isMobile(){ return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches; }

/* ================= Toast ================= */
function toast(msg, ms){
  var t = $('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function(){ t.classList.remove('show'); }, ms || 1800);
}

/* ================= 移动端 Tab ================= */
function switchMobileTab(tab){
  state.mobileTab = tab;
  var tabs = document.querySelectorAll('.mtab');
  for(var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === tab);
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
function smartSplit(raw){
  if(!raw || !raw.trim()) return [];
  var text = raw.trim();
  text = text.replace(/^```(?:html|css|js|javascript)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  var markedParts = parseMarkedSections(text);
  if(markedParts.length > 0) return markedParts;
  var firstMark = text.search(/<!DOCTYPE|<html|<head|<body|<style|<script|@media|@keyframes|[\.\#\w\-\[\]]+\s*\{|\/\/|\/\*/i);
  if(firstMark > 0) text = text.slice(firstMark);
  var comps = [];
  var styleBlocks = [], scriptBlocks = [];
  var m;
  var styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  while((m = styleRe.exec(text))) styleBlocks.push(m[1].trim());
  var scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  while((m = scriptRe.exec(text))) scriptBlocks.push(m[1].trim());
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
    if(headExtras) comps.push({ name: 'Head 资源', type: 'html', code: headExtras, enabled: true });
    if(bodyContent){
      var bodyParts = splitBodyIntoSections(bodyContent);
      if(bodyParts.length > 1){ for(var i = 0; i < bodyParts.length; i++) comps.push({ name: bodyParts[i].name, type: 'html', code: bodyParts[i].code, enabled: true }); }
      else comps.push({ name: '页面结构', type: 'html', code: bodyContent, enabled: true });
    }
    for(var s = 0; s < styleBlocks.length; s++) comps.push({ name: styleBlocks.length > 1 ? ('样式 ' + (s+1)) : '样式', type: 'css', code: styleBlocks[s], enabled: true });
    for(var sc = 0; sc < scriptBlocks.length; sc++) comps.push({ name: scriptBlocks.length > 1 ? ('交互 ' + (sc+1)) : '交互', type: 'js', code: scriptBlocks[sc], enabled: true });
  } else {
    var lang = detectLanguage(text);
    if(lang === 'html'){
      var parts = splitBodyIntoSections(text);
      if(parts.length > 1){ for(var p = 0; p < parts.length; p++) comps.push({ name: parts[p].name, type: 'html', code: parts[p].code, enabled: true }); }
      else comps.push({ name: '页面结构', type: 'html', code: text, enabled: true });
    } else if(lang === 'css') comps.push({ name: '样式', type: 'css', code: text, enabled: true });
    else if(lang === 'js') comps.push({ name: '交互', type: 'js', code: text, enabled: true });
    else comps.push({ name: '页面', type: 'html', code: text, enabled: true });
  }
  if(comps.length === 0) comps.push({ name: '页面', type: detectLanguage(text), code: text, enabled: true });
  return comps;
}
function parseMarkedSections(text){
  var comps = [];
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
function splitBodyIntoSections(html){
  if(!html || !html.trim()) return [];
  var re = /<(section|main|header|footer|nav|aside|article)[^>]*>[\s\S]*?<\/\1>/gi;
  var matches = html.match(re) || [];
  if(matches.length >= 2){
    var parts = [];
    var lastPos = 0, idx = 0, match;
    while((match = re.exec(html))){
      if(match.index > lastPos){
        var before = html.slice(lastPos, match.index).trim();
        if(before) parts.push({ name: '片段 ' + (++idx), code: before });
      }
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
function buildModifyContext(){ return { html: buildPreviewHtml() }; }
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
  for(var i = 0; i < state.projects.length; i++){
    if(!state.projects[i].messages) state.projects[i].messages = [];
    if(!state.projects[i].history) state.projects[i].history = [];
    if(!state.projects[i].favorites) state.projects[i].favorites = [];
    if(!state.projects[i].gallery) state.projects[i].gallery = [];
  }
  saveProjects();
}
function newProjectData(name){
  return {
    id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: name || '未命名工程', createdAt: Date.now(), updatedAt: Date.now(),
    components: [{ name: '页面结构', type: 'html', code: '<div style="min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#1a1a20,#050506 60%);color:#e8ecf4;font-family:system-ui,sans-serif;text-align:center;padding:20px"><div><div style="width:76px;height:76px;border-radius:24px;margin:0 auto 22px;display:grid;place-items:center;font-size:34px;background:linear-gradient(135deg,#3a3a42,#1a1a20);border:1px solid rgba(255,255,255,.12)">✦</div><h1 style="font-size:22px;margin-bottom:10px">Code Utopia</h1><p style="color:#8b94a8;font-size:13.5px;line-height:1.7;max-width:420px;margin:0 auto">在对话页描述页面，AI 会生成代码并在这里预览。</p></div></div>', enabled: true }],
    history: [], historyIndex: -1, messages: [], favorites: [], gallery: []
  };
}
function saveProjects(){
  try{ localStorage.setItem('cu-projects', JSON.stringify(state.projects)); }catch(e){}
  try{ localStorage.setItem('cu-active-project', state.activeProjectId); }catch(e){}
}
function getActiveProject(){ for(var i = 0; i < state.projects.length; i++){ if(state.projects[i].id === state.activeProjectId) return state.projects[i]; } return null; }
function openProjects(){ renderProjects(); $('projectsView').classList.add('show'); }
function closeProjects(){ $('projectsView').classList.remove('show'); }/* ================= Monaco ================= */
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
      value: getActiveCompCode(), language: compLang(state.components[state.activeComp]),
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
    if(monaco.languages.registerCompletionItemProvider){
      try{
        monaco.languages.registerCompletionItemProvider('html', {
          triggerCharacters: ['>', '.', '#'],
          provideCompletionItems: function(model, position){
            var line = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
            var m = line.match(/([\w\-\.#>]+)$/);
            if(!m) return { suggestions: [] };
            var abbr = m[1];
            var html = expandEmmet(abbr);
            if(!html) return { suggestions: [] };
            return { suggestions: [{ label: abbr + ' → ' + html.slice(0, 30), kind: monaco.languages.CompletionItemKind.Snippet, insertText: html, range: new monaco.Range(position.lineNumber, position.column - abbr.length, position.lineNumber, position.column) }] };
          }
        });
      }catch(e){}
    }
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

function expandEmmet(abbr){
  if(!abbr || abbr.length > 40) return '';
  try{
    var tagMatch = abbr.match(/^([a-z][a-z0-9]*)?/i);
    var tag = (tagMatch && tagMatch[1]) || 'div';
    var idMatch = abbr.match(/#([\w\-]+)/);
    var classMatches = abbr.match(/\.([\w\-]+)/g) || [];
    var classes = classMatches.map(function(s){ return s.slice(1); });
    var attrs = '';
    if(idMatch) attrs += ' id="' + idMatch[1] + '"';
    if(classes.length) attrs += ' class="' + classes.join(' ') + '"';
    if(/\[.*\]/.test(abbr)){ var attrMatch = abbr.match(/\[([^\]]+)\]/); if(attrMatch) attrs += ' ' + attrMatch[1]; }
    var text = '';
    if(/\{.*\}/.test(abbr)){ var textMatch = abbr.match(/\{([^}]+)\}/); if(textMatch) text = textMatch[1]; }
    var count = 1;
    var multMatch = abbr.match(/\*(\d+)/);
    if(multMatch) count = parseInt(multMatch[1], 10);
    var voidTags = { img:1, input:1, br:1, hr:1, meta:1, link:1 };
    var out = [];
    for(var i = 0; i < count; i++){
      if(voidTags[tag]) out.push('<' + tag + attrs + ' />');
      else out.push('<' + tag + attrs + '>' + text + '</' + tag + '>');
    }
    return out.join('\n');
  }catch(e){ return ''; }
}

/* ================= 撤销/重做 ================= */
function pushUndo(){
  try{
    var code = getEditorValue();
    if(state._undoStack.length === 0 || state._undoStack[state._undoStack.length-1] !== code){
      state._undoStack.push(code);
      if(state._undoStack.length > 50) state._undoStack.shift();
      state._redoStack = [];
    }
  }catch(e){}
}
function undoCode(){
  if(state._undoStack.length <= 1){ toast('没有可撤销的操作'); return; }
  var current = state._undoStack.pop();
  state._redoStack.push(current);
  var prev = state._undoStack[state._undoStack.length - 1];
  setEditorValue(prev, compLang(state.components[state.activeComp]));
  var cur = state.components[state.activeComp];
  if(cur) cur.code = prev;
  refreshPreview();
  toast('↶ 已撤销');
}
function redoCode(){
  if(state._redoStack.length === 0){ toast('没有可重做的操作'); return; }
  var next = state._redoStack.pop();
  state._undoStack.push(next);
  setEditorValue(next, compLang(state.components[state.activeComp]));
  var cur = state.components[state.activeComp];
  if(cur) cur.code = next;
  refreshPreview();
  toast('↷ 已重做');
}

/* ================= 工具栏分组（最终版） ================= */
var TOOL_GROUP_MAP = {
  file: 'toolPanelFile',
  edit: 'toolPanelEdit',
  insert: 'toolPanelInsert',
  share: 'toolPanelShare',
  prompt: 'toolPanelPrompt'
};

function _panelInlineStyle(){
  return 'position:fixed!important;left:0!important;right:0!important;bottom:0!important;top:auto!important;' +
    'z-index:99990!important;display:flex!important;flex-wrap:wrap!important;gap:10px!important;' +
    'background:#141418!important;color:#e8ecf4!important;padding:18px 16px 24px!important;' +
    'border-top:1px solid rgba(255,255,255,.12)!important;' +
    'border-radius:20px 20px 0 0!important;' +
    'box-shadow:0 -20px 60px -16px rgba(0,0,0,.9)!important;' +
    'max-height:70vh!important;overflow-y:auto!important;min-height:160px!important;';
}

function closeAllToolPanels(){
  Object.keys(TOOL_GROUP_MAP).forEach(function(k){
    var p = $(TOOL_GROUP_MAP[k]);
    if(p){ p.classList.remove('show'); p.style.cssText = ''; }
  });
  var mask = $('toolPanelMask');
  if(mask){ mask.classList.remove('show'); mask.style.cssText = ''; }
  var btns = document.querySelectorAll('.tool-group-btn');
  for(var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
}

function toggleToolGroup(group){
  var panelId = TOOL_GROUP_MAP[group];
  var targetPanel = panelId ? $(panelId) : null;
  if(!targetPanel){ console.warn('未找到面板:', group, panelId); return; }

  var willShow = !targetPanel.classList.contains('show');

  // 先全部关闭（含清内联样式）
  closeAllToolPanels();

  if(!willShow) return; // 再次点击同一按钮 = 收起

  // 打开目标面板
  targetPanel.classList.add('show');
  targetPanel.style.cssText = _panelInlineStyle();

  var mask = $('toolPanelMask');
  if(mask){
    mask.classList.add('show');
    mask.style.cssText = 'position:fixed!important;inset:0!important;z-index:99989!important;background:rgba(0,0,0,.55)!important;display:block!important;';
  }

  // 高亮按钮
  var btns = document.querySelectorAll('.tool-group-btn');
  for(var i = 0; i < btns.length; i++){
    btns[i].classList.toggle('active', btns[i].getAttribute('data-group') === group);
  }
}

/* ================= 组件管理 ================= */
function renderComponents(){
  var list = $('compList');
  var html = '';
  for(var i = 0; i < state.components.length; i++){
    var c = state.components[i];
    var lines = (c.code || '').split('\n').length;
    var cls = 'comp-item' + (i === state.activeComp ? ' active' : '') + (c.enabled ? '' : ' disabled');
    html += '<div class="' + cls + '" data-idx="' + i + '" draggable="true" onclick="selectComponent(' + i + ')" ondblclick="toggleComponentAt(' + i + ')" oncontextmenu="openCompMenu(event,' + i + ');return false;">' +
      '<span class="drag-handle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>' +
      '<span class="cdot"></span><span class="cname">' + esc(c.name || '未命名') + '</span>' +
      '<span class="cline">' + lines + '行</span>' +
      '<span class="ctype ' + c.type + '">' + c.type.toUpperCase() + '</span></div>';
  }
  if(state.components.length === 0) html = '<div style="padding:20px 10px;text-align:center;color:#5a6478;font-size:11px">还没有组件</div>';
  list.innerHTML = html;
  $('compCount').textContent = '(' + state.components.length + ')';
  var c = state.components[state.activeComp];
  if(c){ $('compName').value = c.name || ''; $('compType').value = c.type; $('compOrder').textContent = (state.activeComp + 1) + ' / ' + state.components.length; }
  else { $('compName').value = ''; $('compOrder').textContent = ''; }
  bindComponentDrag();
  bindCompLongPress();
}
function bindComponentDrag(){
  var items = document.querySelectorAll('#compList .comp-item');
  for(var i = 0; i < items.length; i++){
    (function(el){
      el.addEventListener('dragstart', function(e){
        state.dragSrcIdx = parseInt(el.getAttribute('data-idx'), 10);
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try{ e.dataTransfer.setData('text/plain', String(state.dragSrcIdx)); }catch(err){}
      });
      el.addEventListener('dragend', function(){
        el.classList.remove('dragging');
        var all = document.querySelectorAll('#compList .comp-item');
        for(var k = 0; k < all.length; k++) all[k].classList.remove('drag-over');
      });
      el.addEventListener('dragover', function(e){
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        if(idx === state.dragSrcIdx) return;
        var all = document.querySelectorAll('#compList .comp-item');
        for(var k = 0; k < all.length; k++) all[k].classList.remove('drag-over');
        el.classList.add('drag-over');
        state.dragOverIdx = idx;
      });
      el.addEventListener('dragleave', function(){ el.classList.remove('drag-over'); });
      el.addEventListener('drop', function(e){
        e.preventDefault();
        el.classList.remove('drag-over');
        var from = state.dragSrcIdx;
        var to = parseInt(el.getAttribute('data-idx'), 10);
        if(from < 0 || to < 0 || from === to) return;
        var cur = state.components[state.activeComp];
        if(cur && state.editorReady) cur.code = getEditorValue();
        var moved = state.components.splice(from, 1)[0];
        state.components.splice(to, 0, moved);
        if(state.activeComp === from) state.activeComp = to;
        else if(state.activeComp === to) state.activeComp = from;
        else if(from < state.activeComp && to >= state.activeComp) state.activeComp--;
        else if(from > state.activeComp && to <= state.activeComp) state.activeComp++;
        setEditorValue(getActiveCompCode(), compLang(state.components[state.activeComp]));
        renderComponents();
        refreshPreview();
      });
    })(items[i]);
  }
}
function bindCompLongPress(){
  var items = document.querySelectorAll('#compList .comp-item');
  for(var i = 0; i < items.length; i++){
    (function(el){
      var timer = null, moved = false, startX = 0, startY = 0;
      el.addEventListener('touchstart', function(e){
        if(e.touches.length !== 1) return;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        moved = false;
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        timer = setTimeout(function(){
          if(!moved){
            if(navigator.vibrate) navigator.vibrate(20);
            openCompMenu({ clientX: startX, clientY: startY, preventDefault: function(){} }, idx);
          }
        }, 500);
      }, { passive: true });
      el.addEventListener('touchmove', function(e){
        if(!timer) return;
        if(Math.abs(e.touches[0].clientX - startX) > 10 || Math.abs(e.touches[0].clientY - startY) > 10){ moved = true; clearTimeout(timer); timer = null; }
      }, { passive: true });
      el.addEventListener('touchend', function(){ if(timer){ clearTimeout(timer); timer = null; } });
      el.addEventListener('touchcancel', function(){ if(timer){ clearTimeout(timer); timer = null; } });
    })(items[i]);
  }
}
function openCompMenu(e, idx){
  e.preventDefault && e.preventDefault();
  state.compMenuTarget = idx;
  var menu = $('compMenu');
  var x = e.clientX || 100, y = e.clientY || 100;
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 260) + 'px';
  menu.classList.add('show');
}
function closeCompMenu(){ $('compMenu').classList.remove('show'); }
function compMenuRename(){
  closeCompMenu();
  var c = state.components[state.compMenuTarget];
  if(!c) return;
  var name = prompt('新组件名：', c.name || '');
  if(name === null) return;
  c.name = name.trim() || '未命名';
  renderComponents();
  saveCurrentProject();
}
function compMenuDuplicate(){
  closeCompMenu();
  var i = state.compMenuTarget;
  var c = state.components[i];
  if(!c) return;
  state.components.splice(i + 1, 0, { name: (c.name || '组件') + ' 副本', type: c.type, code: c.code, enabled: c.enabled });
  state.activeComp = i + 1;
  setEditorValue(getActiveCompCode(), compLang(state.components[i+1]));
  renderComponents();
  refreshPreview();
  toast('已复制');
}
function compMenuToggle(){
  closeCompMenu();
  toggleComponentAt(state.compMenuTarget);
}
function compMenuDelete(){
  closeCompMenu();
  state.activeComp = state.compMenuTarget;
  deleteComponent();
}

function selectComponent(i){
  if(i < 0 || i >= state.components.length) return;
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  state.activeComp = i;
  setEditorValue(state.components[i].code || '', compLang(state.components[i]));
  pushUndo();
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
  var tmp = state.components[i]; state.components[i] = state.components[j]; state.components[j] = tmp;
  state.activeComp = j; renderComponents(); refreshPreview();
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
  toast('已合并');
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
    var cls = 'hist-item' + (i === state.historyIndex ? ' current' : '') + (state.diffSelections.indexOf(i) >= 0 ? ' selected' : '');
    html += '<div class="hist-item ' + cls + '" data-hidx="' + i + '" onclick="onHistoryClick(event, ' + i + ')">' +
      '<div class="sel-box ' + (state.diffMode ? 'show' : '') + '" onclick="event.stopPropagation();toggleDiffSelection(' + i + ')"></div>' +
      '<div class="v">v' + item.version + (i === state.historyIndex ? ' · 当前' : '') + '</div>' +
      '<div class="p">' + esc(item.prompt || '').slice(0, 80) + '</div>' +
      '<div class="t">' + time + ' · ' + (item.components || []).length + ' 个组件</div></div>';
  }
  list.innerHTML = html;
}
function onHistoryClick(e, i){ if(state.diffMode){ toggleDiffSelection(i); } else { restoreHistory(i); } }
function toggleDiffSelection(i){
  var idx = state.diffSelections.indexOf(i);
  if(idx >= 0) state.diffSelections.splice(idx, 1);
  else { if(state.diffSelections.length >= 2) state.diffSelections.shift(); state.diffSelections.push(i); }
  renderHistory();
  var btn = $('doDiffBtn'); if(btn) btn.disabled = state.diffSelections.length !== 2;
}
function toggleDiffMode(){
  state.diffMode = !state.diffMode;
  state.diffSelections = [];
  var btn = $('diffModeBtn'); if(btn) btn.textContent = state.diffMode ? '退出对比' : '对比';
  var doBtn = $('doDiffBtn'); if(doBtn) doBtn.disabled = true;
  renderHistory();
}
function doDiff(){
  if(state.diffSelections.length !== 2) return;
  var a = state.history[state.diffSelections[0]];
  var b = state.history[state.diffSelections[1]];
  if(!a || !b) return;
  var textA = (a.components || []).map(function(c){ return c.code; }).join('\n');
  var textB = (b.components || []).map(function(c){ return c.code; }).join('\n');
  var diff = simpleDiff(textA, textB);
  var body = $('diffBody'); body.innerHTML = '';
  for(var i = 0; i < diff.length; i++){
    var line = document.createElement('div');
    line.className = 'diff-line ' + diff[i].type;
    line.textContent = (diff[i].type === 'add' ? '+ ' : diff[i].type === 'del' ? '- ' : '  ') + diff[i].text;
    body.appendChild(line);
  }
  $('diffTitle').textContent = 'v' + a.version + ' → v' + b.version;
  $('diffView').classList.add('show');
}
function closeDiff(){ $('diffView').classList.remove('show'); }
function simpleDiff(a, b){
  var la = a.split('\n'), lb = b.split('\n'), result = [];
  var maxLen = Math.max(la.length, lb.length);
  for(var i = 0; i < maxLen; i++){
    var x = la[i], y = lb[i];
    if(x === y){ if(x !== undefined) result.push({ type: 'same', text: x }); }
    else { if(x !== undefined) result.push({ type: 'del', text: x }); if(y !== undefined) result.push({ type: 'add', text: y }); }
  }
  return result;
}
function filterHistory(q){
  q = (q || '').toLowerCase().trim();
  var items = document.querySelectorAll('#histList .hist-item');
  for(var i = 0; i < items.length; i++){
    var text = items[i].textContent.toLowerCase();
    items[i].style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
  }
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
  try{
    var genCount = parseInt(localStorage.getItem('cu-gen-count') || '0', 10) + 1;
    localStorage.setItem('cu-gen-count', String(genCount));
    if(genCount % 5 === 0){
      var p = getActiveProject();
      if(p){ if(!p.favorites) p.favorites = []; p.favorites.push({ version: p.favorites.length + 1, prompt: '⭐ 自动快照 v' + state.history.length, components: JSON.parse(JSON.stringify(comps)), time: Date.now(), historyIdx: state.historyIndex }); saveProjects(); }
    }
  }catch(e){}
}
function manualSnapshot(){
  snapshot('📌 手动存快照');
  var b = $('snapBtn'); b.classList.add('ok');
  var old = b.innerHTML; b.innerHTML = '✓ 已保存';
  setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400);
  toast('已保存快照');
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
  if(showing){ $('searchInput').focus(); } else { clearSearchHighlight(); }
}
function doSearch(q){
  if(!q || !q.trim()){ $('searchCount').textContent = '0/0'; state.searchResults = []; return; }
  state.searchResults = [];
  for(var i = 0; i < state.components.length; i++){
    var code = (i === state.activeComp && state.editorReady) ? getEditorValue() : (state.components[i].code || '');
    var lower = code.toLowerCase(), query = q.toLowerCase(), idx = 0;
    while((idx = lower.indexOf(query, idx)) >= 0){ state.searchResults.push({ comp: i, start: idx, end: idx + query.length }); idx += query.length; }
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
  var r = state.searchResults[idx]; if(!r) return;
  if(state.activeComp !== r.comp) selectComponent(r.comp);
  setTimeout(function(){
    if(state.editorReady){
      var model = state.editor.getModel();
      var pos = model.getPositionAt(r.start);
      state.editor.revealPositionInCenter(pos);
      state.editor.setPosition(pos);
      state.editor.focus();
      var endPos = model.getPositionAt(r.end);
      state.editor.setSelection({ startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: endPos.lineNumber, endColumn: endPos.column });
    }
  }, 100);
}
function searchKeydown(e){ if(e.key === 'Enter'){ e.preventDefault(); searchNav(e.shiftKey ? -1 : 1); } else if(e.key === 'Escape'){ toggleSearch(); } }
function clearSearchHighlight(){ $('searchCount').textContent = '0/0'; state.searchResults = []; }/* ================= 缩放模式 ================= */
function toggleZoomMode(){
  state.zoomMode = !state.zoomMode;
  var t1 = $('zoomToggle');
  var t2 = $('zoomToggleFloat');
  if(t1) t1.classList.toggle('active', state.zoomMode);
  if(t2) t2.classList.toggle('active', state.zoomMode);
  if(state.zoomMode){
    toast('🔍 缩放模式已开启：鼠标滚轮或双指缩放');
    applyZoomTransform();
  } else {
    state.zoomScale = 1; state.zoomPanX = 0; state.zoomPanY = 0;
    applyZoomTransform();
    toast('缩放已关闭');
  }
}
function applyZoomTransform(){
  var iframe = $('preview');
  if(!iframe) return;
  if(!state.zoomMode){
    iframe.style.transform = '';
    iframe.style.transformOrigin = '';
    return;
  }
  iframe.style.transformOrigin = 'top left';
  iframe.style.transform = 'scale(' + state.zoomScale + ') translate(' + state.zoomPanX + 'px, ' + state.zoomPanY + 'px)';
  iframe.style.width = (100 / state.zoomScale) + '%';
  iframe.style.height = (100 / state.zoomScale) + '%';
}
(function(){
  document.addEventListener('wheel', function(e){
    if(!state.zoomMode) return;
    var pv = $('pv');
    if(!pv || !pv.contains(e.target)) return;
    e.preventDefault();
    var delta = -e.deltaY * 0.001;
    state.zoomScale = Math.max(0.3, Math.min(3, state.zoomScale + delta));
    applyZoomTransform();
  }, { passive: false });
  var pv = $('pv');
  var touchStartDist = 0, touchStartScale = 1;
  if(pv){
    pv.addEventListener('touchstart', function(e){
      if(!state.zoomMode) return;
      if(e.touches.length === 2){
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        touchStartDist = Math.sqrt(dx*dx + dy*dy);
        touchStartScale = state.zoomScale;
      }
    }, { passive: true });
    pv.addEventListener('touchmove', function(e){
      if(!state.zoomMode) return;
      if(e.touches.length === 2){
        e.preventDefault();
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.sqrt(dx*dx + dy*dy);
        if(touchStartDist > 0){
          state.zoomScale = Math.max(0.3, Math.min(3, touchStartScale * (dist / touchStartDist)));
          applyZoomTransform();
        }
      }
    }, { passive: false });
  }
})();
/* ================= 截图 ================= */
function takeScreenshot(){
  var iframe = $('preview');
  if(!iframe) return;
  if(typeof html2canvas === 'undefined'){ alert('截图库未加载'); return; }
  try{
    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    html2canvas(iframeDoc.body, { backgroundColor: null, scale: 2, useCORS: true }).then(function(canvas){
      canvas.toBlob(function(blob){
        if(!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'screenshot-' + Date.now() + '.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
        addMsg('assistant', '✅ 截图已保存为 PNG。', '');
      }, 'image/png');
    });
  }catch(e){ alert('截图失败：' + e.message); }
}

/* ================= 明暗切换 ================= */
function toggleTheme(){
  var isLight = document.body.classList.toggle('light-theme');
  try{ localStorage.setItem('cu-theme', isLight ? 'light' : 'dark'); }catch(e){}
  var icon = $('themeIcon');
  if(icon){
    icon.innerHTML = isLight
      ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
  if(state.editorReady && typeof monaco !== 'undefined'){ try{ monaco.editor.setTheme(isLight ? 'vs' : 'vs-dark'); }catch(e){} }
}
function loadTheme(){
  try{
    if(localStorage.getItem('cu-theme') === 'light'){
      document.body.classList.add('light-theme');
      var icon = $('themeIcon');
      if(icon) icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    }
  }catch(e){}
}

/* ================= 下载 ================= */
function downloadSingleHtml(){
  var html = buildPreviewHtml();
  var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ((getActiveProject() || {}).name || 'page') + '.html';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  toast('已下载单 HTML');
}
function openPreviewInNewWindow(){
  var html = buildPreviewHtml();
  var w = window.open('', '_blank');
  if(!w){ alert('浏览器拦截了新窗口，请允许弹窗'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}

/* ================= 导出 PDF ================= */
function exportPDF(){
  if(typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined'){ alert('PDF 库未加载'); return; }
  var jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
  if(!jsPDF){ alert('PDF 库初始化失败'); return; }
  var doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  var p = getActiveProject() || {};
  var title = p.name || 'Code Utopia 项目';
  var html = buildPreviewHtml();

  doc.setFontSize(18);
  doc.text(title, 15, 20);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text('Generated by Code Utopia · ' + new Date().toLocaleString(), 15, 27);

  var y = 35;
  doc.setFontSize(12);
  doc.setTextColor(0);
  doc.text('提示词 / Prompt', 15, y); y += 6;
  doc.setFontSize(9);
  var msgs = (p.messages || []).filter(function(m){ return m.role === 'user'; });
  var promptText = msgs.length > 0 ? msgs[msgs.length-1].content : '(无)';
  var promptLines = doc.splitTextToSize(promptText, 180);
  doc.text(promptLines.slice(0, 20), 15, y);
  y += promptLines.slice(0, 20).length * 4.5 + 5;

  doc.setFontSize(12);
  doc.text('组件', 15, y); y += 6;
  doc.setFontSize(9);
  for(var i = 0; i < state.components.length && y < 270; i++){
    var c = state.components[i];
    doc.text('· ' + (c.name || '未命名') + ' (' + c.type.toUpperCase() + ', ' + (c.code||'').split('\n').length + ' 行)', 18, y);
    y += 5;
  }

  doc.addPage();
  doc.setFontSize(12);
  doc.text('代码', 15, 20);
  doc.setFontSize(7);
  var code = html;
  var codeLines = doc.splitTextToSize(code, 180);
  var pageStart = 28;
  for(var j = 0; j < codeLines.length; j += 60){
    if(pageStart === 28 && j > 0){ doc.addPage(); pageStart = 20; }
    else if(j > 0 && pageStart !== 28){ pageStart = 20; }
    doc.text(codeLines.slice(j, j+60), 15, pageStart);
  }

  doc.save((p.name || 'code-utopia') + '.pdf');
  toast('PDF 已导出');
}

/* ================= 分享卡片 ================= */
function showShareCard(){
  var iframe = $('preview');
  if(!iframe){ alert('预览未就绪'); return; }
  if(typeof html2canvas === 'undefined'){ alert('截图库未加载'); return; }
  var p = getActiveProject() || {};
  var promptText = '(无提示词)';
  var msgs = (p.messages || []).filter(function(m){ return m.role === 'user'; });
  if(msgs.length > 0) promptText = msgs[msgs.length - 1].content;

  try{
    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    html2canvas(iframeDoc.body, { backgroundColor: '#ffffff', scale: 2, useCORS: true }).then(function(shot){
      var canvas = $('shareCardCanvas');
      var W = 1080, H = 1000;
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d');

      var bgGrad = ctx.createLinearGradient(0, 0, W, H);
      bgGrad.addColorStop(0, '#0f1117');
      bgGrad.addColorStop(1, '#1a1d24');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = '#e8ecf4';
      ctx.font = 'bold 42px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('Code Utopia', 60, 80);
      ctx.font = '22px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = '#8b94a8';
      ctx.fillText('AI 生成的页面', 60, 120);

      var shotW = W - 120;
      var shotH = 560;
      var shotAspect = shot.width / shot.height;
      var drawW = shotW, drawH = shotW / shotAspect;
      if(drawH > shotH){ drawH = shotH; drawW = shotH * shotAspect; }
      var drawX = (W - drawW) / 2;
      var drawY = 150;

      ctx.save();
      roundRect(ctx, drawX - 6, drawY - 6, drawW + 12, drawH + 12, 24);
      ctx.fillStyle = '#2a3142';
      ctx.fill();
      ctx.restore();

      ctx.save();
      roundRect(ctx, drawX, drawY, drawW, drawH, 20);
      ctx.clip();
      ctx.drawImage(shot, drawX, drawY, drawW, drawH);
      ctx.restore();

      var promptY = drawY + drawH + 50;
      ctx.fillStyle = '#5a6478';
      ctx.font = 'bold 20px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('PROMPT', 60, promptY);
      ctx.fillStyle = '#dbe4f5';
      ctx.font = '28px system-ui, -apple-system, sans-serif';
      var lines = wrapText(ctx, promptText, W - 280);
      for(var i = 0; i < lines.length && i < 3; i++){
        ctx.fillText(lines[i] + (i === 2 && lines.length > 3 ? '…' : ''), 60, promptY + 42 + i * 38);
      }

      var qrSize = 140;
      var qrX = W - 60 - qrSize;
      var qrY = H - 60 - qrSize;
      var url = '';
      try{
        var compressed = encodeURIComponent(buildPreviewHtml());
        url = compressed.length < 30000 ? location.origin + location.pathname + '#share=' + compressed : location.href;
      }catch(e){ url = location.href; }

      try{
        var tmpDiv = document.createElement('div');
        tmpDiv.style.cssText = 'position:absolute;left:-9999px';
        document.body.appendChild(tmpDiv);
        new QRCode(tmpDiv, { text: url, width: qrSize, height: qrSize, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.L });
        var qrImg = tmpDiv.querySelector('img') || tmpDiv.querySelector('canvas');
        if(qrImg){
          ctx.fillStyle = '#fff';
          roundRect(ctx, qrX - 8, qrY - 8, qrSize + 16, qrSize + 16, 12);
          ctx.fill();
          if(qrImg.tagName === 'IMG'){
            var tmpImg = new Image();
            tmpImg.src = qrImg.src;
            try{ ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize); }catch(e){}
          } else {
            ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
          }
        }
        document.body.removeChild(tmpDiv);
      }catch(e){ console.error('二维码绘制失败', e); }

      ctx.fillStyle = '#8b94a8';
      ctx.font = '20px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('扫码查看', 60, H - 110);
      ctx.fillStyle = '#5a6478';
      ctx.font = '16px monospace';
      ctx.fillText('code-utopia', 60, H - 80);

      $('shareCardModal').classList.add('show');
    }).catch(function(e){ alert('生成分享卡片失败：' + e.message); });
  }catch(e){ alert('无法访问预览：' + e.message); }
}
function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function wrapText(ctx, text, maxWidth){
  var words = text.split('');
  var lines = [];
  var line = '';
  for(var i = 0; i < words.length; i++){
    var test = line + words[i];
    if(ctx.measureText(test).width > maxWidth){ lines.push(line); line = words[i]; }
    else line = test;
  }
  if(line) lines.push(line);
  return lines;
}
function closeShareCard(){ $('shareCardModal').classList.remove('show'); }
function downloadShareCard(){
  var canvas = $('shareCardCanvas');
  if(!canvas) return;
  canvas.toBlob(function(blob){
    if(!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'share-card-' + Date.now() + '.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    toast('分享卡片已下载');
  }, 'image/png');
}

/* ================= 二维码分享 ================= */
var _lastQRUrl = '';
function showQRCode(){
  var html = buildPreviewHtml();
  var url = '';
  try{
    var compressed = encodeURIComponent(html);
    url = compressed.length < 30000 ? location.origin + location.pathname + '#share=' + compressed : location.origin + location.pathname;
  }catch(e){ url = location.href; }
  state._lastSharedUrl = url;
  _lastQRUrl = url;
  $('qrModalTitle').textContent = '分享二维码';
  $('qrHint').textContent = '扫码或分享链接，在手机上打开当前页面';
  renderQRCode(url);
  $('qrModal').classList.add('show');
}
function showComponentQRCode(){
  var cur = state.components[state.activeComp];
  if(!cur || !cur.code){ alert('请先选择一个组件'); return; }
  var code = cur.code;
  var url = '';
  try{
    var compressed = encodeURIComponent(code);
    if(compressed.length < 30000){
      url = location.origin + location.pathname + '#comp=' + encodeURIComponent(JSON.stringify({ type: cur.type, code: code }));
    } else {
      url = location.origin + location.pathname;
    }
  }catch(e){ url = location.href; }
  _lastQRUrl = url;
  $('qrModalTitle').textContent = '组件二维码 · ' + (cur.name || '未命名');
  $('qrHint').textContent = '扫码在手机上查看此组件（' + cur.type.toUpperCase() + '，' + code.length + ' 字符）';
  renderQRCode(url);
  $('qrModal').classList.add('show');
}
function renderQRCode(url){
  var qrWrap = $('qrImageWrap');
  if(!qrWrap) return;
  qrWrap.innerHTML = '';
  if(typeof QRCode !== 'undefined'){
    new QRCode(qrWrap, { text: url, width: 220, height: 220, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.L });
  } else {
    qrWrap.innerHTML = '<p style="color:#5a6478;font-size:11px">二维码库未加载</p>';
  }
  $('qrLinkText').value = url;
}
function closeQRCode(){ $('qrModal').classList.remove('show'); }
function copyShareLink(){
  var txt = $('qrLinkText'); if(!txt) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt.value).then(function(){ toast('链接已复制'); }).catch(function(){ txt.select(); document.execCommand('copy'); });
  } else { txt.select(); document.execCommand('copy'); }
}
function downloadQRCode(){
  var qrWrap = $('qrImageWrap'); if(!qrWrap) return;
  var img = qrWrap.querySelector('img');
  var cvs = qrWrap.querySelector('canvas');
  if(img){
    var a = document.createElement('a'); a.href = img.src; a.download = 'qrcode.png'; a.click();
  } else if(cvs){
    cvs.toBlob(function(blob){ if(!blob) return; var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = 'qrcode.png'; a.click(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); });
  }
}
function loadFromShareHash(){
  try{
    var hash = location.hash;
    if(hash.indexOf('#share=') === 0){
      var html = decodeURIComponent(hash.slice(7));
      if(html.length < 50) return false;
      var comps = smartSplit(html);
      state.components = comps;
      state.activeComp = 0;
      setEditorValue(getActiveCompCode(), compLang(comps[0]));
      renderComponents(); refreshPreview(); snapshot('从分享链接加载');
      history.replaceState(null, '', location.pathname);
      return true;
    }
    if(hash.indexOf('#comp=') === 0){
      var data = JSON.parse(decodeURIComponent(hash.slice(6)));
      if(!data || !data.code) return false;
      state.components = [{ name: '来自二维码', type: data.type || 'html', code: data.code, enabled: true }];
      state.activeComp = 0;
      setEditorValue(data.code, compLang(state.components[0]));
      renderComponents(); refreshPreview(); snapshot('从组件二维码加载');
      history.replaceState(null, '', location.pathname);
      return true;
    }
  }catch(e){}
  return false;
}

/* ================= GitHub 上传 ================= */
function openGitHubUpload(){
  try{
    var saved = JSON.parse(localStorage.getItem('cu-gh-cfg') || '{}');
    if(saved.token) $('ghToken').value = saved.token;
    if(saved.repo) $('ghRepo').value = saved.repo;
  }catch(e){}
  $('ghStatus').className = 'conn';
  $('ghStatus').querySelector('.txt').textContent = '未开始';
  $('githubModal').classList.add('show');
}
function closeGitHubUpload(){ $('githubModal').classList.remove('show'); }
function doGitHubUpload(){
  var token = $('ghToken').value.trim();
  var repo = $('ghRepo').value.trim();
  var desc = $('ghDesc').value.trim() || 'Code Utopia 生成的页面';
  var enablePages = $('ghEnablePages').checked;
  if(!token){ alert('请填 GitHub Token'); return; }
  if(!repo){ alert('请填仓库名'); return; }

  try{ localStorage.setItem('cu-gh-cfg', JSON.stringify({ token: token, repo: repo })); }catch(e){}

  var st = $('ghStatus');
  st.className = 'conn loading';
  st.querySelector('.txt').textContent = '正在创建仓库…';
  $('ghUploadBtn').disabled = true;

  var html = buildPreviewHtml();
  var filename = 'index.html';
  var content = btoa(unescape(encodeURIComponent(html)));
  var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

  fetch('https://api.github.com/user', { headers: headers })
    .then(function(r){ if(!r.ok) throw new Error('Token 无效'); return r.json(); })
    .then(function(user){
      var owner = user.login;
      st.querySelector('.txt').textContent = '正在创建仓库 ' + owner + '/' + repo + '…';
      return fetch('https://api.github.com/user/repos', {
        method: 'POST', headers: headers,
        body: JSON.stringify({ name: repo, description: desc, private: false, auto_init: false })
      }).then(function(r){
        if(r.status === 422){ return { exists: true, owner: owner }; }
        if(!r.ok) throw new Error('创建仓库失败 ' + r.status);
        return r.json();
      }).then(function(r){ return { owner: owner, exists: r.exists }; });
    })
    .then(function(info){
      var owner = info.owner;
      st.querySelector('.txt').textContent = '正在上传文件…';
      var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + filename;
      return fetch(url, { headers: headers })
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(existing){
          var body = { message: 'Upload from Code Utopia', content: content };
          if(existing && existing.sha) body.sha = existing.sha;
          return fetch(url, { method: 'PUT', headers: headers, body: JSON.stringify(body) })
            .then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error('上传失败 ' + r.status + ' ' + t.slice(0,150)); }); return r.json(); });
        })
        .then(function(){ return { owner: owner }; });
    })
    .then(function(info){
      var owner = info.owner;
      var pagesUrl = 'https://' + owner + '.github.io/' + repo + '/';
      if(enablePages){
        st.querySelector('.txt').textContent = '正在启用 GitHub Pages…';
        return fetch('https://api.github.com/repos/' + owner + '/' + repo + '/pages', {
          method: 'POST', headers: headers,
          body: JSON.stringify({ source: { branch: 'main', path: '/' } })
        }).then(function(r){
          return { owner: owner, pagesUrl: pagesUrl };
        }).catch(function(){ return { owner: owner, pagesUrl: pagesUrl }; });
      }
      return { owner: owner, pagesUrl: pagesUrl };
    })
    .then(function(info){
      st.className = 'conn ok';
      st.querySelector('.txt').textContent = '✅ 上传成功！';
      var pagesUrl = info.pagesUrl;
      addMsg('assistant', '✅ 已上传到 GitHub！', '仓库：https://github.com/' + info.owner + '/' + repo + '\n页面（可能需要1-2分钟生效）：' + pagesUrl);
      $('ghUploadBtn').disabled = false;
      toast('GitHub 上传成功');
      setTimeout(function(){ closeGitHubUpload(); }, 1500);
    })
    .catch(function(e){
      st.className = 'conn err';
      st.querySelector('.txt').textContent = '❌ ' + e.message;
      $('ghUploadBtn').disabled = false;
      addMsg('assistant', 'GitHub 上传失败：' + e.message, '检查 Token 是否有 repo 权限，或网络问题');
    });
}/* ================= 样式预设 ================= */
var STYLE_PRESETS = [
  { key: 'cyberpunk', label: '赛博朋克', prompt: '赛博朋克风格：霓虹粉紫、蓝紫渐变、像素字体、故障效果、扫描线背景' },
  { key: 'minimal', label: '日式极简', prompt: '日式极简风格：大面积留白、米白背景、细黑线条、无衬线字体、克制用色' },
  { key: '90s', label: '90 年代', prompt: '90 年代网页风格：卡通按钮、闪烁文字、tiled 背景、Comic Sans 字体、彩虹色标题' },
  { key: 'glass', label: '玻璃拟态', prompt: '玻璃拟态风格：毛玻璃面板、半透明背景、柔和阴影、圆角、渐变光晕' },
  { key: 'brutalism', label: '粗暴主义', prompt: '粗暴主义风格：粗黑边框、大号纯色块、碰撞字体、无圆角、高对比黑白' },
  { key: 'dark', label: '暗黑模式', prompt: '暗黑模式：深黑背景、低饱和文字、靛蓝强调、柔和阴影、夜间友好' },
  { key: 'light', label: '清爽浅色', prompt: '清爽浅色风格：纯白背景、浅灰分区、蓝色强调、大圆角、柔和投影' },
  { key: 'retro', label: '复古报纸', prompt: '复古报纸风格：米黄背景、衬线字体、黑白配色、分栏布局、复古标题' }
];
function initStyleBar(){
  var bar = $('styleBar');
  if(!bar) return;
  bar.innerHTML = '<span style="font-size:11px;color:#5a6478;padding:6px 4px;white-space:nowrap;flex-shrink:0">一句话改风格：</span>';
  for(var i = 0; i < STYLE_PRESETS.length; i++){
    var p = STYLE_PRESETS[i];
    var chip = document.createElement('button');
    chip.className = 'style-chip';
    chip.textContent = p.label;
    (function(pr){ chip.addEventListener('click', function(){ applyStylePreset(pr); }); })(p);
    bar.appendChild(chip);
  }
}
function applyStylePreset(preset){
  if(!$('apiKey').value.trim() || !state.connected || !$('model').value){
    alert('一句话改风格需要真实 API。请先在配置里填 Key、测试连接拉取模型。');
    return;
  }
  var current = buildPreviewHtml();
  addMsg('user', '改风格：' + preset.label, '');
  state.loading = true; $('genBtn').disabled = true;
  $('overlay').classList.add('show');
  $('overlayText').textContent = '正在改风格为 ' + preset.label + '…';
  startTimer();
  if(isMobile()) switchMobileTab('preview');

  var body = {
    model: $('model').value, temperature: 0.6, stream: false,
    messages: [
      { role: 'system', content: '你是前端设计师。用户给你一份现有页面代码，你要把它改成指定的设计风格，保留所有功能和内容，只改视觉。返回完整 HTML，不要 markdown。' },
      { role: 'user', content: '请把下面的页面改成【' + preset.prompt + '】风格，保留所有功能和文字内容：\n\n' + current }
    ]
  };
  fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() },
    body: JSON.stringify(body)
  }).then(function(r){ if(!r.ok) throw new Error('API ' + r.status); return r.json(); })
  .then(function(data){
    var txt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    txt = txt.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
    if(data.usage && data.usage.total_tokens) recordUsage(data.usage.total_tokens, $('model').value);
    applyGenerated(txt, '改风格：' + preset.label, false);
  })
  .catch(function(e){ addMsg('assistant', '改风格失败：' + e.message, ''); })
  .then(function(){ stopTimer(); state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); });
}
function initStyleBarSafely(){ try{ initStyleBar(); }catch(e){ console.error(e); } }

/* ================= 全屏 ================= */
function toggleAppFullscreen(){
  var doc = document.documentElement;
  if(!document.fullscreenElement && !document.webkitFullscreenElement){
    var req = doc.requestFullscreen || doc.webkitRequestFullscreen;
    if(req){ req.call(doc).catch(function(e){ console.error('全屏失败:', e); }); }
    else { alert('当前浏览器不支持全屏'); }
  } else {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if(exit){ exit.call(document); }
  }
}
function togglePreviewFullscreen(){
  var wrap = $('pvWrap');
  var exitBtn = $('pvFullscreenExit');
  if(!wrap) return;
  var isFs = wrap.classList.toggle('preview-fullscreen');
  if(exitBtn) exitBtn.classList.toggle('show', isFs);
  if(isFs){ document.body.classList.add('fullscreen-mode'); setTimeout(function(){ try { applyViewport(); } catch(e){} if(state.editorReady) state.editor.layout(); }, 100); }
  else { document.body.classList.remove('fullscreen-mode'); setTimeout(function(){ try { applyViewport(); } catch(e){} }, 100); }
}
document.addEventListener('fullscreenchange', function(){
  var btn = $('pvFullscreenExit');
  if(!document.fullscreenElement){ if(btn) btn.classList.remove('show'); document.body.classList.remove('fullscreen-mode'); }
});

/* ================= 元素检查器（桌面） ================= */
function toggleInspector(){
  if(isMobile()){ toggleMobileInspector(); return; }
  state.inspectorActive = !state.inspectorActive;
  var panel = $('inspector');
  if(panel) panel.classList.toggle('show', state.inspectorActive);
  if(state.inspectorActive) setupInspector(); else teardownInspector();
}
function setupInspector(){
  var iframe = $('preview'); if(!iframe) return;
  try{
    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    iframeDoc.body.style.cursor = 'crosshair';
    iframeDoc.addEventListener('click', inspectorClickHandler, true);
    iframeDoc.addEventListener('mouseover', inspectorHoverHandler, true);
    if(!isMobile()) addMsg('assistant', '🔍 元素检查已开启。', '点击预览中的元素查看详情');
  }catch(e){ alert('无法访问预览内容：' + e.message); }
}
function teardownInspector(){
  var iframe = $('preview'); if(!iframe) return;
  try{
    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    iframeDoc.body.style.cursor = '';
    iframeDoc.removeEventListener('click', inspectorClickHandler, true);
    iframeDoc.removeEventListener('mouseover', inspectorHoverHandler, true);
    var last = iframeDoc.querySelector('.__inspector_overlay'); if(last) last.remove();
  }catch(e){}
  var body = $('inspectorBody');
  if(body) body.innerHTML = '<div class="inspector-empty">点击预览中的元素查看详情</div>';
  state.inspectorTarget = null;
}
function inspectorHoverHandler(e){
  e.preventDefault(); e.stopPropagation();
  var el = e.target;
  if(!el || el.tagName === 'HTML' || el.tagName === 'BODY') return;
  var iframeDoc = el.ownerDocument;
  var old = iframeDoc.querySelector('.__inspector_overlay'); if(old) old.remove();
  var rect = el.getBoundingClientRect();
  var overlay = iframeDoc.createElement('div');
  overlay.className = '__inspector_overlay';
  overlay.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #6d5cff;background:rgba(109,92,255,.12);z-index:999999;top:' + rect.top + 'px;left:' + rect.left + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
  iframeDoc.body.appendChild(overlay);
}
function inspectorClickHandler(e){
  e.preventDefault(); e.stopPropagation();
  var el = e.target;
  if(!el || el.tagName === 'HTML' || el.tagName === 'BODY') return;
  state.inspectorTarget = el;
  var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
  var html = el.outerHTML.slice(0, 500);
  var label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(/\s+/)[0] : '');
  if(isMobile()){ showInspectorPopover(el, cs, html, label); }
  else {
    var body2 = $('inspectorBody');
    if(body2) body2.innerHTML = buildInspectorForm(cs, html, label);
  }
}
function buildInspectorForm(cs, html, label){
  return '<div class="inspector-prop"><label>标签 / ID / Class</label><code>' + esc(label) + '</code></div>' +
    '<div class="inspector-prop"><label>HTML 片段</label><code>' + esc(html) + '</code></div>' +
    '<div class="inspector-prop"><label>文字颜色</label><input type="text" id="insp_color" value="' + esc(rgbToHex(cs.color)) + '"></div>' +
    '<div class="inspector-prop"><label>背景色</label><input type="text" id="insp_bg" value="' + esc(rgbToHex(cs.backgroundColor)) + '"></div>' +
    '<div class="inspector-prop"><label>字号</label><input type="text" id="insp_fs" value="' + esc(cs.fontSize) + '"></div>' +
    '<div class="inspector-prop"><label>字重</label><input type="text" id="insp_fw" value="' + esc(cs.fontWeight) + '"></div>' +
    '<div class="inspector-prop"><label>内边距</label><input type="text" id="insp_pad" value="' + esc(cs.padding) + '"></div>' +
    '<div class="inspector-prop"><label>外边距</label><input type="text" id="insp_mar" value="' + esc(cs.margin) + '"></div>' +
    '<div class="inspector-prop"><label>圆角</label><input type="text" id="insp_br" value="' + esc(cs.borderRadius) + '"></div>';
}
function rgbToHex(rgb){
  if(!rgb || rgb === 'rgba(0, 0, 0, 0)' || rgb === 'transparent') return '';
  var m = rgb.match(/\d+/g); if(!m || m.length < 3) return rgb;
  var hex = '#';
  for(var i = 0; i < 3; i++){ var v = parseInt(m[i], 10).toString(16); hex += v.length === 1 ? '0' + v : v; }
  return hex;
}
function applyInspectorChanges(){
  if(!state.inspectorTarget){ alert('请先在预览里点选一个元素'); return; }
  var el = state.inspectorTarget;
  var val = function(k){ var e = $('insp_' + k); return e ? e.value.trim() : ''; };
  if(val('color')) el.style.color = val('color');
  if(val('bg')) el.style.backgroundColor = val('bg');
  if(val('fs')) el.style.fontSize = val('fs');
  if(val('fw')) el.style.fontWeight = val('fw');
  if(val('pad')) el.style.padding = val('pad');
  if(val('mar')) el.style.margin = val('mar');
  if(val('br')) el.style.borderRadius = val('br');
  if(isMobile()){ if(navigator.vibrate) navigator.vibrate([10, 50, 10]); }
  addMsg('assistant', '✅ 已应用修改到预览。', '');
}

/* ================= 移动端元素检查器 ================= */
function toggleMobileInspector(){
  if(state.mobileInspectorActive){ exitMobileInspector(); return; }
  state.mobileInspectorActive = true;
  var cross = $('inspectorCrosshair'); var hint = $('inspectorHint');
  if(cross) cross.classList.add('show');
  if(hint) hint.classList.add('show');
  document.body.classList.add('fullscreen-mode');
  if(isMobile()) switchMobileTab('preview');
  state.inspectorTarget = null;
  try{ setupInspector(); } catch(e){}
}
function exitMobileInspector(){
  state.mobileInspectorActive = false;
  var cross = $('inspectorCrosshair'); var hint = $('inspectorHint'); var popover = $('inspectorPopover'); var mag = $('inspectorMagnify');
  if(cross) cross.classList.remove('show');
  if(hint) hint.classList.remove('show');
  if(popover) popover.classList.remove('show');
  if(mag) mag.classList.remove('show');
  document.body.classList.remove('fullscreen-mode');
  state.inspectorTarget = null;
  try{ teardownInspector(); } catch(e){}
}
function reselectInspector(){
  var popover = $('inspectorPopover'); if(popover) popover.classList.remove('show');
  var mag = $('inspectorMagnify'); if(mag) mag.classList.remove('show');
  state.inspectorTarget = null;
}
function closeInspectorPopover(){ var popover = $('inspectorPopover'); if(popover) popover.classList.remove('show'); }
function showInspectorPopover(el, cs, html, label){
  state.inspectorTarget = el;
  var popover = $('inspectorPopover');
  var tag = $('inspPopTag'); if(tag) tag.textContent = label;
  var body = $('inspPopBody'); if(body) body.innerHTML = buildInspectorForm(cs, html, label);
  var preview = $('inspPopPreview');
  if(preview){
    preview.innerHTML = '';
    try{
      var ph = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;display:flex;align-items:center;justify-content:center;min-height:80px;font-family:system-ui;font-size:12px;background:#fff;overflow:hidden}*{max-width:100%!important;max-height:80px!important;overflow:hidden!important}</style></head><body>' + el.outerHTML + '</body></html>';
      var pIframe = document.createElement('iframe');
      pIframe.sandbox = 'allow-scripts'; pIframe.srcdoc = ph; preview.appendChild(pIframe);
    }catch(e){}
  }
  if(popover){
    popover.classList.add('show');
    popover.style.top = ''; popover.style.bottom = 'calc(20px + env(safe-area-inset-bottom))';
    popover.style.left = '16px'; popover.style.right = '16px';
  }
  if(navigator.vibrate) navigator.vibrate(8);
}
function magnifyInspector(){
  if(!state.inspectorTarget){ alert('请先点选元素'); return; }
  var el = state.inspectorTarget;
  var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
  var label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(/\s+/)[0] : '');
  var tag = $('inspMagTag'); if(tag) tag.textContent = label;
  var magPreview = $('inspMagPreview');
  if(magPreview){
    magPreview.innerHTML = '';
    try{
      var ph = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:16px;display:flex;align-items:center;justify-content:center;min-height:200px;font-family:system-ui;background:#fff;overflow:auto}</style></head><body>' + el.outerHTML + '</body></html>';
      var iframe = document.createElement('iframe'); iframe.sandbox = 'allow-scripts'; iframe.srcdoc = ph; magPreview.appendChild(iframe);
    }catch(e){}
  }
  var body = $('inspMagBody'); if(body) body.innerHTML = buildInspectorForm(cs, el.outerHTML.slice(0, 500), label);
  var mag = $('inspectorMagnify'); if(mag) mag.classList.add('show');
  var popover = $('inspectorPopover'); if(popover) popover.classList.remove('show');
}
function closeMagnify(){
  var mag = $('inspectorMagnify'); if(mag) mag.classList.remove('show');
  if(state.mobileInspectorActive && state.inspectorTarget){
    var cs = (state.inspectorTarget.ownerDocument.defaultView || window).getComputedStyle(state.inspectorTarget);
    var label = state.inspectorTarget.tagName.toLowerCase() + (state.inspectorTarget.id ? '#' + state.inspectorTarget.id : '');
    showInspectorPopover(state.inspectorTarget, cs, state.inspectorTarget.outerHTML.slice(0, 500), label);
  }
}

/* ================= 常用 Prompt ================= */
function showPromptDropdown(){
  var list = [];
  try{ list = JSON.parse(localStorage.getItem('cu-common-prompts') || '[]'); }catch(e){ list = []; }
  if(list.length === 0){
    list = ['生成一个深色风格的 SaaS 登录页', '生成一个产品落地页', '生成一个数据仪表盘', '生成一个待办清单应用'];
    try{ localStorage.setItem('cu-common-prompts', JSON.stringify(list)); }catch(e){}
  }
  var wrap = $('promptDropdownList'); wrap.innerHTML = '';
  for(var i = 0; i < list.length; i++){
    var btn = document.createElement('button');
    btn.className = 'qcard';
    btn.style.cssText = 'width:100%;text-align:left;margin-bottom:8px;display:flex;align-items:center;gap:8px';
    btn.innerHTML = '<div class="txt" style="flex:1"><b>' + esc(list[i].slice(0, 40)) + '</b></div>';
    (function(txt){ btn.addEventListener('click', function(){ $('prompt').value = txt; closePromptDropdown(); $('prompt').focus(); }); })(list[i]);
    var del = document.createElement('span');
    del.style.cssText = 'color:#5a6478;font-size:14px;padding:0 6px;cursor:pointer;flex-shrink:0';
    del.textContent = '✕';
    (function(idx, lst){ del.addEventListener('click', function(e){ e.stopPropagation(); lst.splice(idx, 1); try{ localStorage.setItem('cu-common-prompts', JSON.stringify(lst)); }catch(er){} showPromptDropdown(); }); })(i, list);
    btn.appendChild(del);
    wrap.appendChild(btn);
  }
  $('promptDropdownModal').classList.add('show');
}
function closePromptDropdown(){ $('promptDropdownModal').classList.remove('show'); }
function saveCurrentPrompt(){
  var txt = $('prompt').value.trim();
  if(!txt){ alert('输入框为空'); return; }
  var list = [];
  try{ list = JSON.parse(localStorage.getItem('cu-common-prompts') || '[]'); }catch(e){ list = []; }
  if(list.indexOf(txt) === -1) list.unshift(txt);
  if(list.length > 20) list = list.slice(0, 20);
  try{ localStorage.setItem('cu-common-prompts', JSON.stringify(list)); }catch(e){}
  toast('已存入常用 Prompt');
}

/* ================= Prompt 模板 ================= */
var DEFAULT_TEMPLATES = [
  { name: '登录页', prompt: '生成一个{brand}品牌的登录页，主题色{color}，{dark}风格，包含邮箱输入框、密码输入框、登录按钮、忘记密码链接。', vars: [{ key: 'brand', label: '品牌名', default: 'Acme' },{ key: 'color', label: '主题色', default: '紫色' },{ key: 'dark', label: '风格', default: '深色' }] },
  { name: '落地页', prompt: '生成一个{brand}产品的落地页，包含顶部导航、Hero 区、三个特性卡片、底部 footer，主题色{color}。', vars: [{ key: 'brand', label: '品牌名', default: 'Acme' },{ key: 'color', label: '主题色', default: '蓝色' }] },
  { name: '定价页', prompt: '生成一个 SaaS 定价页，三档套餐，每档包含价格、功能列表、CTA，中间档突出。主题色{color}。', vars: [{ key: 'color', label: '主题色', default: '紫色' }] },
  { name: '待办清单', prompt: '生成一个待办清单应用，支持添加、删除、勾选完成，{dark}主题。', vars: [{ key: 'dark', label: '风格', default: '浅色' }] },
  { name: '数据仪表盘', prompt: '生成一个数据仪表盘，左侧导航，顶部数据卡片，下方图表，{dark}主题。', vars: [{ key: 'dark', label: '风格', default: '深色' }] }
];
var PROMPT_TEMPLATES = [];
function loadTemplates(){
  try{ var raw = localStorage.getItem('cu-templates'); if(raw){ PROMPT_TEMPLATES = JSON.parse(raw) || []; } else { PROMPT_TEMPLATES = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)); saveTemplates(); } }
  catch(e){ PROMPT_TEMPLATES = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)); }
}
function saveTemplates(){ try{ localStorage.setItem('cu-templates', JSON.stringify(PROMPT_TEMPLATES)); }catch(e){} }
function showTemplates(){
  var list = $('templateList'); list.innerHTML = '';
  for(var i = 0; i < PROMPT_TEMPLATES.length; i++){
    var t = PROMPT_TEMPLATES[i];
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:stretch;margin-bottom:8px';
    var btn = document.createElement('button');
    btn.className = 'qcard'; btn.style.cssText = 'flex:1;text-align:left;min-width:0';
    btn.innerHTML = '<div class="txt"><b>' + esc(t.name) + '</b><span>' + esc((t.prompt || '').slice(0, 60)) + '…</span></div><span class="arrow">→</span>';
    (function(tpl){ btn.addEventListener('click', function(){ openTemplateForm(tpl); }); })(t);
    wrapper.appendChild(btn);
    var editBtn = document.createElement('button');
    editBtn.className = 'btn-sm'; editBtn.style.cssText = 'padding:0 10px;min-height:auto'; editBtn.innerHTML = '✎';
    (function(idx){ editBtn.addEventListener('click', function(){ openEditTemplate(idx); }); })(i);
    wrapper.appendChild(editBtn);
    var delBtn = document.createElement('button');
    delBtn.className = 'btn-sm danger'; delBtn.style.cssText = 'padding:0 10px;min-height:auto'; delBtn.innerHTML = '✕';
    (function(idx){ delBtn.addEventListener('click', function(){ deleteTemplate(idx); }); })(i);
    wrapper.appendChild(delBtn);
    list.appendChild(wrapper);
  }
  $('templateModal').classList.add('show');
}
function closeTemplates(){ $('templateModal').classList.remove('show'); }
function openEditTemplate(idx){
  state.editingTemplateIdx = idx;
  if(idx === -1){ $('editTemplateTitle').textContent = '新建模板'; $('editTemplateName').value = ''; $('editTemplatePrompt').value = ''; $('editTemplateVars').value = ''; }
  else { var t = PROMPT_TEMPLATES[idx]; if(!t) return; $('editTemplateTitle').textContent = '编辑模板'; $('editTemplateName').value = t.name || ''; $('editTemplatePrompt').value = t.prompt || ''; var varsText = ''; if(t.vars && t.vars.length) for(var i = 0; i < t.vars.length; i++) varsText += (t.vars[i].key || '') + '|' + (t.vars[i].label || '') + '|' + (t.vars[i].default || '') + '\n'; $('editTemplateVars').value = varsText.trim(); }
  closeTemplates(); $('editTemplateModal').classList.add('show');
}
function closeEditTemplate(){ $('editTemplateModal').classList.remove('show'); state.editingTemplateIdx = -1; }
function saveEditTemplate(){
  var name = $('editTemplateName').value.trim();
  var prompt = $('editTemplatePrompt').value.trim();
  if(!name){ alert('名称不能为空'); return; }
  if(!prompt){ alert('Prompt 内容不能为空'); return; }
  var varsText = $('editTemplateVars').value.trim();
  var vars = [];
  if(varsText){ var lines = varsText.split('\n'); for(var i = 0; i < lines.length; i++){ var line = lines[i].trim(); if(!line) continue; var parts = line.split('|'); vars.push({ key: (parts[0]||'').trim(), label: (parts[1]||parts[0]||'').trim(), default: (parts[2]||'').trim() }); } }
  var newT = { name: name, prompt: prompt, vars: vars };
  if(state.editingTemplateIdx >= 0) PROMPT_TEMPLATES[state.editingTemplateIdx] = newT; else PROMPT_TEMPLATES.push(newT);
  saveTemplates(); closeEditTemplate(); showTemplates();
}
function createNewTemplate(){ openEditTemplate(-1); }
function deleteTemplate(idx){ if(!confirm('确定删除模板「' + PROMPT_TEMPLATES[idx].name + '」？')) return; PROMPT_TEMPLATES.splice(idx, 1); saveTemplates(); showTemplates(); }
function openTemplateForm(t){
  state.pendingTemplate = t;
  $('templateFormTitle').textContent = t.name;
  var body = $('templateFormBody'); body.innerHTML = '';
  if(t.vars && t.vars.length){ for(var i = 0; i < t.vars.length; i++){ var v = t.vars[i]; var field = document.createElement('div'); field.className = 'field'; field.innerHTML = '<label>' + esc(v.label || v.key) + '</label><input type="text" data-key="' + esc(v.key) + '" value="' + esc(v.default || '') + '">'; body.appendChild(field); } }
  else body.innerHTML = '<p style="color:#8b94a8;font-size:12px">这个模板没有变量，点击生成直接发送。</p>';
  $('templateModal').classList.remove('show'); $('templateFormModal').classList.add('show');
}
function closeTemplateForm(){ $('templateFormModal').classList.remove('show'); state.pendingTemplate = null; }
function applyTemplate(){
  if(!state.pendingTemplate) return;
  var t = state.pendingTemplate;
  var inputs = $('templateFormBody').querySelectorAll('input');
  var vars = {};
  for(var i = 0; i < inputs.length; i++) vars[inputs[i].getAttribute('data-key')] = inputs[i].value.trim();
  var prompt = t.prompt;
  for(var key in vars){ prompt = prompt.replace(new RegExp('\\{' + key + '\\}', 'g'), vars[key]); }
  $('prompt').value = prompt;
  closeTemplateForm(); generate();
}

/* ================= 快捷键面板 ================= */
var SHORTCUTS = [
  { keys: ['Ctrl', 'Enter'], desc: '生成 / 修改' },
  { keys: ['Ctrl', 'Z'], desc: '撤销' },
  { keys: ['Ctrl', 'Y'], desc: '重做' },
  { keys: ['Ctrl', 'F'], desc: '搜索代码' },
  { keys: ['Ctrl', 'H'], desc: '查找替换' },
  { keys: ['Ctrl', 'S'], desc: '存快照' },
  { keys: ['Ctrl', 'K'], desc: '切换工程' },
  { keys: ['Ctrl', 'M'], desc: '合并 HTML' },
  { keys: ['?'], desc: '快捷键面板' },
  { keys: ['Esc'], desc: '关闭弹层' }
];
function showKbdPanel(){
  var grid = $('kbdGrid'); grid.innerHTML = '';
  for(var i = 0; i < SHORTCUTS.length; i++){
    var s = SHORTCUTS[i];
    var item = document.createElement('div'); item.className = 'kbd-item';
    var keysHtml = '';
    for(var k = 0; k < s.keys.length; k++){ keysHtml += '<kbd>' + s.keys[k] + '</kbd>'; if(k < s.keys.length - 1) keysHtml += '+'; }
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
  $('testBtn').disabled = true; setConn('loading','正在连接…');
  $('model').disabled = true; $('model').innerHTML = '<option value="">连接中…</option>';
  $('modelCount').textContent = '';
  fetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } })
    .then(function(resp){ if(!resp.ok) throw new Error('HTTP ' + resp.status); return resp.json(); })
    .then(function(data){
      var list = [];
      if(Array.isArray(data.data)) list = data.data.map(function(m){ return m.id || m.name; }).filter(Boolean);
      else if(Array.isArray(data.models)) list = data.models.map(function(m){ return m.id || m.name || m; }).filter(Boolean);
      else if(Array.isArray(data)) list = data.map(function(m){ return m.id || m.name || m; }).filter(Boolean);
      if(list.length === 0) throw new Error('未返回模型列表');
      list.sort(); populateModels(list); state.connected = true;
      setConn('ok', '已连接 · ' + list.length + ' 个模型可用'); updateMode();
      if(state.activeProfile >= 0 && state.keyProfiles[state.activeProfile] && state.currentModel){ state.keyProfiles[state.activeProfile].model = state.currentModel; saveKeyProfiles(); }
      try{ renderAttachments(); }catch(e){}
    })
    .catch(function(e){
      state.connected = false; $('model').disabled = true;
      $('model').innerHTML = '<option value="">拉取失败</option>'; $('modelCount').textContent = '';
      var msg = String(e.message).indexOf('Failed to fetch') >= 0 ? '连接失败：CORS 拦截或网络错误' : '连接失败：' + e.message;
      setConn('err', msg); updateMode();
    })
    .then(function(){ $('testBtn').disabled = false; });
}

/* ================= 用量 ================= */
function recordUsage(tokens, model){
  try{
    var usage = JSON.parse(localStorage.getItem('cu-usage') || '{"total":0,"byModel":{},"history":[]}');
    usage.total = (usage.total || 0) + (tokens || 0);
    if(!usage.byModel) usage.byModel = {};
    usage.byModel[model || 'unknown'] = (usage.byModel[model || 'unknown'] || 0) + (tokens || 0);
    if(!usage.history) usage.history = [];
    usage.history.push({ t: Date.now(), tokens: tokens || 0, model: model || '' });
    if(usage.history.length > 200) usage.history = usage.history.slice(-200);
    localStorage.setItem('cu-usage', JSON.stringify(usage));
  }catch(e){}
}

/* ================= AI 吐槽 ================= */
function getRoast(code, callback){
  var useReal = $('apiKey').value.trim() && state.connected && $('model').value;
  if(!useReal){ callback('（演示模式，AI 不吐槽）'); return; }
  var body = { model: $('model').value, temperature: 0.9, stream: false, messages: [
    { role: 'system', content: '你是一个嘴很毒但内心善良的前端工程师。用户给你一段 HTML 代码，你用一句不超过 30 字的中文吐槽它。要求：有趣、具体（指出某个设计或代码细节）、不攻击用户本人。' },
    { role: 'user', content: '吐槽这段代码：\n' + code.slice(0, 4000) }
  ] };
  fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() }, body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(data){
    var txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    callback((txt || '').trim() || '（AI 没说话）');
  }).catch(function(){ callback('（吐槽失败）'); });
}

/* ================= 随机灵感 ================= */
var INSPIRATIONS = ['给猫做的心率监测仪表盘','卖月球土地的单页网站','90 年代复古风格的个人主页','一杯咖啡的倒计时器','宇宙飞船控制面板','手写风格的日记应用','赛博朋克风格的天气查询','给植物浇水的提醒应用','虚拟宠物养成页面','做数学题的计时挑战','AI 算命摊','行星运行模拟器','会放烟花的生日祝福页','打地鼠小游戏','颜色渐变生成器','极简风格的待办清单','一家只卖一种咖啡的店','时间胶囊留言板','按心情推荐的歌单','程序员的自嘲语录墙'];
function randomInspiration(){
  var idea = INSPIRATIONS[Math.floor(Math.random() * INSPIRATIONS.length)];
  $('prompt').value = '生成一个' + idea;
  $('prompt').focus();
  if(navigator.vibrate) navigator.vibrate(10);
}

/* ================= 工程导入导出 ================= */
function exportProjectJSON(){
  saveCurrentProject();
  var p = getActiveProject();
  if(!p){ alert('没有活动工程'); return; }
  var data = JSON.stringify(p, null, 2);
  var blob = new Blob([data], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (p.name || 'project') + '-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  toast('工程已导出');
}
function importProjectJSON(){
  var input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = function(e){
    var file = e.target.files[0]; if(!file) return;
    var reader = new FileReader();
    reader.onload = function(ev){
      try{
        var p = JSON.parse(ev.target.result);
        if(!p.id || !p.name || !p.components){ alert('文件格式不对'); return; }
        p.id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        p.name = p.name + ' (导入)'; p.updatedAt = Date.now();
        if(!p.messages) p.messages = [];
        if(!p.history) p.history = [];
        if(!p.favorites) p.favorites = [];
        state.projects.push(p); state.activeProjectId = p.id;
        saveProjects(); loadActiveProjectIntoState(); renderProjects();
        toast('已导入工程');
      }catch(err){ alert('导入失败：' + err.message); }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ================= 文件上传 ================= */
function handleFileUpload(e){
  var files = e.target.files;
  if(!files || files.length === 0) return;
  for(var i = 0; i < files.length; i++){
    (function(file){
      var kind = file.type.indexOf('image/') === 0 ? 'image' : 'text';
      if(kind === 'text' && !/\.(txt|md|html|css|js|json)$/i.test(file.name)){ addMsg('assistant', '⚠️ 不支持：' + file.name); return; }
      if(file.size > 5 * 1024 * 1024){ addMsg('assistant', '⚠️ 文件太大：' + file.name); return; }
      var reader = new FileReader();
      reader.onload = function(ev){ state.attachedFiles.push({ name: file.name, kind: kind, content: ev.target.result, size: file.size }); renderAttachments(); };
      if(kind === 'image') reader.readAsDataURL(file); else reader.readAsText(file);
    })(files[i]);
  }
  e.target.value = '';
}
function renderAttachments(){
  var bar = $('attachBar'); if(!bar) return;
  if(state.attachedFiles.length === 0){ bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex'; bar.innerHTML = '';
  var isVisionModel = /vision|vl-|4o|gemini|claude-3|pixtral|llava/i.test($('model').value || '');
  var hasImage = false;
  for(var i = 0; i < state.attachedFiles.length; i++){
    var f = state.attachedFiles[i];
    if(f.kind === 'image') hasImage = true;
    var item = document.createElement('div'); item.className = 'attach-item';
    var preview = f.kind === 'image' ? '<img src="' + f.content + '" alt="">' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;color:#8b94a8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    item.innerHTML = preview + '<span class="name">' + esc(f.name) + '</span><span class="rm" onclick="removeAttachment(' + i + ')">✕</span>';
    bar.appendChild(item);
  }
  if(hasImage && !isVisionModel){ var warn = document.createElement('div'); warn.className = 'attach-warn'; warn.style.width = '100%'; warn.textContent = '⚠️ 当前模型「' + ($('model').value || '未选') + '」可能不支持看图'; bar.appendChild(warn); }
}
function removeAttachment(i){ state.attachedFiles.splice(i, 1); renderAttachments(); }
function clearAttachments(){ state.attachedFiles = []; renderAttachments(); }

/* ================= 作品墙 ================= */
function openGallery(){ state.galleryTab = 'history'; renderGallery(); $('gallery').classList.add('show'); }
function openFavorites(){ state.galleryTab = 'fav'; renderGallery(); $('gallery').classList.add('show'); }
function closeGallery(){ $('gallery').classList.remove('show'); }
function switchGalleryTab(tab){ state.galleryTab = tab; renderGallery(); }
function renderGallery(){
  var p = getActiveProject(); var grid = $('galleryGrid');
  var tabH = $('galTabHistory'); var tabF = $('galTabFav');
  if(tabH) tabH.classList.toggle('ok', state.galleryTab === 'history');
  if(tabF) tabF.classList.toggle('ok', state.galleryTab === 'fav');
  var list = [];
  if(state.galleryTab === 'history'){ if(p && p.history) list = p.history.map(function(item, idx){ return { item: item, idx: idx, fav: false }; }).reverse(); }
  else { if(p && p.favorites) list = p.favorites.map(function(fav){ return { item: fav, idx: fav.historyIdx, fav: true }; }).reverse(); }
  if(list.length === 0){ grid.innerHTML = '<div class="pv-empty" style="grid-column:1/-1">' + (state.galleryTab === 'history' ? '还没有历史版本。' : '还没有收藏。') + '</div>'; return; }
  var html = '';
  for(var i = 0; i < list.length; i++){
    var entry = list[i]; var item = entry.item;
    var d = new Date(item.time);
    var time = d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2) + ' ' + ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2);
    var favMark = entry.fav ? '<span style="color:#fcd34d;margin-right:4px">★</span>' : '';
    var actions = entry.fav ? '<button class="tool danger" style="padding:4px 8px;font-size:10.5px" onclick="event.stopPropagation();removeFavorite(' + i + ')">取消</button>' : '<button class="tool" style="padding:4px 8px;font-size:10.5px" onclick="event.stopPropagation();addHistoryToFavorites(' + entry.idx + ')">收藏</button>';
    html += '<div class="gallery-card"><div class="thumb" data-hidx="' + i + '"></div><div class="info" style="display:flex;align-items:flex-start;gap:6px"><div style="flex:1;min-width:0"><b>' + favMark + 'v' + item.version + '</b><span>' + esc((item.prompt || '').slice(0, 50)) + '<br>' + time + '</span></div><div style="display:flex;flex-direction:column;gap:4px"><button class="tool" style="padding:4px 8px;font-size:10.5px" onclick="event.stopPropagation();' + (entry.fav ? 'restoreFromFavorites(' + i + ')' : 'restoreFromGallery(' + entry.idx + ')') + '">恢复</button>' + actions + '</div></div></div>';
  }
  grid.innerHTML = html;
  setTimeout(function(){
    var cards = grid.querySelectorAll('.thumb');
    for(var k = 0; k < cards.length; k++){
      var entry = list[k]; if(!entry) continue;
      var comps = entry.item.components || [];
      var hp = '', cp = '', jp = '';
      for(var j = 0; j < comps.length; j++){ var c = comps[j]; if(!c.enabled) continue; if(c.type === 'html') hp += c.code; else if(c.type === 'css') cp += c.code; else if(c.type === 'js') jp += c.code; }
      var doc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + cp + '</style></head><body>' + hp + '<script>' + jp + '<' + '/script></body></html>';
      var iframe = document.createElement('iframe'); iframe.sandbox = 'allow-scripts'; iframe.srcdoc = doc;
      cards[k].appendChild(iframe);
    }
  }, 50);
}
function addCurrentToFavorites(){
  var p = getActiveProject(); if(!p) return;
  var cur = state.components[state.activeComp]; if(cur && state.editorReady) cur.code = getEditorValue();
  var comps = state.components.map(function(c){ return { name: c.name, type: c.type, code: c.code, enabled: c.enabled }; });
  if(comps.length === 0 || !comps.some(function(c){ return c.code && c.code.trim(); })){ alert('当前没有可收藏的内容'); return; }
  if(!p.favorites) p.favorites = [];
  p.favorites.push({ version: p.favorites.length + 1, prompt: '⭐ 手动收藏', components: comps, time: Date.now(), historyIdx: state.historyIndex });
  saveProjects(); toast('已加入收藏');
}
function addHistoryToFavorites(histIdx){
  var p = getActiveProject(); if(!p) return;
  var item = p.history[histIdx]; if(!item) return;
  if(!p.favorites) p.favorites = [];
  if(p.favorites.some(function(f){ return f.time === item.time; })){ toast('已收藏过'); return; }
  p.favorites.push({ version: item.version, prompt: item.prompt, components: JSON.parse(JSON.stringify(item.components || [])), time: item.time, historyIdx: histIdx });
  saveProjects(); renderGallery(); toast('已收藏 v' + item.version);
}
function removeFavorite(favIdx){ var p = getActiveProject(); if(!p || !p.favorites) return; p.favorites.splice(favIdx, 1); saveProjects(); renderGallery(); }
function restoreFromGallery(i){ var p = getActiveProject(); if(!p || !p.history[i]) return; closeGallery(); restoreHistory(i); }
function restoreFromFavorites(i){
  var p = getActiveProject(); if(!p || !p.favorites[i]) return;
  var item = p.favorites[i]; closeGallery();
  state.components = [];
  for(var k = 0; k < (item.components || []).length; k++){ var c = item.components[k]; state.components.push({ name: c.name, type: c.type, code: c.code, enabled: c.enabled !== false }); }
  state.activeComp = 0;
  setEditorValue(getActiveCompCode(), compLang(state.components[0]));
  renderComponents(); refreshPreview(); addMsg('assistant', '已从收藏恢复。', item.prompt || '');
}

/* ================= 生成 ================= */
function generate(){
  var p = $('prompt').value.trim();
  if((!p && state.attachedFiles.length === 0) || state.loading) return;
  if(!state.started){ $('msgs').innerHTML = ''; state.started = true; }

  var isModify = state.modifyMode;
  var ctx = isModify ? buildModifyContext() : null;
  var hasCode = ctx && ctx.html;
  var useStream = $('streamMode') ? $('streamMode').checked : true;
  var doRoast = $('roastMode') ? $('roastMode').checked : false;
  var files = state.attachedFiles.slice();

  var attachInfo = files.length > 0 ? ' · 附件 ' + files.length + ' 个' : '';
  addMsg('user', p || '(仅附件)', isModify ? (hasCode ? '基于当前代码修改' : '修改模式') + attachInfo : (attachInfo || ''));
  $('prompt').value = '';
  clearAttachments();
  state.loading = true; $('genBtn').disabled = true;
  showContinueBtn(false);
  $('overlay').classList.add('show');
  $('overlayText').textContent = isModify ? '正在理解现有代码…' : '正在思考页面结构…';
  startTimer();
  if(isMobile()) switchMobileTab('preview');

  var useReal = $('apiKey').value.trim() && state.connected && $('model').value;
  var modelName = $('model').value || '';
  var isVisionModel = /vision|vl-|4o|gemini|claude-3|pixtral|llava/i.test(modelName);

  var textContent = p;
  var textFiles = files.filter(function(f){ return f.kind === 'text'; });
  var imageFiles = files.filter(function(f){ return f.kind === 'image'; });
  if(textFiles.length > 0){ for(var i = 0; i < textFiles.length; i++) textContent += '\n\n=== 附件：' + textFiles[i].name + ' ===\n' + textFiles[i].content + '\n=== 结束 ==='; }
  var userContent;
  if(imageFiles.length > 0 && isVisionModel){ userContent = []; if(textContent) userContent.push({ type: 'text', text: textContent }); for(var i = 0; i < imageFiles.length; i++) userContent.push({ type: 'image_url', image_url: { url: imageFiles[i].content } }); }
  else if(imageFiles.length > 0 && !isVisionModel) userContent = textContent || '（用户上传了图片但当前模型不支持看图）';
  else userContent = textContent;

  if(useReal){
    state.abort = new AbortController();
    $('overlayText').textContent = '正在调用 ' + $('model').value + (isModify ? ' 修改代码…' : '…');
    var full = '';
    var systemPrompt = (isModify && hasCode) ? buildModifySystemPrompt(ctx) : '你是前端代码生成器。用户用自然语言描述页面，你只返回一个完整 HTML 文件（含 style 和 script），可用 CDN 引入 Tailwind。不要 markdown 代码块，不要解释，直接以 <!DOCTYPE html> 开头。页面要美观、现代、响应式。';
    var body = { model: $('model').value, temperature: (isModify && hasCode) ? 0.4 : 0.7, stream: useStream,
      messages: [{ role: 'system', content: systemPrompt }].concat(state.messages.filter(function(m){ return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; }).slice(-8).map(function(m){ return { role: m.role, content: m.content }; })).concat([{ role: 'user', content: userContent }]) };
    state._streamingComp = false; state._lastEditorUpdate = 0; state._lastPreviewUpdate = 0;

    if(!useStream){
      fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() }, body: JSON.stringify(body) })
      .then(function(resp){ if(!resp.ok) return resp.text().then(function(t){ throw new Error('API ' + resp.status + ': ' + t.slice(0, 200)); }); return resp.json(); })
      .then(function(data){
        full = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        full = full.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
        if(data.usage && data.usage.total_tokens) recordUsage(data.usage.total_tokens, $('model').value);
        state.lastRawOutput = full;
        applyGenerated(full, p || '附件生成', isModify);
        if(doRoast) getRoast(full, function(roast){ addMsg('assistant', '💬 ' + roast, ''); });
      })
      .catch(function(e){ addMsg('assistant', '生成失败：' + e.message); })
      .then(function(){ stopTimer(); state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); state.abort = null; var code = getEditorValue(); showContinueBtn(!!(code && code.trim().length > 100)); });
    } else {
      fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() }, body: JSON.stringify(body), signal: state.abort.signal })
      .then(function(resp){
        if(!resp.ok) return resp.text().then(function(t){ throw new Error('API ' + resp.status + ': ' + t.slice(0, 200)); });
        var reader = resp.body.getReader(); var dec = new TextDecoder(); var buf = '';
        function pump(){
          return reader.read().then(function(r){
            if(r.done){
              full = full.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
              state.lastRawOutput = full;
              recordUsage(Math.round(full.length / 4), $('model').value);
              state._streamingComp = false;
              applyGenerated(full, p || '附件生成', isModify);
              if(doRoast) getRoast(full, function(roast){ addMsg('assistant', '💬 ' + roast, ''); });
              return;
            }
            buf += dec.decode(r.value, { stream: true });
            var lines = buf.split('\n'); buf = lines.pop() || '';
            for(var i = 0; i < lines.length; i++){
              var t = lines[i].trim(); if(t.indexOf('data:') !== 0) continue;
              var d = t.slice(5).trim(); if(d === '[DONE]') continue;
              try{ var j = JSON.parse(d); var dd = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || ''; if(dd){
                full += dd; var now = Date.now();
                if(now - state._lastEditorUpdate > 200){
                  state._lastEditorUpdate = now;
                  var clean = full.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
                  if(!state._streamingComp){ state.components = [{ name: '生成中…', type: 'html', code: '', enabled: true }]; state.activeComp = 0; state._streamingComp = true; renderComponents(); }
                  state.components[0].code = clean; setEditorValue(clean, 'html');
                  if(now - state._lastPreviewUpdate > 1200){ state._lastPreviewUpdate = now; refreshPreview(); }
                }
              } }catch(e){}
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function(e){ if(e.name === 'AbortError') addMsg('assistant', '已停止生成。'); else { var m = String(e.message).indexOf('Failed to fetch') >= 0 ? '请求失败：CORS 限制或网络问题。' : e.message; addMsg('assistant', '生成失败：' + m); } })
      .then(function(){ stopTimer(); state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); state.abort = null; var code = getEditorValue(); showContinueBtn(!!(code && code.trim().length > 100)); });
    }
  } else {
    if(isModify && hasCode){ $('overlayText').textContent = '演示模式无法真实修改'; addMsg('assistant', '演示模式无法基于现有代码修改。', '请先在 API 配置里填 Key 并拉取模型。'); stopTimer(); state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); return; }
    $('overlayText').textContent = '正在渲染页面…';
    var demo = pickDemo(p || '登录页');
    var chunks = demo.match(/[\s\S]{1,60}/g) || [demo];
    var idx = 0, fullDemo = '';
    function next(){
      if(idx >= chunks.length){
        state.lastRawOutput = fullDemo;
        applyGenerated(fullDemo, p || '演示', false);
        if(doRoast) addMsg('assistant', '💬 这配色是调色盘摔了吗？但至少能跑。', '');
        stopTimer(); state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show');
        showContinueBtn(true); return;
      }
      fullDemo += chunks[idx++]; setTimeout(next, 16);
    }
    next();
  }
}

/* ================= 继续生成 ================= */
function continueGenerate(){
  if(state.loading) return;
  var currentCode = getEditorValue();
  if(!currentCode || !currentCode.trim()){ addMsg('assistant', '当前没有可续写的代码。'); return; }
  if(state.modifyMode){ onModifyToggle(false); }
  addMsg('user', '⏩ 继续生成后续代码', '');
  state.loading = true; $('genBtn').disabled = true; showContinueBtn(false);
  $('overlay').classList.add('show'); $('overlayText').textContent = '正在续写代码…';
  startTimer();
  if(isMobile()) switchMobileTab('preview');
  var systemPrompt = ['你是前端代码续写助手。用户会给你一份【已生成的代码】，你需要从末尾继续写，补全剩余部分。','绝对不要重复已有代码，不要重新开始，不要输出 <!DOCTYPE html> 或 <html> 开头（除非原代码还没写到这里）。','只输出需要追加的新内容，保持原有的缩进和风格。','不要任何解释文字，不要 markdown 代码块，直接输出后续代码。','', '【已生成的代码】', currentCode, '--- 代码结束 ---', '', '请从上面代码的末尾继续写，输出后续部分：'].join('\n');
  var useReal = $('apiKey').value.trim() && state.connected && $('model').value;
  if(useReal){
    state.abort = new AbortController();
    var appended = '';
    var body = { model: $('model').value, temperature: 0.3, stream: true, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: '请继续补全代码' }] };
    fetch($('baseUrl').value.trim().replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + $('apiKey').value.trim() }, body: JSON.stringify(body), signal: state.abort.signal })
    .then(function(resp){
      if(!resp.ok) throw new Error('API ' + resp.status);
      var reader = resp.body.getReader(); var dec = new TextDecoder(); var buf = '';
      function pump(){
        return reader.read().then(function(r){
          if(r.done){
            var merged = currentCode + appended;
            merged = merged.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
            state.lastRawOutput = merged;
            recordUsage(Math.round(appended.length / 4), $('model').value);
            var comps = smartSplit(merged);
            state.components = comps; state.activeComp = 0;
            setEditorValue(getActiveCompCode(), compLang(comps[0]));
            renderComponents(); refreshPreview();
            snapshot('⏩ 续写补全');
            var dur = stopTimer();
            addMsg('assistant', '✅ 续写完成。', '耗时 ' + dur.toFixed(1) + ' 秒');
            showContinueBtn(true); return;
          }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop() || '';
          for(var i = 0; i < lines.length; i++){
            var t = lines[i].trim(); if(t.indexOf('data:') !== 0) continue;
            var d = t.slice(5).trim(); if(d === '[DONE]') continue;
            try{ var j = JSON.parse(d); var dd = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || ''; if(dd) appended += dd; }catch(e){}
          }
          return pump();
        });
      }
      return pump();
    })
    .catch(function(e){ if(e.name === 'AbortError') addMsg('assistant', '已停止续写。'); else addMsg('assistant', '续写失败：' + e.message); })
    .then(function(){ state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show'); state.abort = null; showContinueBtn(true); });
  } else {
    addMsg('assistant', '演示模式无法续写代码。'); stopTimer(); state.loading = false; $('genBtn').disabled = false; $('overlay').classList.remove('show');
  }
}

/* ================= 应用生成结果 ================= */
function applyGenerated(html, prompt, isModify){
  var comps = smartSplit(html);
  state.components = comps; state.activeComp = 0;
  setEditorValue(getActiveCompCode(), compLang(comps[0]));
  renderComponents(); refreshPreview(); snapshot(prompt);
  var display = (isModify ? '已根据你的需求修改现有代码。' : '页面已生成，已智能分区为 ' + comps.length + ' 个组件。');
  var sub = '耗时 ' + state.lastDuration.toFixed(1) + ' 秒';
  state.messages.push({ role: 'assistant', content: html, display: display, sub: sub });
  var msgs = $('msgs');
  var last = state.messages[state.messages.length - 1];
  var div = document.createElement('div'); div.className = 'msg assistant';
  var iconAI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
  div.innerHTML = '<div class="av">' + iconAI + '</div><div class="bubble"></div>';
  var b = div.querySelector('.bubble'); b.textContent = last.display;
  var s = document.createElement('span'); s.className='sub'; s.textContent = last.sub; b.appendChild(s);
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
  saveCurrentProject(); showContinueBtn(true);
}

/* ================= 演示模板 ================= */
var CLOSE = '<' + '/script>';
var DEMOS = [
  { k:['登录','login','登陆'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-gray-900 to-slate-800 px-4"><div class="w-full max-w-md bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 border border-white/20"><h1 class="text-3xl font-bold text-white mb-2 text-center">欢迎回来</h1><p class="text-white/60 text-sm text-center mb-8">登录你的账户以继续</p><form class="space-y-5" onsubmit="event.preventDefault();alert(\'演示\')"><div><label class="block text-white/80 text-sm mb-2">邮箱</label><input type="email" placeholder="you@example.com" class="w-full px-4 py-3 rounded-lg bg-white/10 border border-white/20 text-white"></div><div><label class="block text-white/80 text-sm mb-2">密码</label><input type="password" placeholder="••••••••" class="w-full px-4 py-3 rounded-lg bg-white/10 border border-white/20 text-white"></div><button class="w-full py-3 rounded-lg bg-gray-600 text-white font-semibold">登 录</button></form></div></body></html>' },
  { k:['番茄','计时','倒计时','timer','pomodoro'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900 p-4"><div class="bg-white/95 rounded-3xl shadow-2xl p-10 w-full max-w-sm text-center"><h1 class="text-xl font-semibold text-gray-500 mb-6">POMODORO</h1><div class="relative w-56 h-56 mx-auto mb-8"><svg class="transform -rotate-90 w-56 h-56"><circle cx="112" cy="112" r="100" stroke="#f1f5f9" stroke-width="12" fill="none"/><circle id="ring" cx="112" cy="112" r="100" stroke="#6b7280" stroke-width="12" fill="none"/></svg><div class="absolute inset-0 flex items-center justify-center"><span id="d" class="text-5xl font-bold">25:00</span></div></div><div class="flex gap-3 justify-center"><button id="s" class="px-6 py-2.5 rounded-full bg-gray-700 text-white">开始</button><button id="r" class="px-6 py-2.5 rounded-full bg-gray-200">重置</button></div></div><script>var t=1500,l=t,tm=null;function rn(){document.getElementById("d").textContent=String(Math.floor(l/60)).padStart(2,"0")+":"+String(l%60).padStart(2,"0")}document.getElementById("s").onclick=function(){if(tm)return;tm=setInterval(function(){if(l<=0){clearInterval(tm);tm=null;return}l--;rn()},1000)};document.getElementById("r").onclick=function(){clearInterval(tm);tm=null;l=t;rn()};rn();' + CLOSE + '</body></html>' },
  { k:['待办','todo','任务','清单'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen bg-gray-100 py-12 px-4"><div class="max-w-md mx-auto bg-white rounded-2xl shadow-lg p-6"><h1 class="text-2xl font-bold text-gray-800 mb-6">✅ 待办清单</h1><form id="f" class="flex gap-2 mb-5"><input id="t" placeholder="添加任务…" class="flex-1 px-4 py-2.5 rounded-lg border"><button class="px-5 py-2.5 rounded-lg bg-gray-700 text-white">添加</button></form><ul id="l" class="space-y-2"></ul></div><script>var it=[{text:"学习 Tailwind",done:false}];function rn(){document.getElementById("l").innerHTML=it.map(function(x,i){return "<li class=\\"p-3 bg-gray-50 rounded\\">"+x.text+"</li>"}).join("")}rn();' + CLOSE + '</body></html>' },
  { k:['仪表','dashboard','数据','图表','admin'], h:'<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen bg-gray-100"><div class="flex"><aside class="w-56 min-h-screen bg-gray-900 text-white p-5"><h1 class="text-xl font-bold mb-8">📊 Admin</h1></aside><main class="flex-1 p-8"><h2 class="text-2xl font-bold mb-6">数据概览</h2><div class="grid grid-cols-3 gap-5"><div class="bg-white p-5 rounded-xl shadow">今日销售额 ¥ 12,480</div><div class="bg-white p-5 rounded-xl shadow">新增用户 + 128</div><div class="bg-white p-5 rounded-xl shadow">订单数 342</div></div></main></div></body></html>' }
];
function pickDemo(p){ var pl = p.toLowerCase(); for(var i = 0; i < DEMOS.length; i++) for(var j = 0; j < DEMOS[i].k.length; j++) if(pl.indexOf(DEMOS[i].k[j]) >= 0) return DEMOS[i].h; return '<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com">' + CLOSE + '</head><body class="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-700 to-gray-900 p-8"><div class="bg-white rounded-2xl shadow-2xl p-10 max-w-lg"><h1 class="text-2xl font-bold text-gray-800 mb-3">演示模式</h1><p class="text-gray-600 mb-4">你的需求：</p><blockquote class="border-l-4 border-gray-400 pl-4 italic mb-5">' + esc(p) + '</blockquote></div></body></html>'; }

/* ================= 复制/下载/格式化 ================= */
function copyCode(){
  var b = $('copyBtn'); var ta = getEditorValue();
  function fallback(){ var tmp = document.createElement('textarea'); tmp.value = ta; document.body.appendChild(tmp); tmp.select(); try{ document.execCommand('copy'); b.classList.add('ok'); var old = b.innerHTML; b.innerHTML = '✓ 已复制'; setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400); }catch(e){} document.body.removeChild(tmp); }
  try{ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(ta).then(function(){ b.classList.add('ok'); var old = b.innerHTML; b.innerHTML = '✓ 已复制'; setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400); }).catch(fallback); } else fallback(); }catch(e){ fallback(); }
}
function downloadZip(){
  var cur = state.components[state.activeComp];
  if(cur && state.editorReady) cur.code = getEditorValue();
  var htmlParts = '', cssParts = '', jsParts = '';
  for(var i = 0; i < state.components.length; i++){ var c = state.components[i]; if(!c.enabled) continue; if(c.type === 'html') htmlParts += '\n' + c.code + '\n'; else if(c.type === 'css') cssParts += '\n' + c.code + '\n'; else if(c.type === 'js') jsParts += '\n' + c.code + '\n'; }
  if(typeof JSZip === 'undefined'){ var blob = new Blob([getEditorValue()], { type: 'text/plain' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'component.txt'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000); return; }
  var zip = new JSZip();
  var finalHtml = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<title>' + esc((getActiveProject() || {}).name || 'Code Utopia') + '</title>\n<link rel="stylesheet" href="style.css">\n</head>\n<body>\n' + htmlParts + '\n<script src="script.js"><' + '/script>\n</body>\n</html>';
  zip.file('index.html', finalHtml); zip.file('style.css', cssParts); zip.file('script.js', jsParts);
  zip.file('README.md', '# ' + ((getActiveProject() || {}).name || 'Code Utopia') + '\n\n生成时间: ' + new Date().toLocaleString() + '\n');
  zip.generateAsync({ type: 'blob' }).then(function(content){ var a = document.createElement('a'); a.href = URL.createObjectURL(content); a.download = ((getActiveProject() || {}).name || 'code-utopia') + '.zip'; document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000); });
}
function formatCode(){
  var b = $('fmtBtn'); var current = getEditorValue();
  var type = state.components[state.activeComp] ? state.components[state.activeComp].type : detectLanguage(current);
  if(type === 'css'){ var out = [], indent = 0; current.replace(/\s*([\{\};])\s*/g, '$1\n').split('\n').forEach(function(line){ line = line.trim(); if(!line) return; if(line === '}') indent = Math.max(0, indent - 1); out.push('  '.repeat(indent) + line); if(line === '{') indent++; }); var cssFormatted = out.join('\n'); setActiveCompCode(cssFormatted); setEditorValue(cssFormatted, 'css'); refreshPreview(); b.classList.add('ok'); var old = b.innerHTML; b.innerHTML = '✓ 已格式化'; setTimeout(function(){ b.innerHTML = old; b.classList.remove('ok'); }, 1400); return; }
  var indent = 0, res = [];
  current.replace(/>\s*</g, '>\n<').split('\n').forEach(function(line){ line = line.trim(); if(!line) return; if(/^<\//.test(line)) indent = Math.max(0, indent - 1); res.push('  '.repeat(indent) + line); if(/^<[^/!][^>]*[^/]>$/.test(line) && !/<\/.+>$/.test(line)) indent++; });
  var formatted = res.join('\n'); setActiveCompCode(formatted); setEditorValue(formatted); refreshPreview(); b.classList.add('ok'); var old2 = b.innerHTML; b.innerHTML = '✓ 已格式化'; setTimeout(function(){ b.innerHTML = old2; b.classList.remove('ok'); }, 1400);
}

/* ================= 视口 ================= */
var DEVICES = { desktop: { w: null, h: null, label: '100% · 铺满', addr: 'preview://live' }, tablet: { w: 768, h: 1024, label: '768 × 1024 · 平板', addr: 'preview://tablet' }, mobile: { w: 390, h: 844, label: '390 × 844 · 手机', addr: 'preview://mobile' } };
var currentDevice = 'desktop'; var manualSize = null; var rotated = false;

function applyViewport(){
  var d = DEVICES[currentDevice]; var pv = $('pv');
  var wrapW = $('pvWrap').clientWidth - 24; var wrapH = $('pvWrap').clientHeight - 24;
  pv.classList.remove('nosmooth');
  var w = manualSize ? manualSize.w : (d.w ? (rotated ? d.h : d.w) : null);
  var h = manualSize ? manualSize.h : (d.h ? (rotated ? d.w : d.h) : null);
  if(w){ pv.style.flex = 'none'; pv.style.width = Math.min(w, wrapW) + 'px'; pv.style.height = h ? Math.min(h, wrapH) + 'px' : ''; pv.style.maxWidth = '100%'; pv.style.maxHeight = '100%'; pv.style.minHeight = '140px'; pv.classList.add('pv-frame'); $('vpSize').textContent = Math.round(w) + ' × ' + (h ? Math.round(h) : 'auto'); $('addr').textContent = rotated ? d.addr + ' (landscape)' : d.addr; }
  else { pv.style.flex = '1'; pv.style.width = '100%'; pv.style.height = ''; pv.style.maxWidth = '100%'; pv.style.maxHeight = ''; pv.style.minHeight = ''; pv.classList.remove('pv-frame'); $('vpSize').textContent = d.label; $('addr').textContent = d.addr; }
  if(manualSize){ $('winW').value = manualSize.w; $('winH').value = manualSize.h; }
  if(state.zoomMode) applyZoomTransform();
}
function setViewport(name){
  currentDevice = name; manualSize = null; rotated = false;
  $('vpDesktop').classList.toggle('active', name === 'desktop');
  $('vpTablet').classList.toggle('active', name === 'tablet');
  $('vpMobile').classList.toggle('active', name === 'mobile');
  if(name === 'desktop'){ $('winW').value = ''; $('winH').value = ''; }
  applyViewport();
}
function applyCustomSize(){ var w = parseInt($('winW').value, 10); var h = parseInt($('winH').value, 10); if(!w || w < 180) return; manualSize = { w: w, h: h && h >= 140 ? h : null }; applyViewport(); }
function toggleRotate(){ rotated = !rotated; applyViewport(); }
function fillPreview(){ manualSize = null; currentDevice = 'desktop'; $('vpDesktop').classList.add('active'); $('vpTablet').classList.remove('active'); $('vpMobile').classList.remove('active'); $('winW').value = ''; $('winH').value = ''; applyViewport(); }
function resetViewport(){ manualSize = null; rotated = false; $('winW').value = ''; $('winH').value = ''; setViewport(currentDevice); }

/* 八向拖拽 */
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
        var mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent;cursor:' + getComputedStyle(handle).cursor + ';touch-action:none';
        document.body.appendChild(mask);
        var wrapW = $('pvWrap').clientWidth - 24; var wrapH = $('pvWrap').clientHeight - 24;
        var activePointerId = e.pointerId;
        function onMove(ev){
          if(ev.pointerId !== undefined && activePointerId !== undefined && ev.pointerId !== activePointerId) return;
          var dx = ev.clientX - start.x, dy = ev.clientY - start.y;
          var nw = start.w, nh = start.h;
          if(dir.indexOf('e') >= 0) nw = start.w + dx;
          if(dir.indexOf('w') >= 0) nw = start.w - dx;
          if(dir.indexOf('s') >= 0) nh = start.h + dy;
          if(dir.indexOf('n') >= 0) nh = start.h - dy;
          nw = Math.max(180, Math.min(nw, wrapW)); nh = Math.max(140, Math.min(nh, wrapH));
          manualSize = { w: Math.round(nw), h: Math.round(nh) }; applyViewport();
        }
        function onUp(){ pv.classList.remove('nosmooth'); if(mask.parentNode) mask.parentNode.removeChild(mask); mask.removeEventListener('pointermove', onMove); mask.removeEventListener('pointerup', onUp); mask.removeEventListener('pointercancel', onUp); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); }
        mask.addEventListener('pointermove', onMove); mask.addEventListener('pointerup', onUp); mask.addEventListener('pointercancel', onUp);
        window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
      });
    })(handles[i]);
  }
})();

/* ================= 复制菜单 ================= */
function showCopyMenu(x, y, target){ state.pasteTarget = target || null; var menu = $('copyMenu'); menu.style.left = Math.min(x, window.innerWidth - 180) + 'px'; menu.style.top = Math.min(y, window.innerHeight - 220) + 'px'; menu.classList.add('show'); }
function hideCopyMenu(){ $('copyMenu').classList.remove('show'); }
function getActiveSelectable(){ var active = document.activeElement; if(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return active; if(state.editorReady && state.editor.hasTextFocus && state.editor.hasTextFocus()) return null; return state.pasteTarget; }
function doCopy(){ var el = getActiveSelectable(); var text = ''; if(state.editorReady && state.editor.hasTextFocus && state.editor.hasTextFocus()){ var sel = state.editor.getSelection(); text = (sel && !sel.isEmpty()) ? state.editor.getModel().getValueInRange(sel) : state.editor.getValue(); } else if(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')){ text = (el.selectionStart !== el.selectionEnd) ? el.value.slice(el.selectionStart, el.selectionEnd) : el.value; } else { var sel2 = window.getSelection(); if(sel2 && sel2.toString()) text = sel2.toString(); } if(text) copyText(text); hideCopyMenu(); }
function doCut(){ var el = getActiveSelectable(); if(!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')){ hideCopyMenu(); return; } var start = el.selectionStart || 0, end = el.selectionEnd || 0; var text = el.value.slice(start, end); if(text){ copyText(text); el.value = el.value.slice(0, start) + el.value.slice(end); el.selectionStart = el.selectionEnd = start; } hideCopyMenu(); }
function doPaste(){ var el = getActiveSelectable(); if(!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')){ hideCopyMenu(); return; } if(navigator.clipboard && navigator.clipboard.readText){ navigator.clipboard.readText().then(function(text){ var start = el.selectionStart || 0, end = el.selectionEnd || 0; el.value = el.value.slice(0, start) + text + el.value.slice(end); el.selectionStart = el.selectionEnd = start + text.length; el.dispatchEvent(new Event('input')); }).catch(function(){}); } hideCopyMenu(); }
function doSelectAll(){ var el = getActiveSelectable(); if(state.editorReady && state.editor.hasTextFocus && state.editor.hasTextFocus()) state.editor.setSelection(state.editor.getModel().getFullModelRange()); else if(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) el.select(); else { var sel = window.getSelection(); if(sel) sel.selectAllChildren(document.body); } hideCopyMenu(); }
function copyText(text){ if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).catch(function(){ var tmp = document.createElement('textarea'); tmp.value = text; document.body.appendChild(tmp); tmp.select(); try{ document.execCommand('copy'); }catch(e){} document.body.removeChild(tmp); }); } else { var tmp = document.createElement('textarea'); tmp.value = text; document.body.appendChild(tmp); tmp.select(); try{ document.execCommand('copy'); }catch(e){} document.body.removeChild(tmp); } }
function bindLongPress(el){
  if(!el) return;
  var timer = null, startX = 0, startY = 0, moved = false;
  el.addEventListener('touchstart', function(e){ if(e.touches.length !== 1) return; var touch = e.touches[0]; startX = touch.clientX; startY = touch.clientY; moved = false; timer = setTimeout(function(){ if(!moved){ var target = document.activeElement; showCopyMenu(touch.clientX, touch.clientY - 20, target); if(navigator.vibrate) navigator.vibrate(15); } }, 500); }, { passive: true });
  el.addEventListener('touchmove', function(e){ if(!timer) return; var touch = e.touches[0]; if(Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10){ moved = true; clearTimeout(timer); timer = null; } }, { passive: true });
  el.addEventListener('touchend', function(){ if(timer){ clearTimeout(timer); timer = null; } });
  el.addEventListener('touchcancel', function(){ if(timer){ clearTimeout(timer); timer = null; } });
}
(function(){ var targets = [$('prompt'), $('msgs'), $('fallbackTa')]; for(var i = 0; i < targets.length; i++) if(targets[i]) bindLongPress(targets[i]); })();

/* 点击空白处关闭复制菜单/组件菜单；点遮罩关闭工具抽屉 */
document.addEventListener('click', function(e){
  var menu = $('copyMenu');
  if(menu && menu.classList.contains('show') && !menu.contains(e.target)) hideCopyMenu();
  var compMenu = $('compMenu');
  if(compMenu && compMenu.classList.contains('show') && !compMenu.contains(e.target)) closeCompMenu();
  var mask = $('toolPanelMask');
  if(mask && mask.contains(e.target)) closeAllToolPanels();
});
document.addEventListener('touchstart', function(e){
  var menu = $('copyMenu');
  if(menu && menu.classList.contains('show') && !menu.contains(e.target)) hideCopyMenu();
  var compMenu = $('compMenu');
  if(compMenu && compMenu.classList.contains('show') && !compMenu.contains(e.target)) closeCompMenu();
}, { passive: true });

/* 长按预览区 800ms 开启移动检查器 */
(function(){
  var iframe = $('preview'); if(!iframe || !isMobile()) return;
  var pressTimer = null, moved = false, startX = 0, startY = 0;
  function start(){
    if(state.mobileInspectorActive || !state.editorReady) return;
    var doc; try{ doc = iframe.contentDocument || iframe.contentWindow.document; }catch(e){ return; } if(!doc) return;
    doc.addEventListener('touchstart', function(e){ if(e.touches.length !== 1) return; moved = false; startX = e.touches[0].clientX; startY = e.touches[0].clientY; pressTimer = setTimeout(function(){ if(!moved){ toggleMobileInspector(); if(navigator.vibrate) navigator.vibrate([15, 30, 15]); } }, 800); }, { passive: true });
    doc.addEventListener('touchmove', function(e){ if(!pressTimer) return; var dx = Math.abs(e.touches[0].clientX - startX); var dy = Math.abs(e.touches[0].clientY - startY); if(dx > 10 || dy > 10){ moved = true; clearTimeout(pressTimer); pressTimer = null; } }, { passive: true });
    doc.addEventListener('touchend', function(){ if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; } });
    doc.addEventListener('touchcancel', function(){ if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; } });
  }
  iframe.addEventListener('load', start); if(iframe.contentDocument && iframe.contentDocument.readyState === 'complete') start();
})();

/* ================= 输入监听 ================= */
(function(){
  var apiKey = $('apiKey'), baseUrl = $('baseUrl'), model = $('model'), profileName = $('profileName');
  function onChange(){ updateMode(); }
  if(apiKey) apiKey.addEventListener('input', onChange);
  if(baseUrl) baseUrl.addEventListener('input', onChange);
  if(model) model.addEventListener('change', function(){ state.currentModel = model.value; if(state.activeProfile >= 0 && state.keyProfiles[state.activeProfile]){ state.keyProfiles[state.activeProfile].model = model.value; saveKeyProfiles(); } try { renderAttachments(); } catch(e){} });
  if(profileName) profileName.addEventListener('input', onChange);
  var prompt = $('prompt');
  if(prompt){
    prompt.addEventListener('keydown', function(e){ if(e.key === 'Enter' && (e.metaKey || e.ctrlKey)){ e.preventDefault(); generate(); } });
    prompt.addEventListener('focus', function(){ setTimeout(function(){ document.body.classList.add('keyboard-open'); }, 100); });
    prompt.addEventListener('blur', function(){ setTimeout(function(){ document.body.classList.remove('keyboard-open'); }, 100); });
    prompt.addEventListener('input', function(){ prompt.style.height = 'auto'; prompt.style.height = Math.min(240, prompt.scrollHeight) + 'px'; });
  }
  if(window.visualViewport){ window.visualViewport.addEventListener('resize', function(){ var vh = window.visualViewport.height; var wh = window.innerHeight; if(vh < wh * 0.75) document.body.classList.add('keyboard-open'); else document.body.classList.remove('keyboard-open'); }); }
  try{ var sm = localStorage.getItem('cu-stream-mode'); if(sm !== null && $('streamMode')) $('streamMode').checked = sm === '1'; var rm = localStorage.getItem('cu-roast-mode'); if(rm !== null && $('roastMode')) $('roastMode').checked = rm === '1'; }catch(e){}
  if($('streamMode')) $('streamMode').addEventListener('change', function(){ localStorage.setItem('cu-stream-mode', this.checked ? '1' : '0'); });
  if($('roastMode')) $('roastMode').addEventListener('change', function(){ localStorage.setItem('cu-roast-mode', this.checked ? '1' : '0'); });
})();

document.addEventListener('keydown', function(e){
  if(e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.key !== '?'){ if(e.key === 'Escape') e.target.blur(); return; }
  var ctrl = e.ctrlKey || e.metaKey;
  if(ctrl && e.key === 'f'){ e.preventDefault(); toggleSearch(); }
  else if(ctrl && e.key === 'h'){ e.preventDefault(); showReplaceBar(); }
  else if(ctrl && e.key === 's'){ e.preventDefault(); manualSnapshot(); }
  else if(ctrl && e.key === 'k'){ e.preventDefault(); openProjects(); }
  else if(ctrl && e.key === 'm'){ e.preventDefault(); mergeToSingleHtml(); }
  else if(ctrl && e.key === 'z' && !e.shiftKey){ e.preventDefault(); undoCode(); }
  else if(ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))){ e.preventDefault(); redoCode(); }
  else if(ctrl && e.key === '/'){ e.preventDefault(); if(isMobile()) switchMobileTab(state.mobileTab === 'chat' ? 'code' : (state.mobileTab === 'code' ? 'preview' : 'chat')); }
  else if(e.key === '?'){ e.preventDefault(); showKbdPanel(); }
  else if(e.key === 'Escape'){
    closeTemplates(); closeTemplateForm(); closeKbdPanel(); hideCopyMenu(); closeRenameProject(); closeEditTemplate(); closeDiff(); closeGallery(); closeQRCode(); closePromptDropdown(); hideReplaceBar(); closeShareCard(); closeGitHubUpload(); closeCompMenu(); closeAllToolPanels();
    if(state.mobileInspectorActive) exitMobileInspector();
  }
});
document.addEventListener('keydown', function(e){
  if(!state.editorReady) return; if(!state.editor.hasTextFocus || !state.editor.hasTextFocus()) return;
  if(e.key === 'Tab' && !e.shiftKey){ e.preventDefault(); var sel = state.editor.getSelection(); if(sel && sel.startLineNumber !== sel.endLineNumber) state.editor.trigger('keyboard', 'editor.action.indentLines', null); else state.editor.trigger('keyboard', 'type', { text: '  ' }); }
  else if(e.key === 'Tab' && e.shiftKey){ e.preventDefault(); state.editor.trigger('keyboard', 'editor.action.outdentLines', null); }
});

/* ================= 启动 ================= */
window.addEventListener('load', function(){
  console.log('🚀 开始初始化...');
  try { loadTemplates(); } catch(e){ console.error(e); }
  try { loadProjects(); } catch(e){ console.error(e); }
  try { loadKeyProfiles(); } catch(e){ console.error(e); }
  try { loadActiveProjectIntoState(); } catch(e){ console.error(e); }
  try { initEditor(); } catch(e){ console.error(e); }
  try { initStyleBarSafely(); } catch(e){ console.error(e); }
  try { loadTheme(); } catch(e){ console.error(e); }
  try { setupDraftSave(); } catch(e){ console.error(e); }
  try{ var savedModify = localStorage.getItem('cu-modify-mode') === '1'; var cb = $('modifyMode'); if(cb){ cb.checked = savedModify; onModifyToggle(savedModify); } }catch(e){}
  try { var loadedShare = loadFromShareHash(); if(!loadedShare && state.messages.length === 0) renderGuide(); else if(!loadedShare) renderMessages(); } catch(e){ console.error(e); }
  try { refreshPreview(); } catch(e){ console.error(e); }
  try { applyViewport(); } catch(e){ console.error(e); }
  try { if(isMobile()) switchMobileTab('chat'); } catch(e){}
  pushUndo();
  window.addEventListener('resize', function(){ try { applyViewport(); } catch(e){} try { if(state.editorReady && isMobile() && state.mobileTab === 'code') state.editor.layout(); } catch(e){} });
  window.addEventListener('fullscreenchange', function(){ setTimeout(function(){ try { applyViewport(); } catch(e){} try { if(state.editorReady) state.editor.layout(); } catch(e){} }, 200); });
  setInterval(function(){ try { saveCurrentProject(); } catch(e){} }, 10000);
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
  var iconDice = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="16" cy="8" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="8" cy="16" r="1.5" fill="currentColor"/><circle cx="16" cy="16" r="1.5" fill="currentColor"/></svg>';
  g.innerHTML =
    '<div class="orb">' + iconSpark + '</div>' +
    '<h3>开始创造</h3>' +
    '<p>用一句话描述页面，AI 生成代码并实时预览。</p>' +
    '<div class="steps">' +
      '<div class="step"><div class="num">1</div><div class="txt"><b>描述需求</b><br>越具体越好</div></div>' +
      '<div class="step"><div class="num">2</div><div class="txt"><b>AI 生成代码</b><br>自动分区</div></div>' +
      '<div class="step"><div class="num">3</div><div class="txt"><b>预览调整</b><br>导出/分享/上传</div></div>' +
    '</div>' +
    '<div class="quick"><div class="qlabel">试试这些</div>' +
    '<button class="qcard" onclick="quickGen(\'生成一个深色玻璃质感的登录页\')"><span class="ic">' + iconLogin + '</span><div class="txt"><b>登录页</b><span>玻璃质感</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="quickGen(\'生成一个番茄钟计时器，圆形进度环\')"><span class="ic">' + iconTimer + '</span><div class="txt"><b>番茄钟</b><span>圆形进度</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="quickGen(\'生成一个现代待办清单应用\')"><span class="ic">' + iconList + '</span><div class="txt"><b>待办清单</b><span>增删改</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="quickGen(\'生成一个 SaaS 数据仪表盘\')"><span class="ic">' + iconDash + '</span><div class="txt"><b>数据仪表盘</b><span>导航·图表</span></div><span class="arrow">→</span></button>' +
    '<button class="qcard" onclick="randomInspiration()"><span class="ic">' + iconDice + '</span><div class="txt"><b>随机灵感</b><span>随机一个</span></div><span class="arrow">→</span></button>' +
    '</div>';
  msgs.appendChild(g);
}
function quickGen(p){ $('prompt').value = p; generate(); }
