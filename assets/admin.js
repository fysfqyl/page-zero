// admin.js —— 后台：用口令（GitHub 令牌）直接读写仓库，发布 = 提交一次 commit。
// 不依赖任何后端：浏览器 → GitHub REST API → 仓库 → GitHub Pages 自动构建。
//
//   token      放在 localStorage 或 sessionStorage，键名 pz.admin.token
//   manifest   posts/index.json：首页列表的唯一数据源
//   post       每篇文章是一个完整的静态页面 posts/pNNN.html，由 buildPage() 生成

import { wireTheme, wireReadouts, wireDialogs, closeDialog, toast, flashDone } from './fx.js';

const OWNER = 'fysfqyl';
const REPO = 'page-zero';
const BRANCH = 'main';
const API = 'https://api.github.com';
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
const MANIFEST = 'posts/index.json';
const TOKEN_KEY = 'pz.admin.token';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let token = '';
let posts = []; // 索引里的文章，按编号升序
let editing = null; // { no, file, title, date, category, lede, isNew }
let pendingDelete = null;
let busy = false;

/* ---------- 小工具 ---------- */

const pad = (n) => String(n).padStart(3, '0');
const dots = (d) => String(d || '').replace(/-/g, '.');
const group = (n) => Number(n || 0).toLocaleString('zh-CN');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const indent = (text, spaces) =>
  String(text)
    .split('\n')
    .map((line) => (line ? ' '.repeat(spaces) + line : line))
    .join('\n');

const today = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

// 与 scripts/count.py 同一口径：正文（含小标题）去掉所有空白后的字符数。
const countChars = (html) => {
  const box = document.createElement('div');
  box.innerHTML = html || '';
  return (box.textContent || '').replace(/\s+/g, '').length;
};
const minutes = (n) => Math.max(1, Math.round(Number(n || 0) / 400));

/* ---------- 与 GitHub 通信 ---------- */

function friendly(status, message) {
  if (status === 401) return '令牌无效或已过期，请重新登录。';
  if (status === 403) return '令牌没有写权限，或短时间内请求过多，请稍后再试。';
  if (status === 404) return '找不到内容：令牌可能没有这个仓库的权限。';
  if (status === 409 || status === 422) return '提交冲突：仓库刚刚被改过，请再试一次。';
  return message || `请求失败（HTTP ${status}）`;
}

async function gh(path, { method = 'GET', body, raw = false } = {}) {
  // path 可以是 /repos/... 这样的相对路径，也可以是完整 URL；两种都认。
  const url = /^https?:\/\//i.test(path) ? path : API + path;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const send = () =>
    fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined }).catch((e) => {
      const err = new Error(
        `网络请求失败：${method} ${url}（${e.message}）。可能是代理/VPN 不稳定或浏览器扩展拦截，请稍后重试。`,
      );
      err.network = true;
      throw err;
    });

  // 网络层抖动重试一次；HTTP 状态码错误不重试。
  let res = await send();
  if (!res.ok && res.status >= 500) res = await send();

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {}
    const err = new Error(friendly(res.status, detail));
    err.status = res.status;
    throw err;
  }
  if (raw) return res.text();
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const readFile = async (path) => {
  try {
    return await gh(`/repos/${OWNER}/${REPO}/contents/${path}`, { raw: true });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
};

// 一次 commit 写入多个文件（也可以删除：内容给 null）。base_tree 让没提到的文件保持原样。
async function commit(changes, message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ref = await gh(`${REPO_PATH}/git/ref/heads/${BRANCH}`);
    const head = await gh(`${REPO_PATH}/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        tree.push({ path, mode: '100644', type: 'blob', sha: null });
      } else {
        const blob = await gh(`${REPO_PATH}/git/blobs`, { method: 'POST', body: { content, encoding: 'utf-8' } });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const nextTree = await gh(`${REPO_PATH}/git/trees`, {
      method: 'POST',
      body: { base_tree: head.tree.sha, tree },
    });
    const made = await gh(`${REPO_PATH}/git/commits`, {
      method: 'POST',
      body: { message, tree: nextTree.sha, parents: [ref.object.sha] },
    });
    try {
      await gh(`${REPO_PATH}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: made.sha, force: false } });
      return made;
    } catch (e) {
      if (e.status === 422 || e.status === 409) continue; // 别人刚提交过：重来一次
      throw e;
    }
  }
  throw new Error('提交冲突：仓库刚刚被改过，请再试一次。');
}

