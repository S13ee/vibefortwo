/* Vibe for Two
   - config.js 에 Supabase 정보가 있으면: 로그인 + Supabase 저장 (LIVE)
   - 없으면: 미리보기 모드 (이 브라우저에만 저장, 관리자/멤버/방문자 화면을 바꿔 볼 수 있음) */

const CFG = window.VFT_CONFIG || {};
const ASSET = window.VFT_ASSETS || {};
const GLYPH = window.VFT_GLYPH;
const LIVE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase);
const sb = LIVE ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
const BUCKET = 'vft-files';
const KEY = 'vibe-for-two-v2', OLD_KEY = 'vibe-for-two-v1';
const WD = ['일','월','화','수','목','금','토'];
const TEXT_EXT = /\.(html?|css|js|mjs|ts|jsx|tsx|json|md|txt|csv|svg|xml|py|yml|yaml)$/i;
const MAX_FILE = LIVE ? 10 * 1024 * 1024 : 700 * 1024;
const PROG = [0,10,20,30,40,50,60,70,80,90,100];
const ROLE_LV = { pending: 0, member: 1, manager: 2, admin: 3 };
const ROLE_KO = { pending: '승인 대기', member: '멤버', manager: '매니저', admin: '관리자' };

const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const blankEntry = () => ({ title:'', topic:'', detail:'', url:'', plan:'', html:'', files:[], progress:0, done:false });
const kindOf = (name, type) => TEXT_EXT.test(name) || (type || '').startsWith('text/') ? 'text' : (type || '').startsWith('image/') ? 'image' : 'other';

let state = { members: [], projects: [], works: [] };
const auth = { user: null, me: null };
const ui = { view:'home', pid:null, panel:null, tab:'plan', htmlView:'code', viewFile:null, viewData:null, pendingDel:null,
  worksBy:'all', work:null, memberMenu:null, confirmRemove:null, showPending:false, pendingNote:null, authTab:'login', authMsg:null, busy:false, loadError:null };

/* ---------- permissions ---------- */
const lv = () => auth.me ? (ROLE_LV[auth.me.role] || 0) : 0;
const can = {
  write: () => lv() >= 1,
  manage: () => lv() >= 2,
  admin: () => lv() >= 3,
  entry: mid => lv() >= 3 || (lv() >= 1 && auth.me.id === mid),
  delNote: n => lv() >= 2 || (lv() >= 1 && n.by === auth.me.id),
  editMember: m => !!(m && auth.me && m.id !== auth.me.id && (lv() >= 3 || (lv() >= 2 && ROLE_LV[m.role] <= 1)))
};
const active = () => state.members.filter(m => m.role !== 'pending');
const pendings = () => state.members.filter(m => m.role === 'pending');
const cur = () => state.projects.find(p => p.id === ui.pid) || state.projects[0];
function ent(p, mid) { if (!p.entries[mid]) p.entries[mid] = blankEntry(); return p.entries[mid]; }

/* ---------- save status ---------- */
let saveState = 'idle';
function setSave(s, err) {
  saveState = s;
  const n = document.getElementById('savenote'); if (!n) return;
  n.classList.toggle('warn', s === 'err');
  if (s === 'saving') n.textContent = '저장 중…';
  else if (s === 'err') n.textContent = LIVE ? '저장하지 못했습니다. ' + friendly(err) : '저장 공간이 부족합니다. 큰 파일을 지워 주세요.';
  else n.textContent = statusLine();
}
function statusLine() {
  if (!LIVE) return '미리보기 모드 · 이 브라우저에만 저장됩니다';
  if (!auth.user) return '로그인하면 내용을 작성할 수 있습니다';
  if (!auth.me) return '멤버 신청 후 작성할 수 있습니다';
  if (auth.me.role === 'pending') return '가입 승인을 기다리는 중입니다';
  return '변경 사항은 자동으로 저장됩니다';
}
function friendly(e) {
  const m = (e && (e.message || e.error_description)) || '';
  if (/row-level security|permission|42501/i.test(m)) return '권한이 없습니다.';
  if (/기간은 관리자만/.test(m)) return '프로젝트 기간은 관리자만 바꿀 수 있습니다.';
  if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인해 주세요.';
  if (/duplicate key/i.test(m)) return '이미 있는 항목입니다. 새로고침 후 다시 시도해 주세요.';
  return m ? m : '잠시 후 다시 시도해 주세요.';
}
const timers = {}, patches = {};
function queueEntry(p, mid, patch) {
  const k = p.id + '|' + mid;
  patches[k] = Object.assign(patches[k] || {}, patch);
  clearTimeout(timers[k]); setSave('saving');
  timers[k] = setTimeout(async () => {
    const body = patches[k]; delete patches[k];
    try { await Store.saveEntry(p, mid, body); setSave('ok'); } catch (e) { console.error(e); setSave('err', e); }
  }, 650);
}
function queueProject(p, patch, ms = 650) {
  const k = 'p|' + p.id;
  patches[k] = Object.assign(patches[k] || {}, patch);
  clearTimeout(timers[k]); setSave('saving');
  timers[k] = setTimeout(async () => {
    const body = patches[k]; delete patches[k];
    try { await Store.updateProject(p, body); setSave('ok'); } catch (e) { console.error(e); setSave('err', e); if (LIVE) refresh(); }
  }, ms);
}
const busySaving = () => Object.keys(patches).length > 0;

/* ---------- preview store (no Supabase) ---------- */
const Local = {
  demoAs: 'admin',
  async init() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!s) { try { s = migrate(JSON.parse(localStorage.getItem(OLD_KEY))); } catch (e) {} }
    if (!s || !Array.isArray(s.projects) || !s.projects.length || !Array.isArray(s.members)) s = demoSeed();
    state = s; state.works = state.works || []; state.projects.forEach(p => { p.notes = p.notes || []; p.entries = p.entries || {}; });
    try { this.demoAs = localStorage.getItem(KEY + ':as') || 'admin'; } catch (e) {}
    this.applyDemo();
  },
  applyDemo() {
    const admin = state.members.find(m => m.role === 'admin');
    const member = state.members.find(m => m.role === 'member' || m.role === 'manager');
    auth.me = this.demoAs === 'admin' ? admin : this.demoAs === 'member' ? member : null;
    auth.user = auth.me ? { id: 'demo' } : null;
  },
  setDemo(who) { this.demoAs = who; try { localStorage.setItem(KEY + ':as', who); } catch (e) {} this.applyDemo(); },
  persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); setSave('ok'); } catch (e) { setSave('err', e); } },
  async reload() {},
  async createProject(no) { const np = { id: uid(), no, sub:'', start:'', end:'', entries:{}, notes:[] }; state.projects.push(np); this.persist(); return np; },
  async updateProject(p) { this.persist(); },
  async saveEntry() { this.persist(); },
  async addNote(p, text) { p.notes.unshift({ id: uid(), text, by: auth.me ? auth.me.id : null, at: Date.now() }); this.persist(); },
  async delNote(p, id) { p.notes = p.notes.filter(n => n.id !== id); this.persist(); },
  async uploadFile(p, mid, f) {
    const rec = { id: uid(), name: f.name, size: f.size, type: f.type, added: Date.now(), kind: kindOf(f.name, f.type), data: null };
    if (f.size > MAX_FILE) rec.big = true;
    else if (rec.kind === 'text') rec.data = await f.text();
    else if (rec.kind === 'image') rec.data = await readAsDataURL(f);
    ent(p, mid).files.unshift(rec); this.persist();
  },
  async delFile(p, mid, rec) { const e = ent(p, mid); e.files = e.files.filter(f => f.id !== rec.id); this.persist(); },
  async fileContent(rec) { return rec.data; },
  async setRole(m, role) { m.role = role; this.persist(); },
  async removeMember(m) { state.members = state.members.filter(x => x.id !== m.id); state.projects.forEach(p => delete p.entries[m.id]); state.works = state.works.filter(w => w.by !== m.id); this.persist(); },
  async saveWork(prev, data, opt) {
    let image = prev ? prev.image : null;
    if (opt.removeImg) image = null;
    if (opt.file) { if (opt.file.size > MAX_FILE) throw new Error('미리보기 모드에서는 700KB 이하 이미지만 올릴 수 있습니다.'); image = await readAsDataURL(opt.file); }
    if (prev) { Object.assign(prev, data, { image }); this.persist(); return prev; }
    const w = Object.assign({ id: uid(), by: auth.me.id, at: Date.now(), image }, data); state.works.unshift(w); this.persist(); return w;
  },
  async delWork(w) { state.works = state.works.filter(x => x.id !== w.id); this.persist(); }
};
function demoSeed() {
  const members = [{ id:'sun', name:'SUN', role:'member' }, { id:'bee', name:'BEE', role:'admin' }];
  return { members, projects: [{ id: uid(), no: 1, sub: '스터디 웹 만들기', start: '2026-10-12', end: '2026-10-25', entries: {}, notes: [] }] };
}
function migrate(old) {
  if (!old || !Array.isArray(old.projects)) return null;
  const members = (old.members || []).map(m => ({ id: m.id, name: m.name, role: /^bee$/i.test(m.name) ? 'admin' : 'member' }));
  if (members.length && !members.some(m => m.role === 'admin')) members[0].role = 'admin';
  return { members, projects: old.projects.map(p => ({ id: p.id, no: p.no, sub: p.sub || '', start: p.start || '', end: p.end || '', entries: p.entries || {}, notes: p.notes || [] })) };
}