/* ---------- 正文清洗 ---------- */

// 编辑器里回车时浏览器可能生成 <div>，粘贴也可能留下裸文本。
// 统一成 <p> / <h2> 这样的块，站点样式（段落间距、小标题）才对得上。
const BLOCK = new Set(['P', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'FIGURE', 'DIV']);
const isBlankNode = (el) => !(el.textContent || '').replace(/[\s\u00a0]/g, '') && !el.querySelector('img');

function normalizeBody(html) {
  const box = document.createElement('div');
  box.innerHTML = html || '';
  const out = document.createDocumentFragment();
  let run = null;

  const flush = () => {
    if (!run) return;
    const p = document.createElement('p');
    p.innerHTML = run.innerHTML;
    if ((p.textContent || '').replace(/[\s\u00a0]/g, '')) out.appendChild(p);
    run = null;
  };

  [...box.childNodes].forEach((node) => {
    const isText = node.nodeType === 3;
    const isInline = node.nodeType === 1 && !BLOCK.has(node.tagName) && node.tagName !== 'BR';
    if (isText || isInline) {
      run = run || document.createElement('span');
      run.appendChild(node.cloneNode(true));
      return;
    }
    if (node.nodeType === 1 && node.tagName === 'BR') {
      flush();
      return;
    }
    flush();
    if (node.nodeType !== 1) return;
    if ((node.tagName === 'P' || node.tagName === 'DIV') && isBlankNode(node)) return; // 空行
    if (node.tagName === 'DIV') {
      const p = document.createElement('p');
      p.innerHTML = node.innerHTML;
      out.appendChild(p);
      return;
    }
    out.appendChild(node.cloneNode(true));
  });
  flush();

  const holder = document.createElement('div');
  holder.appendChild(out);
  return holder.innerHTML.trim();
}

const ALLOWED = new Set([
  'P', 'H2', 'H3', 'H4', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'BR', 'HR',
  'A', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'CODE', 'PRE', 'SPAN', 'DIV', 'FIGURE', 'FIGCAPTION',
]);
const DROP = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|FORM|INPUT|BUTTON|TEXTAREA|SELECT|NAV|FOOTER|HEADER|SVG)$/;

function cleanBody(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const walk = (root) => {
    [...root.children].forEach((el) => {
      if (DROP.test(el.tagName)) {
        el.remove();
        return;
      }
      if (!ALLOWED.has(el.tagName)) {
        const frag = document.createDocumentFragment();
        while (el.firstChild) frag.appendChild(el.firstChild);
        el.replaceWith(frag);
        walk(root); // 子节点提上来了，重新过一遍
        return;
      }
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (el.tagName === 'A' && name === 'href') {
          if (/^(https?:\/\/|\.{0,2}\/|#|mailto:)/i.test(attr.value)) {
            el.setAttribute('rel', 'noopener');
          } else {
            el.removeAttribute(attr.name);
          }
          return;
        }
        el.removeAttribute(attr.name); // 其他属性一律去掉（style、class、on* …）
      });
      walk(el);
    });
  };
  walk(tpl.content);
  const holder = document.createElement('div');
  holder.appendChild(tpl.content.cloneNode(true));
  return holder.innerHTML.trim();
}

/* ---------- 生成文章页面 ---------- */