/* ---------- Supabase store ---------- */
const Live = {
  async init() {
    const { data } = await sb.auth.getSession();
    auth.user = data.session ? data.session.user : null;
    sb.auth.onAuthStateChange((ev, session) => {
      const u = session ? session.user : null;
      if ((u && u.id) !== (auth.user && auth.user.id)) { auth.user = u; refresh(); }
    });
    await this.reload();
  },
  async reload() {
    const res = await Promise.all([
      sb.from('vft_members').select('id,user_id,name,role,sort,created_at').order('sort').order('created_at'),
      sb.from('vft_projects').select('*').order('no'),
      sb.from('vft_entries').select('*'),
      sb.from('vft_notes').select('*').order('created_at', { ascending: false }),
      sb.from('vft_files').select('*').order('created_at', { ascending: false }),
      sb.from('vft_works').select('*').order('created_at', { ascending: false })
    ]);
    const bad = res.find(r => r.error); if (bad) throw bad.error;
    const [m, p, e, n, f, wk] = res.map(r => r.data);
    state.members = m.map(x => ({ id: x.id, name: x.name, role: x.role, userId: x.user_id }));
    state.projects = p.map(x => ({ id: x.id, no: x.no, sub: x.subtitle || '', start: x.start_date || '', end: x.end_date || '', entries: {}, notes: [] }));
    const byId = Object.fromEntries(state.projects.map(x => [x.id, x]));
    e.forEach(x => { const pr = byId[x.project_id]; if (pr) pr.entries[x.member_id] = { title: x.title, topic: x.topic, detail: x.detail, url: x.url, plan: x.plan, html: x.html, progress: x.progress, done: !!x.done, files: [] }; });
    n.forEach(x => { const pr = byId[x.project_id]; if (pr) pr.notes.push({ id: x.id, text: x.body, by: x.author_id, at: Date.parse(x.created_at) }); });
    f.forEach(x => { const pr = byId[x.project_id]; if (pr) ent(pr, x.member_id).files.push({ id: x.id, name: x.name, size: x.size, type: x.mime, added: Date.parse(x.created_at), path: x.path, kind: kindOf(x.name, x.mime) }); });
    state.works = wk.map(x => ({ id: x.id, by: x.member_id, title: x.title, topic: x.topic, detail: x.detail, url: x.url, html: x.html, image: x.image_path, at: Date.parse(x.created_at) }));
    auth.me = auth.user ? state.members.find(x => x.userId === auth.user.id) || null : null;
  },
  imgUrl(path) { return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl; },
  async saveWork(prev, data, opt) {
    const owner = prev ? prev.by : auth.me.id;
    let image = prev ? prev.image : null, old = null;
    if (opt.removeImg && image) { old = image; image = null; }
    if (opt.file) {
      if (opt.file.size > MAX_FILE) throw new Error('이미지는 10MB까지 올릴 수 있습니다.');
      const safe = opt.file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60) || 'image';
      const path = `works/${owner}/${Date.now().toString(36)}${uid()}-${safe}`;
      const up = await sb.storage.from(BUCKET).upload(path, opt.file, { contentType: opt.file.type || 'image/png', upsert: false });
      if (up.error) throw up.error;
      if (image) old = image; image = path;
    }
    const row = { title: data.title, topic: data.topic, detail: data.detail, url: data.url, html: data.html, image_path: image, updated_at: new Date().toISOString() };
    let res;
    if (prev) res = await sb.from('vft_works').update(row).eq('id', prev.id).select().single();
    else res = await sb.from('vft_works').insert(Object.assign({ member_id: owner }, row)).select().single();
    if (res.error) { if (opt.file) await sb.storage.from(BUCKET).remove([image]); throw res.error; }
    if (old) await sb.storage.from(BUCKET).remove([old]);
    const x = res.data, rec = { id: x.id, by: x.member_id, title: x.title, topic: x.topic, detail: x.detail, url: x.url, html: x.html, image: x.image_path, at: Date.parse(x.created_at) };
    if (prev) Object.assign(prev, rec); else state.works.unshift(rec);
    return prev || rec;
  },
  async delWork(w) {
    const { data, error } = await sb.from('vft_works').delete().eq('id', w.id).select('id'); if (error) throw error;
    if (!data.length) throw new Error('권한이 없습니다.');
    if (w.image) await sb.storage.from(BUCKET).remove([w.image]);
    state.works = state.works.filter(x => x.id !== w.id);
  },
  async createProject(no) {
    const { data, error } = await sb.from('vft_projects').insert({ no }).select().single(); if (error) throw error;
    const np = { id: data.id, no: data.no, sub: '', start: '', end: '', entries: {}, notes: [] }; state.projects.push(np); return np;
  },
  async updateProject(p, patch) {
    const row = {};
    if ('sub' in patch) row.subtitle = patch.sub;
    if ('start' in patch) row.start_date = patch.start || null;
    if ('end' in patch) row.end_date = patch.end || null;
    const { data, error } = await sb.from('vft_projects').update(row).eq('id', p.id).select('id'); if (error) throw error;
    if (!data.length) throw new Error('권한이 없습니다.');
  },
  async saveEntry(p, mid, patch) {
    const row = Object.assign({ project_id: p.id, member_id: mid, updated_at: new Date().toISOString() }, patch);
    delete row.files;
    const { error } = await sb.from('vft_entries').upsert(row, { onConflict: 'project_id,member_id' }); if (error) throw error;
  },
  async addNote(p, text) {
    const { data, error } = await sb.from('vft_notes').insert({ project_id: p.id, author_id: auth.me.id, body: text }).select().single(); if (error) throw error;
    p.notes.unshift({ id: data.id, text: data.body, by: data.author_id, at: Date.parse(data.created_at) });
  },
  async delNote(p, id) {
    const { data, error } = await sb.from('vft_notes').delete().eq('id', id).select('id'); if (error) throw error;
    if (!data.length) throw new Error('권한이 없습니다.');
    p.notes = p.notes.filter(n => n.id !== id);
  },
  async uploadFile(p, mid, f) {
    if (f.size > MAX_FILE) throw new Error(`${f.name}: 파일당 10MB까지 올릴 수 있습니다.`);
    const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60) || 'file';
    const path = `${p.id}/${mid}/${Date.now().toString(36)}${uid()}-${safe}`;
    const up = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
    if (up.error) throw up.error;
    const { data, error } = await sb.from('vft_files').insert({ project_id: p.id, member_id: mid, name: f.name, size: f.size, mime: f.type || '', path }).select().single();
    if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
    ent(p, mid).files.unshift({ id: data.id, name: data.name, size: data.size, type: data.mime, added: Date.parse(data.created_at), path, kind: kindOf(data.name, data.mime) });
  },
  async delFile(p, mid, rec) {
    const { data, error } = await sb.from('vft_files').delete().eq('id', rec.id).select('id'); if (error) throw error;
    if (!data.length) throw new Error('권한이 없습니다.');
    await sb.storage.from(BUCKET).remove([rec.path]);
    const e = ent(p, mid); e.files = e.files.filter(x => x.id !== rec.id);
  },
  fileUrl(rec) { return sb.storage.from(BUCKET).getPublicUrl(rec.path).data.publicUrl; },
  async fileContent(rec) {
    const url = this.fileUrl(rec);
    if (rec.kind === 'image') return url;
    if (rec.size > 1024 * 1024) return null;
    const r = await fetch(url); return r.ok ? r.text() : null;
  },
  async setRole(m, role) {
    const { data, error } = await sb.from('vft_members').update({ role }).eq('id', m.id).select('id'); if (error) throw error;
    if (!data.length) throw new Error('권한이 없습니다.'); m.role = role;
  },
  async removeMember(m) {
    const { data, error } = await sb.from('vft_members').delete().eq('id', m.id).select('id'); if (error) throw error;
    if (!data.length) throw new Error('권한이 없습니다.');
    state.members = state.members.filter(x => x.id !== m.id); state.projects.forEach(p => delete p.entries[m.id]); state.works = state.works.filter(w => w.by !== m.id);
  }
};
const Store = LIVE ? Live : Local;

async function refresh() {
  if (!LIVE) { render(); return; }
  try { await Live.reload(); ui.loadError = null; } catch (e) { console.error(e); ui.loadError = friendly(e); }
  if (ui.view === 'project' && !state.projects.some(p => p.id === ui.pid)) ui.view = 'home';
  if (!active().some(m => m.id === ui.worksBy)) ui.worksBy = 'all';
  renderSidebar(); if (ui.view !== 'home') renderMain(); renderAuthButtons(); setSave('idle');
  const modal = document.getElementById('login'); if (modal && !modal.hidden) renderAuth();
}

/* ---------- navigation ---------- */
function openProject(id) { ui.view='project'; ui.pid=id; ui.pick=null; ui.panel=null; ui.viewFile=null; ui.memberMenu=null; ui.confirmRemove=null; ui.showPending=false; render(); window.scrollTo(0, 0); }
function goHome() { ui.view='home'; ui.pid=null; ui.panel=null; ui.memberMenu=null; render(); window.scrollTo(0, 0); }

/* ---------- dates ---------- */
function parseD(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function isoD(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const DAY = 86400000;
function diffDays(a, b) { return Math.round((b - a) / DAY); }
function fmtShort(s) { const d = parseD(s); return d ? `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}` : ''; }
function fmtSize(b) { return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`; }
function fmtDate(t) { const d = new Date(t); return `${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

let toastTimer;
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200); }

/* ---------- intro stage (oscilloscope beam) ---------- */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const SCOPE = { iw:1672, ih:941, cx:829.2, cy:415, r:262, mask:{ x:563, y:153, w:533, h:533 }, textW:392 };
const BEAM = { warm:.75, lead:.45, write:2.7, jump:.045, dot:.07, fresh:.38 };
function stageHTML() {
  return `<section class="stage" id="stage">
    <img class="scope" src="${ASSET.scope}" alt="" draggable="false">
    <canvas class="beam" aria-hidden="true"></canvas>
    <h1 class="sr">Vibe for Two</h1>
    <button class="replay" data-act="replay" tabindex="-1">다시 보기</button>
  </section>`;
}
function beamPlan() {
  const [bx0, by0, bx1, by1] = GLYPH.bbox, k = SCOPE.textW / (bx1 - bx0);
  const ox = SCOPE.cx - (bx0 + bx1) / 2 * k, oy = SCOPE.cy - (by0 + by1) / 2 * k;
  const strokes = GLYPH.strokes.map(s => {
    const pts = s.pts.map(([x, y]) => [ox + x * k, oy + y * k]);
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return { dot: !!s.dot, pts, cum, len: cum[cum.length - 1] };
  });
  const total = strokes.reduce((a, s) => a + s.len, 0);
  const jumps = (strokes.length - 1) * BEAM.jump + strokes.filter(s => s.dot).length * BEAM.dot;
  const v = total / (BEAM.write - jumps);
  let t = BEAM.warm + BEAM.lead;
  for (const s of strokes) { s.t0 = t; s.dur = s.dot ? BEAM.dot : s.len / v; t += s.dur + BEAM.jump; }
  return { strokes, end: t, v };
}
const sideAuto = { t: 0, ready: false, idle: 3000 };
function hideSide() { clearTimeout(sideAuto.t); document.querySelector('.app').classList.remove('side-auto'); }
function showSide() {
  if (!sideAuto.ready || ui.view !== 'home') return;
  document.querySelector('.app').classList.add('side-auto');
  clearTimeout(sideAuto.t); sideAuto.t = setTimeout(hideSide, sideAuto.idle);
}
document.addEventListener('mousemove', showSide, { passive: true });
let hero = null;
function stopHero() { if (hero) { cancelAnimationFrame(hero.raf); hero.ro && hero.ro.disconnect(); hero = null; } sideAuto.ready = false; hideSide(); }
function mountHero(play) {
  const stage = document.getElementById('stage'); if (!stage) return;
  stopHero();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cv = stage.querySelector('.beam'), out = cv.getContext('2d'), btn = stage.querySelector('.replay');
  const mk = () => { const c = document.createElement('canvas'); return [c, c.getContext('2d')]; };
  const [core, cc] = mk(), [b1, c1] = mk(), [b2, c2] = mk(), [b3, c3] = mk();
  const mask = new Image(); mask.src = ASSET.mask;
  const plan = beamPlan();
  const h = { raf: 0, start: performance.now() - (play && !reduce ? 0 : (plan.end + 1) * 1000), done: false }; hero = h;
  let W, H, dpr, sc, ox, oy;
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = stage.clientWidth, hh = stage.clientHeight;
    W = cv.width = core.width = Math.max(1, Math.round(w * dpr)); H = cv.height = core.height = Math.max(1, Math.round(hh * dpr));
    b1.width = Math.ceil(W / 4); b1.height = Math.ceil(H / 4); b2.width = Math.ceil(W / 12); b2.height = Math.ceil(H / 12); b3.width = Math.ceil(W / 32); b3.height = Math.ceil(H / 32);
    sc = Math.max(w / SCOPE.iw, hh / SCOPE.ih) * dpr; ox = (W - SCOPE.iw * sc) / 2; oy = (H - SCOPE.ih * sc) / 2;
  }
  const X = x => ox + x * sc, Y = y => oy + y * sc;
  function strokeRuns(s, tp, upto) {
    const n = s.pts.length;
    const lvlOf = i => { const tw = s.t0 + (s.dur * (s.cum[i] / (s.len || 1))); const age = tp - tw; return Math.min(5, Math.max(0, Math.floor(age / BEAM.fresh * 2))); };
    const runs = []; let cr = null;
    for (let i = 0; i < n; i++) {
      if (s.cum[i] > upto) break;
      const l = lvlOf(i);
      if (!cr || l !== cr.l) { if (cr) cr.p.push(s.pts[i]); cr = { l, p: [] }; runs.push(cr); if (runs.length > 1) cr.p.push(runs[runs.length - 2].p[runs[runs.length - 2].p.length - 1]); }
      cr.p.push(s.pts[i]);
    }
    if (cr && upto < s.len) {
      const i = s.cum.findIndex(c => c > upto);
      if (i > 0) { const a = s.pts[i - 1], b = s.pts[i], f = (upto - s.cum[i - 1]) / ((s.cum[i] - s.cum[i - 1]) || 1); cr.p.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
    }
    return runs;
  }
  function headAt(tp) {
    for (const s of plan.strokes) {
      if (tp >= s.t0 && tp <= s.t0 + s.dur) {
        if (s.dot) return s.pts[0];
        const d = (tp - s.t0) / s.dur * s.len; const i = s.cum.findIndex(c => c >= d); if (i <= 0) return s.pts[0];
        const a = s.pts[i - 1], b = s.pts[i], f = (d - s.cum[i - 1]) / ((s.cum[i] - s.cum[i - 1]) || 1); return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      }
    }
    return null;
  }
  const FRESH = [1, .82, .66, .55, .48, .44];
  function draw(tp) {
    const writing = tp < plan.end;
    let I = 1;
    if (tp < BEAM.warm) I = 0;
    if (!writing) I = .94 + .05 * Math.sin(tp * 1.3) + .02 * Math.sin(tp * 3.7 + 1);
    const fl = reduce ? 1 : (.975 + Math.random() * .025);
    const jx = reduce ? 0 : (Math.random() - .5) * .25, jy = reduce ? 0 : (Math.random() - .5) * .25;
    cc.setTransform(1, 0, 0, 1, 0, 0); cc.clearRect(0, 0, W, H);
    cc.lineCap = 'round'; cc.lineJoin = 'round'; cc.globalCompositeOperation = 'lighten';
    const lw = Math.max(1.1 * dpr, 2.1 * sc);
    for (const s of plan.strokes) {
      if (tp < s.t0) continue;
      if (s.dot) {
        const age = tp - s.t0, a = (age < BEAM.dot ? .7 : FRESH[Math.min(5, Math.floor(age / BEAM.fresh * 2))]);
        cc.fillStyle = `rgba(236,255,242,${a * I * fl})`; cc.beginPath(); cc.arc(X(s.pts[0][0]) + jx, Y(s.pts[0][1]) + jy, lw * .9, 0, Math.PI * 2); cc.fill(); continue;
      }
      const upto = Math.min(s.len, (tp - s.t0) / s.dur * s.len);
      for (const r of strokeRuns(s, tp, upto)) {
        if (r.p.length < 2) continue;
        const a = FRESH[r.l] * I * fl;
        cc.beginPath(); cc.moveTo(X(r.p[0][0]) + jx, Y(r.p[0][1]) + jy); for (let i = 1; i < r.p.length; i++) cc.lineTo(X(r.p[i][0]) + jx, Y(r.p[i][1]) + jy);
        cc.strokeStyle = `rgba(150,215,175,${a * .35})`; cc.lineWidth = lw * 3.2; cc.stroke();
        cc.strokeStyle = `rgba(236,255,242,${a})`; cc.lineWidth = lw; cc.stroke();
      }
    }
    cc.globalCompositeOperation = 'source-over';
    let head = null;
    if (tp >= BEAM.warm && tp < plan.strokes[0].t0) head = plan.strokes[0].pts[0];
    else if (writing) head = headAt(tp);
    if (head) {
      const warm = tp < plan.strokes[0].t0 ? clamp((tp - BEAM.warm) / BEAM.lead) * (.55 + .45 * Math.random()) : 1;
      const hx = X(head[0]) + jx, hy = Y(head[1]) + jy, hr = lw * 3.4;
      const g = cc.createRadialGradient(hx, hy, 0, hx, hy, hr); g.addColorStop(0, `rgba(255,255,255,${.95 * warm})`); g.addColorStop(.35, `rgba(220,255,232,${.55 * warm})`); g.addColorStop(1, 'rgba(160,230,190,0)');
      cc.fillStyle = g; cc.beginPath(); cc.arc(hx, hy, hr, 0, Math.PI * 2); cc.fill();
    }
    const tint = (c, x, col) => { x.globalCompositeOperation = 'source-atop'; x.fillStyle = col; x.fillRect(0, 0, c.width, c.height); x.globalCompositeOperation = 'source-over'; };
    c1.clearRect(0, 0, b1.width, b1.height); c1.drawImage(core, 0, 0, b1.width, b1.height);
    c2.clearRect(0, 0, b2.width, b2.height); c2.drawImage(b1, 0, 0, b2.width, b2.height);
    c3.clearRect(0, 0, b3.width, b3.height); c3.drawImage(b2, 0, 0, b3.width, b3.height);
    tint(b1, c1, 'rgba(175,232,198,.35)'); tint(b2, c2, 'rgba(120,200,155,.55)'); tint(b3, c3, 'rgba(95,175,130,.6)');
    out.globalCompositeOperation = 'source-over'; out.globalAlpha = 1; out.clearRect(0, 0, W, H);
    out.globalCompositeOperation = 'lighter'; out.imageSmoothingEnabled = true;
    out.globalAlpha = 1; out.drawImage(b3, 0, 0, W, H); out.drawImage(b3, 0, 0, W, H);
    out.globalAlpha = .95; out.drawImage(b2, 0, 0, W, H); out.drawImage(b2, 0, 0, W, H);
    out.globalAlpha = .9; out.drawImage(b1, 0, 0, W, H);
    out.globalAlpha = 1; out.drawImage(core, 0, 0);
    const lit = clamp((tp - BEAM.warm - BEAM.lead) / 1.2) * I;
    if (lit > 0) { const cx = X(SCOPE.cx), cy = Y(SCOPE.cy), R = SCOPE.r * sc; const g = out.createRadialGradient(cx, cy, 0, cx, cy, R); g.addColorStop(0, `rgba(110,170,135,${.07 * lit})`); g.addColorStop(1, `rgba(110,170,135,${.02 * lit})`); out.globalAlpha = 1; out.fillStyle = g; out.fillRect(cx - R, cy - R, R * 2, R * 2); }
    out.globalCompositeOperation = 'destination-in'; out.globalAlpha = 1;
    if (mask.complete && mask.naturalWidth) out.drawImage(mask, X(SCOPE.mask.x), Y(SCOPE.mask.y), SCOPE.mask.w * sc, SCOPE.mask.h * sc);
    else { out.beginPath(); out.arc(X(SCOPE.cx), Y(SCOPE.cy), SCOPE.r * sc, 0, Math.PI * 2); out.fill(); }
    out.globalCompositeOperation = 'source-over';
    if (!writing && !h.done) { h.done = true; stage.classList.add('done'); btn.tabIndex = 0; sideAuto.ready = true; setTimeout(showSide, 250); }
  }
  size();
  const now = () => (performance.now() - h.start) / 1000;
  const tick = () => { draw(now()); h.raf = requestAnimationFrame(tick); };
  stage.classList.toggle('done', false); btn.tabIndex = -1;
  if (reduce) { const once = () => draw(plan.end + 2); mask.onload = once; once(); h.ro = new ResizeObserver(() => { size(); once(); }); h.ro.observe(stage); return; }
  h.raf = requestAnimationFrame(tick);
  h.ro = new ResizeObserver(() => size()); h.ro.observe(stage);
}

/* ---------- project page parts ---------- */
function calView(p) {
  if (ui.cal && ui.cal.pid === p.id) return ui.cal;
  const s = parseD(p.start), e = parseD(p.end), t = new Date();
  const base = (s && e && t >= s && t <= e) ? t : (s || t);
  ui.cal = { pid: p.id, y: base.getFullYear(), m: base.getMonth() }; return ui.cal;
}
function picking(p) { return ui.pick && ui.pick.pid === p.id; }
function calHTML(p) {
  const s = parseD(p.start), e = parseD(p.end), ok = s && e && e >= s, edit = can.admin();
  const v = calView(p), yy = v.y, mm = v.m;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const first = new Date(yy, mm, 1), last = new Date(yy, mm + 1, 0).getDate();
  let cells = WD.map(w => `<div class="wd">${w}</div>`).join('');
  for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
  for (let d = 1; d <= last; d++) {
    const dt = new Date(yy, mm, d); const cls = ['d'];
    if (ok && dt >= s && dt <= e) cls.push('in');
    if (ok && +dt === +s) cls.push('s'); if (ok && +dt === +e) cls.push('e');
    if (s && !e && +dt === +s) cls.push('in', 's', 'e');
    if (+dt === +today) cls.push('today');
    cells += edit
      ? `<button type="button" class="${cls.join(' ')}" data-act="cal-day" data-date="${isoD(dt)}" aria-label="${mm + 1}월 ${d}일"><span>${d}</span></button>`
      : `<div class="${cls.join(' ')}"><span>${d}</span></div>`;
  }
  const note = picking(p) ? '' : !s || !e ? `<p class="cal-note">${edit ? '시작일과 종료일을 고르면 달력에 기간이 표시됩니다' : '아직 기간이 정해지지 않았습니다'}</p>`
    : e < s ? '<p class="cal-note err">종료일이 시작일보다 빠릅니다. 날짜를 다시 골라 주세요.</p>' : '';
  return `<div class="month">
    <div class="cal-nav"><button class="calbtn" data-act="cal-move" data-d="-1" aria-label="이전 달">‹</button>
      <p class="mtitle">${yy}. ${String(mm + 1).padStart(2, '0')}</p>
      <button class="calbtn" data-act="cal-move" data-d="1" aria-label="다음 달">›</button></div>
    <div class="grid7">${cells}</div>${note}</div>`;
}
function statusHTML(p) {
  const s = parseD(p.start), e = parseD(p.end);
  if (!s || !e || e < s) return `<div class="status"><b>—</b><span>기간 미정</span></div>`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const total = diffDays(s, e) + 1;
  let big, small;
  if (today < s) { big = `D-${diffDays(today, s)}`; small = `시작 전 · 총 ${total}일`; }
  else if (today > e) { big = '종료'; small = `총 ${total}일 진행`; }
  else { const n = diffDays(s, today) + 1; big = `${n} / ${total}일`; small = `진행 중 · 마감까지 ${diffDays(today, e)}일`; }
  return `<div class="status"><b>${big}</b><span>${small}</span></div>`;
}
function datesHTML(p) {
  const edit = can.admin();
  const hint = !edit ? '' : picking(p) ? '이제 종료일을 누르세요' : (p.start && p.end ? '다시 정하려면 달력에서 새 시작일을 누르세요' : '달력에서 시작일을 누르세요');
  return `<div class="pick-sum">
      <div class="pk${picking(p) ? '' : ' on'}"><span>시작일</span><b>${p.start ? fmtShort(p.start) : '—'}</b></div>
      <div class="pk${picking(p) ? ' on' : ''}"><span>종료일</span><b>${p.end ? fmtShort(p.end) : '—'}</b></div>
    </div>
    ${hint ? `<p class="pick-hint">${hint}</p>` : ''}
    ${edit && (p.start || p.end) ? '<button class="btn ghost pick-reset" data-act="cal-reset">기간 지우기</button>' : ''}
    <div id="status">${statusHTML(p)}</div>`;
}
function renderPeriod(p) { document.getElementById('dates').innerHTML = datesHTML(p); const c = document.getElementById('cal'); c.innerHTML = calHTML(p); c.classList.toggle('picking', !!picking(p)); }

function noteName(id) { const m = state.members.find(x => x.id === id); return m ? m.name : '탈퇴한 멤버'; }
function boardHTML(p) {
  const notes = p.notes || [];
  const list = notes.length ? `<ul class="notes">${notes.map(n => `<li class="note">
      <div class="note-meta">${n.by ? `<b>${esc(noteName(n.by))}</b>` : ''}<span>${fmtDate(n.at)}</span>
        ${can.delNote(n) ? (ui.pendingNote === n.id ? `<button class="nbtn danger" data-act="del-note" data-id="${n.id}">한 번 더 누르면 삭제</button>` : `<button class="nbtn" data-act="del-note" data-id="${n.id}" aria-label="노트 삭제">삭제</button>`) : ''}</div>
      <p>${esc(n.text)}</p></li>`).join('')}</ul>`
    : `<p class="note-empty">${can.write() ? '아직 노트가 없습니다. 이번 프로젝트의 주제나 아이디어, 공지를 남겨 보세요.' : '아직 노트가 없습니다.'}</p>`;
  let form = '';
  if (can.write()) form = `<form class="note-form" id="noteform">
      <textarea id="note-text" rows="3" placeholder="주제, 아이디어, 메모를 적어 두세요"></textarea>
      <div class="note-actions"><span class="note-tip">Ctrl + Enter로 등록</span><button class="btn solid" type="submit">등록</button></div>
      <p class="err-text" id="note-err" hidden></p>
    </form>`;
  else form = `<p class="note-lock">${auth.me && auth.me.role === 'pending' ? '가입이 승인되면 노트를 쓸 수 있습니다.' : '멤버로 로그인하면 노트를 쓸 수 있습니다.'}</p>`;
  return form + list;
}
function renderBoard(p) { document.getElementById('board').innerHTML = boardHTML(p); }

function chipTag(m) { return m.role === 'admin' ? '<em>관리자</em>' : m.role === 'manager' ? '<em>매니저</em>' : ''; }
function membersHTML() {
  const chips = active().map(m => {
    const menu = can.editMember(m) || (can.admin() && m.id !== (auth.me && auth.me.id));
    const me = auth.me && auth.me.id === m.id ? ' me' : '';
    return menu
      ? `<button class="chip chip-btn${me}${ui.memberMenu === m.id ? ' open' : ''}" data-act="member-menu" data-m="${m.id}" aria-expanded="${ui.memberMenu === m.id}"><i></i>${esc(m.name)}${chipTag(m)}</button>`
      : `<span class="chip${me}"><i></i>${esc(m.name)}${chipTag(m)}</span>`;
  }).join('');
  const n = pendings().length;
  const pend = can.manage() && n ? `<button class="btn" data-act="toggle-pending" aria-expanded="${ui.showPending}">가입 신청 ${n}</button>` : '';
  return `<div class="chips">${chips}${pend}</div>`;
}
function memberBarHTML() {
  let out = '';
  const m = state.members.find(x => x.id === ui.memberMenu);
  if (m && m.role !== 'pending') {
    if (ui.confirmRemove === m.id) {
      out += `<div class="mbar warn" role="alert"><p>${esc(m.name)}을(를) 멤버에서 빼면 모든 프로젝트의 ${esc(m.name)} 칸 내용과 파일도 함께 지워집니다.</p>
        <button class="btn danger" data-act="remove-member" data-m="${m.id}">멤버에서 빼기</button><button class="btn ghost" data-act="member-menu" data-m="${m.id}">취소</button></div>`;
    } else {
      const btns = [];
      if (can.admin() && m.role !== 'admin') btns.push(`<button class="btn" data-act="set-role" data-m="${m.id}" data-role="${m.role === 'manager' ? 'member' : 'manager'}">${m.role === 'manager' ? '매니저 해제' : '매니저로 지정'}</button>`);
      if (can.editMember(m)) btns.push(`<button class="btn ghost" data-act="ask-remove" data-m="${m.id}">멤버에서 빼기</button>`);
      out += `<div class="mbar"><p><b>${esc(m.name)}</b> · ${ROLE_KO[m.role]}</p>${btns.join('')}<button class="btn ghost" data-act="member-menu" data-m="${m.id}">닫기</button></div>`;
    }
  }
  if (ui.showPending && can.manage()) {
    const rows = pendings().map(x => `<li><span>${esc(x.name)}</span>
      <button class="btn solid" data-act="approve" data-m="${x.id}">승인</button>
      <button class="btn ghost" data-act="reject" data-m="${x.id}">거절</button></li>`).join('');
    out += `<div class="mbar pend"><p>가입 신청</p><ul>${rows || '<li class="none">대기 중인 신청이 없습니다</li>'}</ul></div>`;
  }
  return out;
}

function cardHTML(p, m) {
  const e = ent(p, m.id), open = ui.panel === m.id, id = `${p.id}-${m.id}`, edit = can.entry(m.id);
  const ro = edit ? '' : ' readonly', dis = edit ? '' : ' disabled';
  const okUrl = /^https?:\/\/\S+/i.test(e.url.trim());
  const nFiles = e.files.length, hasPlan = e.plan.trim() ? 1 : 0, hasHtml = e.html.trim() ? 1 : 0;
  const mine = auth.me && auth.me.id === m.id;
  return `<article class="card${open ? ' active' : ''}${edit ? '' : ' locked'}">
    <header class="card-h">
      <div class="mh"><span class="mname">${esc(m.name)}</span>
        <label class="prog"><span class="sr">${esc(m.name)} 진행 상황</span>
          <select class="gsel" id="pg-${id}" data-bind="entry" data-m="${m.id}" data-f="progress"${dis}>${PROG.map(v => `<option value="${v}"${(+e.progress || 0) === v ? ' selected' : ''}>${v}%</option>`).join('')}</select></label></div>
      <span class="mtag">${mine ? '내 칸' : 'Project ' + p.no}</span>
    </header>
    <div class="pbar" aria-hidden="true"><i id="pb-${id}" style="width:${+e.progress || 0}%"></i></div>
    <div class="card-b">
      <label class="fld"><span>프로젝트 제목</span><input id="t-${id}" data-bind="entry" data-m="${m.id}" data-f="title" value="${esc(e.title)}" placeholder="${edit ? '내 웹앱의 이름' : ''}"${ro}></label>
      <label class="fld"><span>주제</span><input id="p-${id}" data-bind="entry" data-m="${m.id}" data-f="topic" value="${esc(e.topic)}" placeholder="${edit ? '무엇을 만드는지 한 줄로' : ''}"${ro}></label>
      <label class="fld"><span>상세 내용</span><textarea id="d-${id}" rows="5" data-bind="entry" data-m="${m.id}" data-f="detail" placeholder="${edit ? '기능, 진행 상황, 막힌 점 등' : ''}"${ro}>${esc(e.detail)}</textarea></label>
      <div class="fld"><label for="u-${id}">웹앱 주소</label>
        <div class="url-row">
          <input id="u-${id}" type="url" inputmode="url" data-bind="entry" data-m="${m.id}" data-f="url" value="${esc(e.url)}" placeholder="${edit ? 'https://' : ''}"${ro}>
          <button class="btn" data-act="copy-url" data-target="u-${id}">복사</button>
          <a class="btn ghost" id="o-${id}" href="${okUrl ? esc(e.url.trim()) : '#'}" target="_blank" rel="noopener" ${okUrl ? '' : 'hidden'}>열기</a>
        </div></div>
      <label class="done-row${e.done ? ' on' : ''}"><input type="checkbox" id="dn-${id}" data-bind="entry" data-m="${m.id}" data-f="done"${e.done ? ' checked' : ''}${dis}>
        <span class="sw" aria-hidden="true"></span><span class="dt"><b>${e.done ? '작업 완료' : '작업 완료로 표시'}</b><small>${e.done ? 'Works에 공개되어 있습니다' : '완료하면 Works에 모입니다'}</small></span></label>
      <button class="ws-btn" data-act="toggle-panel" data-m="${m.id}" aria-expanded="${open}">
        <span>작업 자료 · 기획 / HTML / 파일</span><small>${open ? '닫기' : `${hasPlan + hasHtml + nFiles}개`}</small></button>
    </div></article>`;
}

function panelHTML(p) {
  const m = state.members.find(x => x.id === ui.panel); if (!m) return '';
  const e = ent(p, m.id), edit = can.entry(m.id), ro = edit ? '' : ' readonly';
  const tab = (k, label, n) => `<button class="tab" role="tab" data-act="tab" data-tab="${k}" aria-selected="${ui.tab === k}">${label}${n != null ? `<small>${n}</small>` : ''}</button>`;
  let body = '';
  if (ui.tab === 'plan') {
    body = `<textarea id="plan-${p.id}-${m.id}" class="plan" data-bind="entry" data-m="${m.id}" data-f="plan" placeholder="${edit ? '화면 구성, 기능 목록, 사용한 프롬프트, 참고 자료 등을 적어 두세요.' : '아직 기획 내용이 없습니다.'}"${ro}>${esc(e.plan)}</textarea>
      ${edit ? `<p class="hint">기획서 파일이 따로 있으면 '파일' 탭에 올려 두세요.</p>` : ''}`;
  } else if (ui.tab === 'html') {
    body = `<div class="toolbar">
        <button class="btn${ui.htmlView === 'code' ? ' solid' : ''}" data-act="hview" data-v="code">코드</button>
        <button class="btn${ui.htmlView === 'preview' ? ' solid' : ''}" data-act="hview" data-v="preview">미리보기</button>
        <span class="sp"></span>
        ${edit ? `<label class="btn" for="htmlfile">HTML 파일 불러오기</label><input id="htmlfile" class="sr" type="file" accept=".html,.htm,text/html" data-m="${m.id}">` : ''}
        <button class="btn" data-act="copy-html" data-m="${m.id}">코드 복사</button>
      </div>
      ${ui.htmlView === 'code'
        ? `<textarea id="html-${p.id}-${m.id}" class="code" spellcheck="false" data-bind="entry" data-m="${m.id}" data-f="html" placeholder="${edit ? '<!doctype html> 부터 붙여 넣거나, HTML 파일을 불러오세요.' : '아직 HTML이 없습니다.'}"${ro}>${esc(e.html)}</textarea>`
        : (e.html.trim() ? `<iframe class="preview" id="pv" sandbox="allow-scripts" title="HTML 미리보기"></iframe>` : `<div class="cal-empty">아직 HTML이 없습니다.</div>`)}
      <p class="hint">미리보기는 이 페이지 안의 격리된 화면에서 실행됩니다. 외부 사이트를 불러오는 코드는 막힐 수 있습니다.</p>`;
  } else {
    const vf = e.files.find(f => f.id === ui.viewFile);
    const rows = e.files.length ? e.files.map(f => {
      const viewable = (f.kind === 'text' || f.kind === 'image') && !f.big;
      const noteTxt = f.big ? ' · 용량이 커서 이름만 저장됨' : (!viewable ? ' · 미리보기 불가 형식' : '');
      const del = !edit ? '' : ui.pendingDel === f.id
        ? `<button class="btn danger" data-act="del-file" data-m="${m.id}" data-id="${f.id}">한 번 더 누르면 삭제</button>`
        : `<button class="btn ghost" data-act="del-file" data-m="${m.id}" data-id="${f.id}">삭제</button>`;
      const dl = LIVE && f.path ? `<a class="btn ghost" href="${esc(Live.fileUrl(f))}" target="_blank" rel="noopener">열기</a>` : '';
      return `<div class="frow${vf && vf.id === f.id ? ' sel' : ''}"><span class="fname">${esc(f.name)}</span>
        <span class="fmeta">${fmtSize(f.size)} · ${fmtDate(f.added)}${noteTxt}</span>
        ${viewable ? `<button class="btn" data-act="view-file" data-id="${f.id}">${vf && vf.id === f.id ? '접기' : '보기'}</button>` : ''}${dl}${del}</div>`;
    }).join('') : `<div class="empty-files">${edit ? '기획서, HTML·CSS·JS 파일, 화면 캡처 등을 올려 두세요.' : '올라온 파일이 없습니다.'}</div>`;
    let viewer = '';
    if (vf) {
      const d = ui.viewData;
      viewer = d == null ? `<div class="viewer"><pre>불러오는 중…</pre></div>`
        : vf.kind === 'image' ? `<div class="viewer"><img src="${esc(d)}" alt="${esc(vf.name)}"></div>`
        : `<div class="viewer"><pre>${esc(d)}</pre></div>`;
    }
    body = `${edit ? `<div class="drop" id="drop" data-m="${m.id}">
        <span>여기로 파일을 끌어다 놓거나</span>
        <label class="btn" for="upfile">파일 선택</label>
        <input id="upfile" class="sr" type="file" multiple data-m="${m.id}">
        <span class="hint">${LIVE ? '파일당 10MB까지 올릴 수 있습니다' : '파일당 700KB까지 내용이 저장됩니다'}</span>
      </div>` : ''}
      <div class="flist">${rows}</div>${viewer}`;
  }
  return `<section class="panel" id="panel" aria-label="${esc(m.name)} 작업 자료">
    <div class="panel-h"><h3>${esc(m.name)}의 작업 자료 · Project ${p.no}</h3>
      <button class="btn" data-act="toggle-panel" data-m="${m.id}">닫기</button></div>
    <div class="tabs" role="tablist">${tab('plan', '기획')}${tab('html', 'HTML')}${tab('files', '파일', e.files.length)}</div>
    <div class="panel-b">${body}</div></section>`;
}

/* ---------- works (bento gallery) ---------- */
// Works 에는 (1) 프로젝트 칸 중 '작업 완료'로 표시한 것, (2) Works 에서 따로 올린 개인 작업이 모입니다.
function worksList() {
  const out = [];
  (state.works || []).forEach(w => { const m = state.members.find(x => x.id === w.by); if (m && m.role !== 'pending') out.push({ type: 'solo', w, m }); });
  [...state.projects].sort((a, b) => b.no - a.no).forEach(p => active().forEach(m => {
    const e = p.entries[m.id]; if (e && e.done) out.push({ type: 'entry', p, m, e });
  }));
  return out;
}
function workData(it) {
  if (it.type === 'solo') {
    const w = it.w;
    return { title: w.title, topic: w.topic, url: w.url, html: w.html, img: w.image ? (LIVE ? Live.imgUrl(w.image) : w.image) : null, meta: '개인 작업', prog: null };
  }
  const e = it.e, img = (e.files || []).find(f => f.kind === 'image' && (LIVE ? f.path : f.data));
  return { title: e.title, topic: e.topic, url: e.url, html: e.html, img: img ? (LIVE ? Live.fileUrl(img) : img.data) : null, meta: 'Project ' + it.p.no, prog: +e.progress || 0 };
}
const hasVis = it => { const d = workData(it); return !!((d.html || '').trim() || d.img); };
const sortWorks = l => [...l.filter(hasVis), ...l.filter(x => !hasVis(x))];
const hostOf = u => { try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return ''; } };
const shownWorks = () => { const all = worksList(); return sortWorks(ui.worksBy === 'all' ? all : all.filter(w => w.m.id === ui.worksBy)); };
function worksHTML() {
  const all = worksList(), list = shownWorks();
  const filt = [['all', '전체', all.length], ...active().map(m => [m.id, m.name, all.filter(w => w.m.id === m.id).length])]
    .map(([id, label, n]) => `<button class="wf${ui.worksBy === id ? ' on' : ''}" data-act="works-by" data-m="${id}" aria-pressed="${ui.worksBy === id}">${esc(label)}<small>${n}</small></button>`).join('');
  const add = can.write() ? `<button class="wf wf-add" data-act="work-new" aria-label="작업 올리기"><span aria-hidden="true">+</span>작업 올리기</button>` : '';
  const tiles = list.map((it, i) => {
    const d = workData(it), url = (d.url || '').trim(), okUrl = /^https?:\/\/\S+/i.test(url);
    const vis = (d.html || '').trim() ? 'html' : d.img ? 'img' : null;
    const visual = !vis ? '' : vis === 'html'
      ? `<div class="wt-vis" data-html-idx="${i}"><iframe sandbox="allow-scripts" tabindex="-1" aria-hidden="true" loading="lazy" title=""></iframe></div>`
      : `<div class="wt-vis"><img src="${esc(d.img)}" alt="" loading="lazy"></div>`;
    const more = it.type === 'solo'
      ? `<button class="btn ghost" data-act="work-view" data-id="${it.w.id}">자세히</button>`
      : `<button class="btn ghost" data-act="open-work" data-p="${it.p.id}" data-m="${it.m.id}">작업 자료 보기</button>`;
    return `<article class="wt ${vis ? 'tall has-vis' : 'sq'} lg">
      ${visual}
      <div class="wt-body">
        <div class="wt-meta"><span>${d.meta}</span><b>${esc(it.m.name)}</b>${d.prog != null ? `<span class="wt-prog" title="진행률">${d.prog}%</span>` : ''}</div>
        <h3>${esc(d.title || '제목 없음')}</h3>
        ${d.topic ? `<p class="wt-topic">${esc(d.topic)}</p>` : ''}
        ${d.prog != null ? `<div class="wt-bar"><i style="width:${d.prog}%"></i></div>` : ''}
        <div class="wt-foot">
          ${okUrl ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(hostOf(url) || '웹앱')} 열기 ↗</a>` : ''}
          ${more}
        </div>
      </div></article>`;
  }).join('');
  const empty = can.write()
    ? '아직 모인 작업이 없습니다. 프로젝트 화면에서 내 칸을 "작업 완료"로 표시하거나, 위의 "작업 올리기"로 개인 작업을 올려 보세요.'
    : '아직 모인 작업이 없습니다.';
  return `<header class="phead"><h1 class="ptitle">Works</h1></header>
    <div class="wfilters">${filt}<span class="sp"></span>${add}</div>
    ${tiles ? `<div class="bento">${tiles}</div>` : `<div class="board lg works-empty"><p class="note-empty">${empty}</p></div>`}
    <p class="credit credit-page">Designed and built by Rain</p>`;
}
let worksRO = null;
function fitFrames(root) {
  root.querySelectorAll('.wt-vis[data-html-idx], .wv-vis[data-fit]').forEach(v => {
    const f = v.querySelector('iframe'); if (!f) return;
    const k = v.clientWidth / 1200; f.style.transform = `scale(${k})`; f.style.height = Math.ceil(v.clientHeight / k) + 'px';
  });
}
function mountWorks() {
  const list = shownWorks();
  document.querySelectorAll('.wt-vis[data-html-idx]').forEach(v => { const it = list[+v.dataset.htmlIdx]; if (it) v.querySelector('iframe').srcdoc = workData(it).html; });
  fitFrames(document); if (worksRO) worksRO.disconnect(); worksRO = new ResizeObserver(() => fitFrames(document)); const g = document.querySelector('.bento'); if (g) worksRO.observe(g);
}

/* ---------- personal work dialog ---------- */
const canWork = w => lv() >= 3 || (lv() >= 1 && auth.me && w.by === auth.me.id);
function openWork(mode, id) { ui.work = { mode, id, err: null, file: null, removeImg: false, delAsk: false }; document.getElementById('workmodal').hidden = false; renderWork(); }
function closeWork() { document.getElementById('workmodal').hidden = true; ui.work = null; }
function renderWork() {
  const card = document.getElementById('workcard'), st = ui.work; if (!st) return;
  const w = (state.works || []).find(x => x.id === st.id);
  const x = `<button class="login-x" type="button" data-act="close-work" aria-label="닫기">×</button>`;
  if (st.mode === 'view' && w) {
    const m = state.members.find(y => y.id === w.by), url = (w.url || '').trim(), okUrl = /^https?:\/\/\S+/i.test(url);
    const img = w.image ? (LIVE ? Live.imgUrl(w.image) : w.image) : null;
    const vis = (w.html || '').trim() ? `<div class="wv-vis" data-fit><iframe sandbox="allow-scripts" title="${esc(w.title)} 미리보기"></iframe></div>`
      : img ? `<div class="wv-vis img"><img src="${esc(img)}" alt="${esc(w.title)}"></div>` : '';
    card.innerHTML = `${x}<div class="wt-meta"><span>개인 작업</span><b>${esc(m ? m.name : '')}</b><span>${fmtDate(w.at)}</span></div>
      <h2>${esc(w.title)}</h2>${w.topic ? `<p class="login-sub">${esc(w.topic)}</p>` : ''}
      ${vis}${w.detail ? `<p class="wv-detail">${esc(w.detail)}</p>` : ''}
      <div class="wv-actions">
        ${okUrl ? `<a class="btn solid" href="${esc(url)}" target="_blank" rel="noopener">${esc(hostOf(url) || '웹앱')} 열기 ↗</a>` : ''}
        ${(w.html || '').trim() ? `<button class="btn" data-act="work-copy" data-id="${w.id}">HTML 복사</button>` : ''}
        <span class="sp"></span>
        ${canWork(w) ? `<button class="btn" data-act="work-edit" data-id="${w.id}">수정</button>
          ${st.delAsk ? `<button class="btn danger" data-act="work-del" data-id="${w.id}">한 번 더 누르면 삭제</button>` : `<button class="btn ghost" data-act="work-del" data-id="${w.id}">삭제</button>`}` : ''}
      </div>`;
    const f = card.querySelector('.wv-vis[data-fit] iframe'); if (f) { f.srcdoc = w.html; requestAnimationFrame(() => fitFrames(card)); }
    return;
  }
  const v = st.mode === 'edit' && w ? w : { title: '', topic: '', detail: '', url: '', html: '', image: null };
  const curImg = !st.removeImg && v.image ? (LIVE ? Live.imgUrl(v.image) : v.image) : null;
  card.innerHTML = `${x}<form id="workform" novalidate>
    <h2>${st.mode === 'edit' ? '작업 수정' : '작업 올리기'}</h2>
    <p class="login-sub">프로젝트와 상관없이 만든 작업을 Works에 올립니다.</p>
    <label class="lf"><span>제목 *</span><input id="wk-title" maxlength="80" value="${esc(v.title)}" placeholder="작업 이름"></label>
    <label class="lf"><span>한 줄 소개</span><input id="wk-topic" maxlength="120" value="${esc(v.topic)}" placeholder="무엇을 만들었는지 한 줄로"></label>
    <label class="lf"><span>설명</span><textarea id="wk-detail" rows="3" placeholder="만든 과정, 사용한 도구, 참고한 것 등">${esc(v.detail)}</textarea></label>
    <label class="lf"><span>웹앱 주소</span><input id="wk-url" type="url" inputmode="url" value="${esc(v.url)}" placeholder="https://"></label>
    <div class="lf"><span>HTML <small>(붙여 넣으면 Works에 실제 화면이 썸네일로 보입니다)</small></span>
      <textarea id="wk-html" rows="4" spellcheck="false" class="mono" placeholder="<!doctype html> 부터 붙여 넣거나 파일을 불러오세요">${esc(v.html)}</textarea>
      <div class="wk-row"><label class="btn" for="wk-htmlfile">HTML 파일 불러오기</label><input id="wk-htmlfile" class="sr" type="file" accept=".html,.htm,text/html"></div></div>
    <div class="lf"><span>대표 이미지 <small>(HTML이 없을 때 썸네일로 쓰입니다)</small></span>
      <div class="wk-row">
        ${curImg || st.file ? `<span class="wk-file">${st.file ? esc(st.file.name) : '현재 이미지'}</span><button class="btn ghost" type="button" data-act="work-img-x">지우기</button>` : ''}
        <label class="btn" for="wk-img">${curImg || st.file ? '다른 이미지' : '이미지 선택'}</label><input id="wk-img" class="sr" type="file" accept="image/*"></div></div>
    <p class="err-text" id="wk-err"${st.err ? '' : ' hidden'}>${esc(st.err || '')}</p>
    <div class="wv-actions"><span class="sp"></span>
      <button class="btn ghost" type="button" data-act="${st.mode === 'edit' ? 'work-view' : 'close-work'}" data-id="${v.id || ''}">취소</button>
      <button class="btn solid" type="submit">${st.mode === 'edit' ? '저장' : '올리기'}</button></div>
  </form>`;
}
function readWorkForm() {
  const g = id => document.getElementById(id).value;
  return { title: g('wk-title').trim(), topic: g('wk-topic').trim(), detail: g('wk-detail').trim(), url: g('wk-url').trim(), html: g('wk-html') };
}
async function submitWork() {
  const st = ui.work, data = readWorkForm();
  const keep = () => { const v = readWorkForm(); return v; };
  if (!data.title) { st.err = '제목을 입력하세요'; const snap = keep(); renderWork(); refill(snap); return; }
  if (data.url && !/^https?:\/\/\S+/i.test(data.url)) { st.err = '웹앱 주소는 https:// 로 시작해야 합니다'; const snap = keep(); renderWork(); refill(snap); return; }
  const prev = st.mode === 'edit' ? (state.works || []).find(x => x.id === st.id) : null;
  const saved = await Store.saveWork(prev, data, { file: st.file, removeImg: st.removeImg });
  renderSidebar(); if (ui.view === 'works') renderMain();
  ui.work = { mode: 'view', id: saved.id }; renderWork(); toast(prev ? '작업을 수정했습니다' : 'Works에 올렸습니다');
}
function refill(v) { const s = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; }; s('wk-title', v.title); s('wk-topic', v.topic); s('wk-detail', v.detail); s('wk-url', v.url); s('wk-html', v.html); }

/* ---------- render ---------- */
function renderSidebar() {
  const list = [...state.projects].sort((a, b) => a.no - b.no);
  document.getElementById('plist').innerHTML = list.map(p =>
    `<button class="pitem" data-act="pick" data-id="${p.id}" aria-current="${ui.view === 'project' && p.id === ui.pid}">
      <span class="pname">Project ${p.no}</span><span class="psub">${p.sub ? esc(p.sub) : '부제 없음'}</span></button>`).join('')
    || '<p class="plist-empty">아직 프로젝트가 없습니다</p>';
  document.querySelector('.add-proj').hidden = !can.manage();
  const wl = document.querySelector('.navlink'); wl.setAttribute('aria-current', ui.view === 'works');
  const n = worksList().length; document.getElementById('workcount').textContent = n ? n : '';
}
function renderAuthButtons() {
  const top = document.querySelector('.login-top'), side = document.querySelector('.login-side'), who = document.getElementById('whoami');
  top.textContent = auth.me ? auth.me.name : auth.user && LIVE ? '계정' : '로그인'; top.classList.toggle('signed', !!auth.user);
  side.textContent = auth.user ? '로그아웃' : '로그인'; side.dataset.act = auth.user ? 'logout' : 'open-login';
  who.textContent = auth.me ? `${auth.me.name} · ${ROLE_KO[auth.me.role]}` : auth.user && LIVE ? (auth.user.email || '') : '';
  who.hidden = !who.textContent;
}
function renderMain() {
  const main = document.getElementById('main');
  main.classList.toggle('home', ui.view === 'home');
  const app = document.querySelector('.app'); app.classList.toggle('home-mode', ui.view === 'home'); app.classList.toggle('proj-mode', ui.view !== 'home'); app.classList.remove('side-open');
  const bg = app.querySelector('.bgscope'); if (ui.view !== 'home' && !bg.dataset.set) { bg.style.backgroundImage = `url("${ASSET.scope}")`; bg.dataset.set = '1'; }
  if (ui.view === 'home') {
    main.innerHTML = stageHTML() + (ui.loadError ? `<p class="load-err">데이터를 불러오지 못했습니다. ${esc(ui.loadError)}</p>` : '');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    mountHero(!ui.introPlayed && !reduce); ui.introPlayed = true;
    return;
  }
  stopHero();
  if (ui.view === 'works') { main.innerHTML = worksHTML(); mountWorks(); return; }
  const p = cur(); if (!p) { goHome(); return; }
  const pendingMe = auth.me && auth.me.role === 'pending';
  const subEdit = can.manage();
  main.innerHTML = `
    ${pendingMe ? `<div class="notice">가입 신청이 접수되었습니다. 관리자가 승인하면 내 칸과 노트를 작성할 수 있습니다.</div>` : ''}
    ${ui.loadError ? `<div class="notice warn">데이터를 불러오지 못했습니다. ${esc(ui.loadError)}</div>` : ''}
    <header class="phead">
      <h1 class="ptitle">Project ${p.no}</h1>
      ${subEdit ? `<input class="subinput" id="sub-${p.id}" data-bind="sub" value="${esc(p.sub)}" placeholder="부제 입력" aria-label="Project ${p.no} 부제">`
        : `<p class="subtext">${esc(p.sub)}</p>`}
    </header>
    <div class="top-row">
      <section class="tr"><div class="period lg">
        <div id="cal">${calHTML(p)}</div>
        <div class="dates" id="dates">${datesHTML(p)}</div>
      </div></section>
      <section class="tr"><div class="board lg" id="board">${boardHTML(p)}</div></section>
    </div>
    <section>
      <div class="section-label members-bar">${membersHTML()}</div>${memberBarHTML()}
      <div class="cards">${active().map(m => cardHTML(p, m)).join('') || '<p class="note-empty">아직 승인된 멤버가 없습니다.</p>'}</div>
    </section>
    ${ui.panel ? panelHTML(p) : ''}
    <p class="credit credit-page">Designed and built by Rain</p>`;
  document.getElementById('cal').classList.toggle('picking', !!picking(p));
  if (ui.panel && ui.tab === 'html' && ui.htmlView === 'preview') { const f = document.getElementById('pv'); if (f) f.srcdoc = ent(p, ui.panel).html; }
  bindDrop();
}
function render() { renderSidebar(); renderMain(); renderAuthButtons(); setSave('idle'); }

/* ---------- auth dialog ---------- */
function openAuth() { ui.authMsg = null; ui.authTab = 'login'; document.getElementById('login').hidden = false; renderAuth(); }
function closeAuth() { document.getElementById('login').hidden = true; }
function renderAuth() {
  const card = document.getElementById('authcard');
  const msg = ui.authMsg ? `<p class="${ui.authMsg.ok ? 'ok-text' : 'err-text'}" id="auth-msg">${esc(ui.authMsg.text)}</p>` : '<p class="err-text" id="auth-msg" hidden></p>';
  const x = `<button class="login-x" type="button" data-act="close-login" aria-label="닫기">×</button>`;
  if (!LIVE) {
    const opt = (k, label) => `<button type="button" class="seg${Local.demoAs === k ? ' on' : ''}" data-act="demo-as" data-who="${k}">${label}</button>`;
    card.innerHTML = `<h2>미리보기 모드</h2>
      <p class="login-sub">Supabase가 연결되기 전이라 로그인 대신 보는 사람을 바꿔 볼 수 있습니다.</p>
      <div class="segs">${opt('admin', '관리자 BEE')}${opt('member', '멤버 SUN')}${opt('guest', '방문자')}</div>
      <p class="login-sub small">실제 로그인과 가입은 배포한 사이트에서 동작합니다.</p>${x}`;
    return;
  }
  if (auth.user && auth.me) {
    card.innerHTML = `<h2>${esc(auth.me.name)}</h2>
      <p class="login-sub">${esc(auth.user.email || '')} · ${ROLE_KO[auth.me.role]}</p>
      ${auth.me.role === 'pending' ? '<p class="login-sub">가입 신청이 접수되었습니다. 관리자가 승인하면 작성할 수 있습니다.</p>' : ''}
      ${msg}<button class="btn login-go ghostish" type="button" data-act="logout">로그아웃</button>${x}`;
    return;
  }
  if (auth.user && !auth.me) {
    card.innerHTML = `<form id="joinform" novalidate><h2>멤버 신청</h2>
      <p class="login-sub">이 계정은 아직 Vibe for Two 멤버가 아닙니다. 사용할 닉네임을 정해 신청해 주세요.</p>
      <label class="lf"><span>닉네임</span><input id="join-nick" maxlength="12" autocomplete="nickname" placeholder="2~12자"></label>
      ${msg}<button class="btn solid login-go" type="submit">신청하기</button>
      <button class="btn ghost login-alt" type="button" data-act="logout">로그아웃</button></form>${x}`;
    return;
  }
  const tabs = `<div class="segs" role="tablist"><button type="button" class="seg${ui.authTab === 'login' ? ' on' : ''}" data-act="auth-tab" data-tab="login" role="tab" aria-selected="${ui.authTab === 'login'}">로그인</button><button type="button" class="seg${ui.authTab === 'signup' ? ' on' : ''}" data-act="auth-tab" data-tab="signup" role="tab" aria-selected="${ui.authTab === 'signup'}">가입하기</button></div>`;
  if (ui.authTab === 'login') {
    card.innerHTML = `<form id="loginform" novalidate>${tabs}
      <label class="lf"><span>이메일</span><input id="login-email" type="email" autocomplete="username" placeholder="name@example.com"></label>
      <label class="lf"><span>비밀번호</span><input id="login-pw" type="password" autocomplete="current-password"></label>
      ${msg}<button class="btn solid login-go" type="submit">로그인</button>
      <button class="link-btn" type="button" data-act="reset-pw">비밀번호를 잊으셨나요?</button></form>${x}`;
  } else {
    card.innerHTML = `<form id="signupform" novalidate>${tabs}
      <label class="lf"><span>닉네임</span><input id="su-nick" maxlength="12" autocomplete="nickname" placeholder="사이트에 표시될 이름 (2~12자)"></label>
      <label class="lf"><span>이메일</span><input id="su-email" type="email" autocomplete="email" placeholder="name@example.com"></label>
      <label class="lf"><span>비밀번호</span><input id="su-pw" type="password" autocomplete="new-password" placeholder="8자 이상"></label>
      <label class="lf"><span>비밀번호 확인</span><input id="su-pw2" type="password" autocomplete="new-password"></label>
      <p class="login-sub small">가입하면 관리자 승인 후 내 칸과 노트를 작성할 수 있습니다.</p>
      ${msg}<button class="btn solid login-go" type="submit">가입하기</button></form>${x}`;
  }
}
function authError(e) {
  const m = (e && e.message) || '';
  if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다.';
  if (/Email not confirmed/i.test(m)) return '메일 인증이 아직 안 되었습니다. 받은 메일의 링크를 눌러 주세요.';
  if (/already registered|already been registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인해 주세요.';
  if (/Password should be/i.test(m)) return '비밀번호는 8자 이상으로 정해 주세요.';
  if (/rate limit|too many/i.test(m)) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  return friendly(e);
}
function authSay(text, ok) { ui.authMsg = { text, ok: !!ok }; const el = document.getElementById('auth-msg'); if (el) { el.textContent = text; el.className = ok ? 'ok-text' : 'err-text'; el.hidden = false; } }
const validNick = n => /^[A-Za-z0-9가-힣_.-]{2,12}$/.test(n);

async function doLogin() {
  const em = document.getElementById('login-email').value.trim(), pw = document.getElementById('login-pw').value;
  if (!/^\S+@\S+\.\S+$/.test(em)) return authSay('이메일 주소를 확인해 주세요.');
  if (!pw) return authSay('비밀번호를 입력하세요.');
  const { error } = await sb.auth.signInWithPassword({ email: em, password: pw });
  if (error) return authSay(authError(error));
  auth.user = (await sb.auth.getUser()).data.user; await refresh(); ui.authMsg = null;
  if (auth.me) { closeAuth(); toast(`${auth.me.name}님, 반갑습니다`); } else renderAuth();
}
async function doSignup() {
  const nick = document.getElementById('su-nick').value.trim(), em = document.getElementById('su-email').value.trim();
  const pw = document.getElementById('su-pw').value, pw2 = document.getElementById('su-pw2').value;
  if (!validNick(nick)) return authSay('닉네임은 2~12자의 한글, 영문, 숫자로 정해 주세요.');
  if (!/^\S+@\S+\.\S+$/.test(em)) return authSay('이메일 주소를 확인해 주세요.');
  if (pw.length < 8) return authSay('비밀번호는 8자 이상으로 정해 주세요.');
  if (pw !== pw2) return authSay('비밀번호 확인이 일치하지 않습니다.');
  const { data: free, error: e1 } = await sb.rpc('vft_nickname_available', { n: nick });
  if (e1) return authSay(friendly(e1));
  if (!free) return authSay('이미 쓰고 있는 닉네임입니다. 다른 이름을 골라 주세요.');
  const { data, error } = await sb.auth.signUp({ email: em, password: pw, options: { data: { vft_nickname: nick }, emailRedirectTo: location.origin + location.pathname } });
  if (error) return authSay(authError(error));
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
    return authSay('이미 가입된 이메일입니다. 로그인한 뒤 멤버 신청을 해 주세요.');
  if (data.session) { auth.user = data.user; await refresh(); closeAuth(); toast('가입 신청이 접수되었습니다. 관리자 승인을 기다려 주세요'); }
  else { ui.authTab = 'login'; renderAuth(); authSay('확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.', true); }
}
async function doJoin() {
  const nick = document.getElementById('join-nick').value.trim();
  if (!validNick(nick)) return authSay('닉네임은 2~12자의 한글, 영문, 숫자로 정해 주세요.');
  const { data, error } = await sb.rpc('vft_request_join', { n: nick });
  if (error) return authSay(friendly(error));
  if (data === 'taken') return authSay('이미 쓰고 있는 닉네임입니다.');
  if (data === 'invalid') return authSay('닉네임은 2~12자로 정해 주세요.');
  await refresh(); closeAuth(); toast('멤버 신청이 접수되었습니다');
}
async function doResetPw() {
  const el = document.getElementById('login-email'); const em = el ? el.value.trim() : '';
  if (!/^\S+@\S+\.\S+$/.test(em)) return authSay('비밀번호를 재설정할 이메일 주소를 위 칸에 먼저 입력해 주세요.');
  const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname });
  if (error) return authSay(authError(error));
  authSay('비밀번호 재설정 메일을 보냈습니다.', true);
}

/* ---------- actions ---------- */
async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); }
  catch (e) { if (fallbackEl) { fallbackEl.focus(); fallbackEl.select && fallbackEl.select(); } toast('선택해 두었습니다. Ctrl+C로 복사하세요'); }
}
function readAsDataURL(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }
async function addFiles(list, mid) {
  const p = cur(); if (!can.entry(mid)) return;
  let n = 0; setSave('saving');
  for (const f of list) {
    try { await Store.uploadFile(p, mid, f); n++; } catch (e) { console.error(e); toast(friendly(e)); }
  }
  setSave('ok'); renderMain(); if (n) toast(`파일 ${n}개를 올렸습니다`);
}
function bindDrop() {
  const d = document.getElementById('drop'); if (!d) return;
  d.addEventListener('dragover', ev => { ev.preventDefault(); d.classList.add('over'); });
  d.addEventListener('dragleave', () => d.classList.remove('over'));
  d.addEventListener('drop', ev => { ev.preventDefault(); d.classList.remove('over'); if (ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files, d.dataset.m); });
}
const scrollPanel = () => { const el = document.getElementById('panel'); if (el) el.scrollIntoView({ block: 'nearest' }); };
async function guarded(fn) { if (ui.busy) return; ui.busy = true; try { await fn(); } catch (e) { console.error(e); toast(friendly(e)); if (LIVE) refresh(); } finally { ui.busy = false; } }

document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, p = cur();
  if (a === 'pick') openProject(b.dataset.id);
  else if (a === 'home') goHome();
  else if (a === 'works') { ui.view = 'works'; ui.panel = null; render(); window.scrollTo(0, 0); }
  else if (a === 'works-by') { ui.worksBy = b.dataset.m; renderMain(); }
  else if (a === 'work-new') { if (can.write()) openWork('new'); }
  else if (a === 'work-view') { if (b.dataset.id) openWork('view', b.dataset.id); else closeWork(); }
  else if (a === 'work-edit') openWork('edit', b.dataset.id);
  else if (a === 'close-work') closeWork();
  else if (a === 'work-img-x') { const snap = readWorkForm(); ui.work.file = null; ui.work.removeImg = true; renderWork(); refill(snap); }
  else if (a === 'work-copy') { const w = state.works.find(x => x.id === b.dataset.id); if (w) copyText(w.html); }
  else if (a === 'work-del') {
    const w = state.works.find(x => x.id === b.dataset.id); if (!w) return;
    if (!ui.work.delAsk) { ui.work.delAsk = true; renderWork(); return; }
    guarded(async () => { await Store.delWork(w); closeWork(); renderSidebar(); if (ui.view === 'works') renderMain(); toast('작업을 지웠습니다'); });
  }
  else if (a === 'open-work') { openProject(b.dataset.p); ui.panel = b.dataset.m; ui.tab = 'plan'; renderMain(); const el = document.getElementById('panel'); if (el) el.scrollIntoView({ block: 'start' }); }
  else if (a === 'replay') mountHero(true);
  else if (a === 'toggle-side') document.querySelector('.app').classList.toggle('side-open');
  else if (a === 'open-login') openAuth();
  else if (a === 'close-login') closeAuth();
  else if (a === 'auth-tab') { ui.authTab = b.dataset.tab; ui.authMsg = null; renderAuth(); }
  else if (a === 'demo-as') { Local.setDemo(b.dataset.who); ui.panel = null; ui.memberMenu = null; renderAuth(); render(); }
  else if (a === 'logout' && !LIVE) { Local.setDemo('guest'); ui.panel = null; ui.memberMenu = null; closeAuth(); render(); toast('로그아웃했습니다 (미리보기)'); }
  else if (a === 'logout') guarded(async () => { await sb.auth.signOut(); auth.user = null; auth.me = null; closeAuth(); await refresh(); toast('로그아웃했습니다'); });
  else if (a === 'reset-pw') guarded(doResetPw);
  else if (a === 'cal-move') { const v = calView(p); v.m += +b.dataset.d; if (v.m < 0) { v.m = 11; v.y--; } if (v.m > 11) { v.m = 0; v.y++; } document.getElementById('cal').innerHTML = calHTML(p); }
  else if (a === 'cal-day') {
    if (!can.admin()) return;
    const d = b.dataset.date;
    if (picking(p) && p.start && d >= p.start) { p.end = d; ui.pick = null; queueProject(p, { start: p.start, end: p.end }, 50); }
    else { p.start = d; p.end = ''; ui.pick = { pid: p.id }; }
    renderPeriod(p); renderSidebar();
  }
  else if (a === 'cal-reset') { if (!can.admin()) return; p.start = ''; p.end = ''; ui.pick = null; queueProject(p, { start: '', end: '' }, 50); renderPeriod(p); }
  else if (a === 'del-note') {
    const id = b.dataset.id;
    if (ui.pendingNote === id) guarded(async () => { await Store.delNote(p, id); ui.pendingNote = null; renderBoard(p); toast('노트를 지웠습니다'); });
    else { ui.pendingNote = id; renderBoard(p); }
  }
  else if (a === 'add-project') guarded(async () => {
    if (!can.manage()) return;
    const no = Math.max(0, ...state.projects.map(x => x.no)) + 1;
    const np = await Store.createProject(no); openProject(np.id);
    const s = document.getElementById('sub-' + np.id); if (s) s.focus();
  });
  else if (a === 'member-menu') { const id = b.dataset.m; ui.memberMenu = ui.memberMenu === id && !ui.confirmRemove ? null : id; ui.confirmRemove = null; renderMain(); }
  else if (a === 'ask-remove') { ui.confirmRemove = b.dataset.m; renderMain(); }
  else if (a === 'remove-member') guarded(async () => {
    const m = state.members.find(x => x.id === b.dataset.m); if (!m) return;
    await Store.removeMember(m); if (ui.panel === m.id) ui.panel = null; ui.memberMenu = null; ui.confirmRemove = null; renderMain(); toast(`${m.name}을(를) 멤버에서 뺐습니다`);
  });
  else if (a === 'set-role') guarded(async () => {
    const m = state.members.find(x => x.id === b.dataset.m); if (!m) return;
    await Store.setRole(m, b.dataset.role); renderMain(); toast(b.dataset.role === 'manager' ? `${m.name}을(를) 매니저로 지정했습니다` : `${m.name}의 매니저 권한을 해제했습니다`);
  });
  else if (a === 'toggle-pending') { ui.showPending = !ui.showPending; renderMain(); }
  else if (a === 'approve') guarded(async () => { const m = state.members.find(x => x.id === b.dataset.m); await Store.setRole(m, 'member'); renderMain(); toast(`${m.name}의 가입을 승인했습니다`); });
  else if (a === 'reject') guarded(async () => { const m = state.members.find(x => x.id === b.dataset.m); await Store.removeMember(m); renderMain(); toast(`${m.name}의 신청을 거절했습니다`); });
  else if (a === 'copy-url') { const i = document.getElementById(b.dataset.target); if (!i.value.trim()) { toast('웹앱 주소가 비어 있습니다'); return; } copyText(i.value.trim(), i); }
  else if (a === 'copy-html') { const h = ent(p, b.dataset.m).html; if (!h.trim()) { toast('복사할 HTML이 없습니다'); return; } copyText(h, document.querySelector('.code')); }
  else if (a === 'toggle-panel') {
    const mid = b.dataset.m; ui.panel = ui.panel === mid ? null : mid; ui.viewFile = null; ui.pendingDel = null; renderMain();
    if (ui.panel) { const el = document.getElementById('panel'); if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  }
  else if (a === 'tab') { ui.tab = b.dataset.tab; ui.pendingDel = null; renderMain(); scrollPanel(); }
  else if (a === 'hview') { ui.htmlView = b.dataset.v; renderMain(); scrollPanel(); }
  else if (a === 'view-file') {
    const id = b.dataset.id;
    if (ui.viewFile === id) { ui.viewFile = null; renderMain(); scrollPanel(); return; }
    ui.viewFile = id; ui.viewData = null; renderMain(); scrollPanel();
    const rec = ent(p, ui.panel).files.find(f => f.id === id);
    Promise.resolve(Store.fileContent(rec)).then(d => { if (ui.viewFile !== id) return; ui.viewData = d == null ? '미리 볼 수 없는 파일입니다.' : d; renderMain(); scrollPanel(); })
      .catch(e => { ui.viewData = '파일을 불러오지 못했습니다.'; renderMain(); });
  }
  else if (a === 'del-file') {
    const id = b.dataset.id, mid = b.dataset.m;
    if (ui.pendingDel === id) guarded(async () => {
      const rec = ent(p, mid).files.find(f => f.id === id); await Store.delFile(p, mid, rec);
      if (ui.viewFile === id) ui.viewFile = null; ui.pendingDel = null; renderMain(); scrollPanel(); toast('파일을 지웠습니다');
    });
    else { ui.pendingDel = id; renderMain(); scrollPanel(); }
  }
});
document.addEventListener('click', ev => {
  const app = document.querySelector('.app');
  if (app.classList.contains('side-open') && !ev.target.closest('.side,.menu-btn')) app.classList.remove('side-open');
});
document.addEventListener('mouseover', ev => {
  const cal = document.getElementById('cal'); if (!cal || !cal.classList.contains('picking')) return;
  const cell = ev.target.closest('#cal.picking button.d'), p = cur(), h = cell ? cell.dataset.date : null;
  cal.querySelectorAll('button.d').forEach(x => x.classList.toggle('pv', !!h && x.dataset.date > p.start && x.dataset.date <= h));
});

function submitNote() {
  const p = cur(), ta = document.getElementById('note-text'), err = document.getElementById('note-err'), text = ta.value.trim();
  if (!text) { err.textContent = '내용을 입력하세요'; err.hidden = false; ta.focus(); return; }
  guarded(async () => { await Store.addNote(p, text); ui.pendingNote = null; renderBoard(p); });
}
document.addEventListener('submit', ev => {
  const id = ev.target.id; if (!['noteform', 'loginform', 'signupform', 'joinform', 'workform'].includes(id)) return;
  ev.preventDefault();
  if (id === 'noteform') submitNote();
  else if (id === 'loginform') guarded(doLogin);
  else if (id === 'signupform') guarded(doSignup);
  else if (id === 'joinform') guarded(doJoin);
  else if (id === 'workform') guarded(async () => { try { await submitWork(); } catch (e) { const snap = readWorkForm(); ui.work.err = friendly(e); renderWork(); refill(snap); } });
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { const m = document.getElementById('login'); if (m && !m.hidden) closeAuth(); const w = document.getElementById('workmodal'); if (w && !w.hidden) closeWork(); }
  if (ev.target.id === 'note-text' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitNote(); }
});

document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.id === 'note-text') { const e = document.getElementById('note-err'); if (e) e.hidden = true; }
  if (t.closest && t.closest('#authcard')) { const m = document.getElementById('auth-msg'); if (m && !m.classList.contains('ok-text')) m.hidden = true; ui.authMsg = null; }
  const bind = t.dataset.bind; if (!bind) return;
  const p = cur();
  if (bind === 'sub') { if (!can.manage()) return; p.sub = t.value; renderSidebar(); queueProject(p, { sub: t.value }); }
  else if (bind === 'entry') {
    const mid = t.dataset.m, f = t.dataset.f; if (!can.entry(mid)) return;
    const val = f === 'progress' ? +t.value : t.type === 'checkbox' ? t.checked : t.value;
    ent(p, mid)[f] = val; queueEntry(p, mid, { [f]: val });
    if (f === 'done') { const row = t.closest('.done-row'); row.classList.toggle('on', val); row.querySelector('b').textContent = val ? '작업 완료' : '작업 완료로 표시'; row.querySelector('small').textContent = val ? 'Works에 공개되어 있습니다' : '완료하면 Works에 모입니다'; renderSidebar(); if (val) toast('Works에 올라갔습니다'); }
    if (f === 'progress') { const bar = document.getElementById('pb-' + t.id.slice(3)); if (bar) bar.style.width = t.value + '%'; }
    if (f === 'url') { const o = document.getElementById('o-' + t.id.slice(2)); const ok = /^https?:\/\/\S+/i.test(t.value.trim()); o.hidden = !ok; o.href = ok ? t.value.trim() : '#'; }
  }
});
document.addEventListener('change', async ev => {
  const t = ev.target;
  if (t.id === 'upfile' && t.files.length) await addFiles(t.files, t.dataset.m);
  else if (t.id === 'wk-img' && t.files[0]) { const snap = readWorkForm(); ui.work.file = t.files[0]; ui.work.removeImg = false; renderWork(); refill(snap); }
  else if (t.id === 'wk-htmlfile' && t.files[0]) { document.getElementById('wk-html').value = await t.files[0].text(); toast(`${t.files[0].name}을(를) 불러왔습니다`); }
  else if (t.id === 'htmlfile' && t.files[0]) {
    const f = t.files[0], p = cur(), mid = t.dataset.m; if (!can.entry(mid)) return;
    const html = await f.text(); ent(p, mid).html = html; queueEntry(p, mid, { html }); ui.htmlView = 'code'; renderMain(); toast(`${f.name}을(를) 불러왔습니다`);
  }
});
window.addEventListener('beforeunload', ev => { if (busySaving()) { ev.preventDefault(); ev.returnValue = ''; } });
window.addEventListener('focus', () => {
  if (!LIVE || busySaving()) return;
  const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  refresh();
});

/* ---------- start ---------- */
(async function start() {
  try { await Store.init(); } catch (e) { console.error(e); ui.loadError = friendly(e); }
  render();
})();