function buildPage(post, list) {
  const no = `No.${pad(post.no)}`;
  const words = Number(post.words || 0);
  const sorted = [...list].sort((a, b) => a.no - b.no);
  const at = sorted.findIndex((p) => p.no === post.no);
  const prev = at > 0 ? sorted[at - 1] : null;
  const next = at >= 0 && at < sorted.length - 1 ? sorted[at + 1] : null;
  const related = sorted
    .filter((p) => p.no !== post.no)
    .sort((a, b) => Math.abs(a.no - post.no) - Math.abs(b.no - post.no) || a.no - b.no)
    .slice(0, 2)
    .sort((a, b) => a.no - b.no);

  const description = `${post.lede || post.title} 第零页生活随笔 ${no}。`;

  const record = (p) => `<li><a class="ef-record" href="${esc(p.file)}">
  <span class="ef-tag">No.${pad(p.no)}</span>
  <time class="ef-field" datetime="${esc(p.date)}">${dots(p.date)}</time>
  <span class="name ef-read">${esc(p.title)}</span>
  <span class="ef-field">${group(p.words)} 字</span>
</a></li>`;

  const relatedBlock = related.length
    ? `
          <h2 class="ef-group-head"><span>相关记录</span><span class="ef-field">${related.length} 篇</span></h2>
          <ol class="ef-records">
${indent(related.map(record).join('\n'), 12)}
          </ol>`
    : '';

  const turnRows =
    [
      prev ? `<li><a href="${esc(prev.file)}">上一篇</a><span class="ef-field">No.${pad(prev.no)}</span></li>` : '',
      next ? `<li><a href="${esc(next.file)}">下一篇</a><span class="ef-field">No.${pad(next.no)}</span></li>` : '',
    ]
      .filter(Boolean)
      .join('\n            ') || `<li><a href="../index.html">全部文章</a><span class="ef-field">共 ${list.length} 篇</span></li>`;

  const pageBtns = [
    prev ? `<a class="ef-btn" href="${esc(prev.file)}">上一篇<span class="sub">No.${pad(prev.no)}</span></a>` : '',
    next ? `<a class="ef-btn" href="${esc(next.file)}">下一篇<span class="sub">No.${pad(next.no)}</span></a>` : '',
    `<a class="ef-btn go" href="../index.html">全部文章</a>`,
  ]
    .filter(Boolean)
    .join('\n            ');

  return `<!doctype html>
<html lang="zh-CN" data-ef-variant="standard">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(post.title)} · 枫叶随风的博客</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="icon" href="../assets/favicon.svg" type="image/svg+xml" />
    <script>
      try {
        const t = localStorage.getItem('theme');
        if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
      } catch (e) {}
    </script>
    <meta name="theme-color" content="#F4F4F2" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#191919" media="(prefers-color-scheme: dark)" />
    <script src="../assets/variant.js"></script>
    <link rel="stylesheet" href="../assets/endfield.css" />
    <link rel="stylesheet" href="../assets/site.css" />
  </head>
  <body class="ef ef-contours">
    <div class="ef-tri" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="shell">
      <nav class="ef-rail rail" aria-label="主导航">
        <a class="brand" href="../index.html"><small>Maple in Wind</small><span>枫叶随风</span></a>
        <a href="../index.html">首页</a>
        <a href="../index.html" aria-current="page">文章</a>
        <a href="../index.html#about">关于</a>
        <a href="https://github.com/fysfqyl/page-zero">仓库</a>
        <div class="rail-util">
          <button class="ef-btn small" type="button" data-theme-toggle>切换深浅</button>
        </div>
      </nav>

      <article class="ef-spread">
        <div class="ef-sheet">
          <p class="ef-crumb ef-field"><a href="../index.html">全部文章</a><span>${no}</span></p>
          <p class="ids">
            <span class="ef-tag is-current">${no}</span>
            <span class="ef-kv"><span>分类</span><span>${esc(post.category)}</span></span>
          </p>
          <ul class="ef-facts ef-field">
            <li><time datetime="${esc(post.date)}">${dots(post.date)}</time></li>
            <li data-fx-load>${group(words)} 字</li>
            <li>约 ${minutes(words)} 分钟</li>
          </ul>
          <h1 class="title ef-read">${esc(post.title)}</h1>
          <div class="ef-tri" aria-hidden="true"><i></i><i></i><i></i></div>
${post.lede ? `          <p class="ef-lede ef-read">${esc(post.lede)}</p>\n` : ''}
          <div class="ef-prose">
${indent(post.body || '<p></p>', 12)}
          </div>
${relatedBlock}
          <p class="ef-actions nav-actions">
            ${pageBtns}
          </p>
        </div>

        <aside class="ef-margin" aria-label="本篇信息">
          <h2 class="ef-field margin-h">本篇</h2>
          <ul class="ef-ledger">
            <li><span>编号</span><span class="ef-field">${no}</span></li>
            <li><span>分类</span><span class="ef-field">${esc(post.category)}</span></li>
            <li><span>字数</span><span class="ef-field">${group(words)} 字</span></li>
            <li><span>发布</span><span class="ef-field">${dots(post.date)}</span></li>
          </ul>
          <h2 class="ef-field margin-h">翻页</h2>
          <ul class="ef-ledger">
            ${turnRows}
          </ul>
        </aside>
      </article>
    </div>

    <script type="module">
      import { wireTheme, wireReadouts } from '../assets/fx.js';
      wireTheme();
      wireReadouts(document);
    </script>
  </body>
</html>
`;
}

/* ---------- 索引 ---------- */

function manifestText(list) {
  const sorted = [...list].sort((a, b) => a.no - b.no);
  const latest = sorted.reduce((d, p) => (String(p.date) > d ? String(p.date) : d), '');
  return `${JSON.stringify({ site: '枫叶随风的博客', updated: latest, posts: sorted }, null, 2)}\n`;
}

async function scanPosts() {
  const dir = await gh(`${REPO_PATH}/contents/posts`);
  const files = (Array.isArray(dir) ? dir : []).filter((f) => f.type === 'file' && /^p\d{3,}\.html$/i.test(f.name));
  const out = [];
  for (const file of files) {
    try {
      const html = await readFile(`posts/${file.name}`);
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      const prose = doc.querySelector('.ef-prose');
      out.push({
        no: Number(file.name.replace(/\D/g, '')),
        file: file.name,
        title: doc.querySelector('h1.title')?.textContent.trim() || doc.title.replace(/\s*·.*$/, ''),
        date: doc.querySelector('time[datetime]')?.getAttribute('datetime') || '',
        category: doc.querySelector('.ids .ef-kv > :last-child')?.textContent.trim() || '随笔',
        words: prose ? (prose.textContent || '').replace(/\s+/g, '').length : 0,
      });
    } catch (e) {
      console.warn('跳过一篇文章', file.name, e);
    }
  }
  return out.sort((a, b) => a.no - b.no);
}

/* ---------- 视图 ---------- */

function showView(name) {
  $$('[data-view]').forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
}

function setStatus(text, flag = '状态') {
  const box = $('#list-status');
  if (!box) return;
  box.hidden = !text;
  box.dataset.flag = flag;
  box.textContent = text || '';
}

function setSideToken() {
  const el = $('#side-token');
  if (el) el.textContent = token ? '已登录' : '未登录';
}

/* ---------- 列表 ---------- */

function renderList() {
  const list = $('#post-list');
  const empty = $('#list-empty');
  const rows = [...posts].sort((a, b) => b.no - a.no);

  $('#side-count').textContent = `${posts.length} 篇`;
  $('#post-count').textContent = `共 ${posts.length} 篇`;
  list.hidden = !rows.length;
  empty.hidden = rows.length > 0;

  list.innerHTML = rows
    .map(
      (p) => `<li>
              <div class="admin-row-main">
                <a class="name" href="../posts/${esc(p.file)}" target="_blank" rel="noopener">${esc(p.title)}</a>
                <div class="meta">
                  <span>No.${pad(p.no)}</span>
                  <span>${dots(p.date)}</span>
                  <span>${esc(p.category)}</span>
                  <span>${group(p.words)} 字</span>
                </div>
              </div>
              <div class="acts">
                <button class="ef-btn small" type="button" data-edit="${esc(p.file)}">编辑</button>
                <button class="ef-btn small danger" type="button" data-del="${esc(p.file)}">删除</button>
              </div>
            </li>`,
    )
    .join('');
}

/* ---------- 编辑器 ---------- */

function syncCounts() {
  const n = countChars($('#editor').innerHTML);
  $('#word-count').textContent = `${group(n)} 字`;
  $('#min-count').textContent = `约 ${minutes(n)} 分钟`;
}

function showFormError(text) {
  const box = $('#form-error');
  box.hidden = !text;
  box.textContent = text || '';
}

async function openEditor(entry) {
  showFormError('');
  const nextNo = posts.reduce((max, p) => Math.max(max, Number(p.no) || 0), 0) + 1;

  editing = entry
    ? { ...entry, isNew: false }
    : { no: nextNo, file: `p${pad(nextNo)}.html`, title: '', date: today(), category: '', lede: '', isNew: true };

  $('#f-no').value = `No.${pad(editing.no)}`;
  $('#f-title').value = entry ? entry.title : '';
  $('#f-date').value = entry ? entry.date : today();
  $('#f-category').value = entry ? entry.category : '';
  $('#f-lede').value = '';
  $('#editor').innerHTML = '';
  $('#editor-crumb').textContent = `No.${pad(editing.no)}`;
  $('#editor-title').textContent = entry ? '编辑文章' : '写新文章';
  $('#btn-delete').hidden = !entry;
  $('#btn-save').textContent = entry ? '保存修改' : '发布文章';
  syncCounts();
  showView('editor');

  if (entry) {
    const html = await readFile(`posts/${entry.file}`);
    if (!html) {
      showFormError('这篇文件已经不在仓库里了，可能刚被删除。');
      return;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    $('#f-title').value = doc.querySelector('h1.title')?.textContent.trim() || entry.title;
    $('#f-date').value = doc.querySelector('time[datetime]')?.getAttribute('datetime') || entry.date;
    $('#f-category').value = doc.querySelector('.ids .ef-kv > :last-child')?.textContent.trim() || entry.category;
    $('#f-lede').value = doc.querySelector('.ef-lede')?.textContent.trim() || '';
    $('#editor').innerHTML = (doc.querySelector('.ef-prose')?.innerHTML || '').trim();
    syncCounts();
  }

  if (!entry) $('#f-title').focus();
}

function readForm() {
  return {
    title: $('#f-title').value.trim(),
    date: $('#f-date').value || today(),
    category: $('#f-category').value.trim() || '随笔',
    lede: $('#f-lede').value.trim(),
    body: normalizeBody(cleanBody($('#editor').innerHTML)),
  };
}

async function savePost(btn) {
  if (busy) return;
  showFormError('');
  const data = readForm();
  const chars = countChars(data.body);

  if (!data.title) return showFormError('标题还没有写。');
  if (!chars) return showFormError('正文还是空的。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return showFormError('日期格式不对，应该是 2026-10-24。');

  const entry = {
    no: editing.no,
    file: editing.file,
    title: data.title,
    date: data.date,
    category: data.category,
    words: chars,
  };
  const nextList = [...posts.filter((p) => p.no !== entry.no), entry].sort((a, b) => a.no - b.no);
  const page = buildPage({ ...entry, lede: data.lede, body: data.body }, nextList);

  busy = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    await commit(
      { [`posts/${entry.file}`]: page, [MANIFEST]: manifestText(nextList) },
      `${editing.isNew ? '新建' : '更新'}文章 No.${pad(entry.no)}《${entry.title}》`,
    );
    posts = nextList;
    renderList();
    showView('list');
    setStatus(`《${entry.title}》已${editing.isNew ? '发布' : '保存'}，GitHub Pages 正在构建，约 1 分钟后上线。`, '完成');
    toast(`已${editing.isNew ? '发布' : '保存'}：${entry.title}`);
    flashDone(btn, '已保存');
  } catch (e) {
    showFormError(e.message || String(e));
  } finally {
    busy = false;
    btn.removeAttribute('aria-busy');
  }
}

function askDelete(entry) {
  pendingDelete = entry;
  $('#confirm-text').textContent = `《${entry.title}》会被从仓库里删除，首页列表同步更新。GitHub 的提交历史里仍然找得回来。`;
  $('#confirm').showModal();
}

async function doDelete() {
  if (busy || !pendingDelete) return;
  const entry = pendingDelete;
  const yes = $('#confirm-yes');
  busy = true;
  yes.setAttribute('aria-busy', 'true');
  try {
    const nextList = posts.filter((p) => p.no !== entry.no);
    await commit(
      { [`posts/${entry.file}`]: null, [MANIFEST]: manifestText(nextList) },
      `删除文章 No.${pad(entry.no)}《${entry.title}》`,
    );
    posts = nextList;
    renderList();
    await closeDialog($('#confirm'));
    if (editing && editing.file === entry.file) {
      editing = null;
      showView('list');
    }
    setStatus(`《${entry.title}》已删除。`, '完成');
    toast('已删除');
  } catch (e) {
    await closeDialog($('#confirm'));
    setStatus(e.message || String(e), '出错');
  } finally {
    busy = false;
    yes.removeAttribute('aria-busy');
    pendingDelete = null;
  }
}

/* ---------- 登录 ---------- */

async function signIn(candidate, remember) {
  token = candidate.trim();
  const me = await gh('/user');
  const repo = await gh(`/repos/${OWNER}/${REPO}`);
  if (!repo.permissions?.push) {
    token = '';
    throw new Error(`令牌能读到 ${OWNER}/${REPO}，但没有写权限。请在令牌里把 Contents 设为 Read and write。`);
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {}
  setSideToken();
  $('#side-user').textContent = me.login || '已登录';
  return repo.default_branch === BRANCH;
}

async function boot() {
  setSideToken();
  // 令牌不对就在这里抛错（401/403），由调用方决定是退回登录还是提示重试
  const me = await gh('/user');
  const who = $('#side-user');
  if (who) who.textContent = me.login || '已登录';
  try {
    const text = await readFile(MANIFEST);
    if (text) {
      posts = (JSON.parse(text).posts || []).filter((p) => p && p.file).sort((a, b) => a.no - b.no);
    } else {
      posts = await scanPosts();
      if (posts.length) {
        await commit({ [MANIFEST]: manifestText(posts) }, '生成文章索引 posts/index.json');
        toast('已根据现有文章生成索引');
      }
    }
  } catch (e) {
    setStatus(`读取索引失败：${e.message}`, '出错');
  }
  renderList();
  showView('list');
}

/* ---------- 事件 ---------- */

wireTheme();
wireReadouts(document);
wireDialogs(document);

// 令牌优先取 localStorage（记住），其次 sessionStorage（只在本次会话）
try {
  const saved = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  if (saved) token = saved;
} catch {}

if (token) {
  setSideToken();
  boot().catch((e) => {
    // 令牌真的无效（401/403）才清掉；网络问题保留令牌，下次刷新再试
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      token = '';
      try {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {}
      setSideToken();
    }
    $('#login-error').hidden = false;
    $('#login-error').textContent = e.message || String(e);
    showView('login');
  });
} else {
  showView('login');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const box = $('#login-error');
  box.hidden = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    await signIn($('#f-token').value, $('#f-remember').checked);
    await boot();
    toast('已登录');
  } catch (err) {
    box.hidden = false;
    box.textContent = err.message || String(err);
  } finally {
    btn.removeAttribute('aria-busy');
  }
});

$('#btn-logout').addEventListener('click', () => {
  token = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
  posts = [];
  editing = null;
  setSideToken();
  $('#side-user').textContent = '—';
  showView('login');
  toast('已退出，令牌已从这台设备清除');
});

$('#btn-new').addEventListener('click', () => {
  setStatus('');
  openEditor(null);
});

$('#btn-back').addEventListener('click', (e) => {
  e.preventDefault();
  editing = null;
  showView('list');
});
$('#btn-back-2').addEventListener('click', () => {
  editing = null;
  showView('list');
});

$('#post-list').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    const entry = posts.find((p) => p.file === edit.dataset.edit);
    if (entry) {
      setStatus('');
      openEditor(entry);
    }
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    const entry = posts.find((p) => p.file === del.dataset.del);
    if (entry) askDelete(entry);
  }
});

$('#post-form').addEventListener('submit', (e) => {
  e.preventDefault();
  savePost($('#btn-save'));
});

$('#btn-delete').addEventListener('click', () => {
  const entry = posts.find((p) => p.file === editing?.file);
  if (entry) askDelete(entry);
});

$('#confirm-yes').addEventListener('click', doDelete);

$('#btn-reindex').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  try {
    const scanned = await scanPosts();
    if (!scanned.length) {
      setStatus('posts/ 目录下没有找到文章。', '状态');
      return;
    }
    await commit({ [MANIFEST]: manifestText(scanned) }, '根据现有文章重建索引 posts/index.json');
    posts = scanned;
    renderList();
    setStatus(`已按仓库里的 ${scanned.length} 篇文章重建索引。`, '完成');
    toast('索引已重建');
  } catch (err) {
    setStatus(err.message || String(err), '出错');
  } finally {
    btn.removeAttribute('aria-busy');
  }
});

// 工具栏：execCommand 在 Chrome / Edge / Safari / Firefox 里都还能用
$$('[data-cmd]').forEach((btn) => {
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // 别丢选区
  btn.addEventListener('click', () => {
    const editor = $('#editor');
    editor.focus();
    const cmd = btn.dataset.cmd;
    if (cmd === 'link') {
      const url = prompt('链接地址（https://…）', 'https://');
      if (url && /^https?:\/\//i.test(url)) document.execCommand('createLink', false, url);
    } else if (cmd === 'clear') {
      document.execCommand('removeFormat');
      document.execCommand('formatBlock', false, 'p');
    } else {
      document.execCommand(cmd, false, btn.dataset.value || null);
    }
    syncCounts();
  });
});

// 回车默认生成 <p>，而不是 <div>（Chrome 的默认值）
try {
  document.execCommand('defaultParagraphSeparator', false, 'p');
} catch {}

$('#editor').addEventListener('input', syncCounts);
$('#editor').addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  const html = text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => `<p>${esc(block).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
  document.execCommand('insertHTML', false, html);
  syncCounts();
});

$('#btn-preview').addEventListener('click', () => {
  const data = readForm();
  const entry = {
    no: editing.no,
    file: editing.file,
    title: data.title || '（还没写标题）',
    date: data.date || today(),
    category: data.category,
    lede: data.lede,
    words: countChars(data.body),
  };
  const list = [...posts.filter((p) => p.no !== entry.no), entry].sort((a, b) => a.no - b.no);
  let page = buildPage({ ...entry, body: data.body || '<p>（正文还是空的）</p>' }, list);
  const base = new URL('posts/', location.href).href;
  page = page.replace('<head>', `<head>\n    <base href="${base}" />`);
  $('#preview-frame').srcdoc = page;
  $('#preview').showModal();
});

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
  if (editing && !$('#view-editor').hidden) {
    e.preventDefault();
    savePost($('#btn-save'));
  }
});

// 有没保存的改动时，离开页面提醒一下
window.addEventListener('beforeunload', (e) => {
  if (!editing || $('#view-editor').hidden) return;
  const changed = $('#f-title').value.trim() || countChars($('#editor').innerHTML) > 0;
  if (changed) {
    e.preventDefault();
    e.returnValue = '';
  }
});
