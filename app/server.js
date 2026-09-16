const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

async function downloadFile(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.kuwo.cn/'
    }, signal: controller.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('html') || ct.includes('text') || ct.includes('json')) throw new Error('非音频 ' + ct);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 10000) throw new Error('文件太小 ' + buf.length);
    return buf;
  } finally { clearTimeout(timer); }
}

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/downloads';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = process.env.PORT || 5200;
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 认证
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const envUser = process.env.ADMIN_USER;
const envPass = process.env.ADMIN_PASS;
let authData = {
  users: [{ user: envUser || 'admin', pass: envPass || 'admin', role: 'admin' }],
  sessions: {}
};
if (fs.existsSync(AUTH_FILE)) {
  try { authData = { ...authData, ...JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) }; } catch {}
}
// 如果有环境变量，强制同步admin账户（安装向导设置的密码优先）
if (envUser && envPass) {
  const admin = authData.users.find(x => x.role === 'admin');
  if (admin) {
    admin.user = envUser;
    admin.pass = envPass;
  } else {
    authData.users.push({ user: envUser, pass: envPass, role: 'admin' });
  }
  saveAuth();
} else if (!fs.existsSync(AUTH_FILE)) {
  // 没有环境变量且无auth.json，创建默认admin/admin
  saveAuth();
}
function saveAuth() { fs.writeFileSync(AUTH_FILE, JSON.stringify(authData)); }

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body;
  const u = authData.users.find(x => x.user === user && x.pass === pass);
  if (u) {
    const token = require('crypto').randomBytes(16).toString('hex');
    authData.sessions[token] = user;
    saveAuth();
    res.json({ ok: true, token, role: u.role, user, canDownload: u.canDownload || false });
  } else {
    res.status(401).json({ ok: false, msg: '用户名或密码错误' });
  }
});

function getUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = authData.sessions[token];
  return authData.users.find(x => x.user === user);
}

function checkAuth(req, res, next) {
  if (req.path === '/api/login' || req.path === '/' || req.path === '/login.html') return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (authData.sessions[token]) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function requireAdmin(req, res, next) {
  const u = getUser(req);
  if (u && u.role === 'admin') return next();
  return res.status(403).json({ error: '无权限' });
}

function requireDownload(req, res, next) {
  const u = getUser(req);
  if (u && u.role === 'admin') return next();
  return res.status(403).json({ error: '仅管理员可下载到NAS' });
}

app.post('/api/change-auth', checkAuth, requireAdmin, (req, res) => {
  const { user, pass } = req.body;
  const admin = authData.users.find(x => x.role === 'admin');
  if (admin) {
    if (user) admin.user = user;
    if (pass) admin.pass = pass;
  }
  saveAuth();
  res.json({ ok: true });
});

app.get('/api/users', checkAuth, requireAdmin, (req, res) => {
  res.json({ users: authData.users.map(u => ({ user: u.user, role: u.role, canDownload: u.canDownload || false })) });
});

app.post('/api/users', checkAuth, requireAdmin, (req, res) => {
  const { user, pass, role, canDownload } = req.body;
  if (!user || !pass) return res.status(400).json({ error: '用户名密码不能为空' });
  if (authData.users.find(x => x.user === user)) return res.status(400).json({ error: '用户已存在' });
  authData.users.push({ user, pass, role: role || 'guest', canDownload: canDownload || false });
  saveAuth();
  res.json({ ok: true });
});

app.put('/api/users/:user', checkAuth, requireAdmin, (req, res) => {
  const u = authData.users.find(x => x.user === req.params.user);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (req.body.canDownload !== undefined) u.canDownload = req.body.canDownload;
  if (req.body.pass) u.pass = req.body.pass;
  saveAuth();
  res.json({ ok: true });
});

app.delete('/api/users/:user', checkAuth, requireAdmin, (req, res) => {
  const u = req.params.user;
  if (u === 'admin') return res.status(400).json({ error: '不能删除管理员' });
  authData.users = authData.users.filter(x => x.user !== u);
  saveAuth();
  res.json({ ok: true });
});

app.use(checkAuth);
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
app.use('/preview', express.static(path.join(DATA_DIR, 'preview'), { maxAge: 86400000 }));

// ===== 配置与歌单 =====
const CONFIG_FILE = path.join(DATA_DIR, 'api-config.json');
const PLAYLIST_DIR = path.join(DATA_DIR, 'playlists');

const defaultConfig = {
  // 音乐下载API列表（按顺序尝试，一个失败自动切下一个）
  musicApis: [
    { name: 'oiapi酷我(支持无损)', url: 'https://oiapi.net/api/Kuwo?msg={kw}&n=1&br={br}', br128: 3, br320: 2, brFlac: 1, type: 'kuwo' },
    { name: 'bugpk网易', url: 'https://api.bugpk.com/api/163_music?type=json&ids={id}', br128: 128, br320: 320, brFlac: 999, type: 'netease' }
  ],
  platforms: [
    { key:'wy', name:'网易', icon:'🎵', color:'#e60026', api:'https://music.163.com/api/playlist/detail?id={id}', lists:{ '3778678':'热歌','19723756':'飙升','2884035':'新歌','11246304':'流行','991319590':'抖音','60198':'说唱','14028249541':'全球说唱','12225155968':'欧美R&B','71384707':'欧美热歌','3001835560':'ACG动画','60131':'古风','2250011882':'原创','2184521073':'电音','5059661515':'民谣','60192':'古典','8661209031':'乐夏','6688069460':'识曲','12768855486':'合伙人','5453912201':'VIP爱听','7785123708':'VIP新歌','2809513713':'网络','180106':'UK','22406213':'韩国','1200022431':'日本' } },
    { key:'qq', name:'QQ', icon:'🐧', color:'#12b7f5', api:'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid={id}&format=json&inCharset=utf-8&outCharset=utf-8', lists:{ '26':'热歌','27':'飙升','3':'内地','4':'港台','5':'欧美','6':'韩国','7':'日本','11':'民谣','12':'摇滚','13':'嘻哈','15':'电子','16':'影视' } },
    { key:'kg', name:'酷狗', icon:'🐶', color:'#00c853', api:'http://mobilecdn.kugou.com/api/v3/rank/song?rankid={id}&page=1&pagesize=100&format=json', lists:{ '6666':'热歌','31864':'飙升','9964':'新歌','25131':'华语','16273':'欧美','62727':'粤语','27364':'民谣','21451':'DJ','10936':'说唱' } }
  ]
};
let apiConfig = JSON.parse(JSON.stringify(defaultConfig));
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (saved.platforms) apiConfig.platforms = saved.platforms;
    if (Array.isArray(saved.musicApis)) apiConfig.musicApis = saved.musicApis;
  } catch {}
}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(apiConfig, null, 2)); }

app.get('/api/config', (req, res) => res.json(apiConfig));
app.post('/api/config', (req, res) => {
  if (req.body.platforms) apiConfig.platforms = req.body.platforms;
  if (req.body.musicApis) apiConfig.musicApis = req.body.musicApis;
  saveConfig();
  res.json({ ok: true });
});
if (!fs.existsSync(PLAYLIST_DIR)) fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

// 遍历配置的音乐API获取URL并立即下载
async function oiapiDownload(title, artist, quality, songId) {
  const apis = (apiConfig.musicApis || []).filter(a => a && a.url);
  for (const api of apis) {
    try {
      const br = quality === 'flac' ? api.brFlac : (quality === '320k' ? api.br320 : api.br128);
      const keyword = encodeURIComponent(title + ' ' + (artist || ''));
      const apiUrl = api.url
        .replace('{kw}', keyword)
        .replace('{id}', songId || '')
        .replace('{br}', br || '');
      console.log('尝试API:', api.name, apiUrl.substring(0, 100));
      const r = await fetch(apiUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
      const text = await r.text();
      let d;
      try { d = JSON.parse(text); } catch { continue; }
      let url = null;
      // 兼容多种返回格式
      if (d.data && d.data.url) url = d.data.url;
      else if (d.url && typeof d.url === 'string' && d.url.startsWith('http')) url = d.url;
      else if (d.message) {
        const m = d.message.match(/音乐链接：(\S+)/);
        if (m) url = m[1];
      }
      if (!url) { console.log(api.name, '无URL'); continue; }
      console.log(api.name, 'URL:', url.substring(0, 80));
      const buf = await downloadFile(url);
      if (buf && buf.length > 10000) {
        const ext = (url.split('?')[0].match(/\.(\w+)$/) || [])[1] || (quality === 'flac' ? 'flac' : 'mp3');
        return { url, buf, ext };
      }
    } catch(e) { console.log(api.name, 'error:', e.message); }
  }
  return null;
}

// ===== 搜索：多平台 =====
function parseKuwo(text) {
  try { return (new Function('return ' + text))(); } catch(e) { return { abslist: [] }; }
}

async function searchKuwo(keyword) {
  const url = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=1&rn=20&rformat=json&encoding=utf8`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.kuwo.cn/' } });
  const data = parseKuwo(await resp.text());
  return (data.abslist || []).map(s => ({ platform: 'kuwo', id: s.MUSICRID, title: s.SONGNAME, artist: s.ARTIST, album: s.ALBUM || '' }));
}

async function searchQQ(keyword) {
  const resp = await fetch(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&format=json&p=1&n=20`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://y.qq.com/' } });
  const data = await resp.json();
  return (data.data?.song?.list || []).map(s => ({ platform: 'qq', id: s.songmid, title: s.songname, artist: s.singer?.[0]?.name || '', album: s.albumname || '' }));
}

async function search163(keyword) {
  const resp = await fetch(`https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=20`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
  const data = await resp.json();
  return (data.result?.songs || []).map(s => {
    const sizeBytes = (s.l && s.l.size) || (s.m && s.m.size) || (s.h && s.h.size) || 0;
    return {
      platform: '163', id: s.id, title: s.name,
      artist: (s.ar || []).map(a => a.name).join(' / '),
      album: s.al?.name || '',
      sizeMB: sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) : ''
    };
  });
}

async function searchPlatform(platform, keyword) {
  if (platform === 'qq') return searchQQ(keyword);
  if (platform === '163') return search163(keyword);
  return searchKuwo(keyword);
}

async function getTopList(listId) {
  const url = (apiConfig.wyToplist || defaultConfig.wyToplist).replace('{id}', listId);
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
  const data = await resp.json();
  return (data.result?.tracks || []).slice(0, 50).map(s => {
    const sizeBytes = (s.l && s.l.size) || (s.m && s.m.size) || (s.h && s.h.size) || 0;
    return { platform: '163', id: s.id, title: s.name, artist: (s.artists || s.ar || []).map(a => a.name).join(' / '), album: s.album?.name || s.al?.name || '', sizeMB: sizeBytes ? (sizeBytes / 1024 / 1024).toFixed(1) : '' };
  });
}

// 试听：根据歌名歌手找播放链接，按相似度匹配
function normalize(s) {
  return (s || '').toLowerCase().replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '').replace(/[^\w\u4e00-\u9fa5]/g, '');
}

function scoreSong(song, targetTitle, targetArtist) {
  let score = 0;
  const nt = normalize(song.title), tt = normalize(targetTitle);
  const na = normalize(song.artist), ta = normalize(targetArtist || '');
  // 歌名匹配（必须有一定匹配度）
  let titleScore = 0;
  if (nt === tt) titleScore = 100;
  else if (nt.includes(tt) || tt.includes(nt)) titleScore = 60;
  else {
    let overlap = 0;
    for (const ch of tt) if (nt.includes(ch)) overlap++;
    titleScore = overlap / Math.max(tt.length, 1) * 30;
  }
  // 歌名完全不匹配直接淘汰
  if (titleScore < 15) return -999;
  score += titleScore;
  // 歌手匹配
  if (ta) {
    if (na === ta) score += 60;
    else if (na.includes(ta) || ta.includes(na)) score += 40;
    else {
      let overlap = 0;
      for (const ch of ta) if (na.includes(ch)) overlap++;
      if (overlap >= 2) score += 15;
      else score -= 20;
    }
  }
  return score;
}

app.get('/api/preview', async (req, res) => {
  try {
    const { title, artist } = req.query;
    // 1. 多平台搜索得到歌曲（优先网易云）
    const queries = [
      { kw: (title || '') + ' ' + (artist || ''), platforms: ['163', 'qq'] },
      { kw: title || '', platforms: ['163', 'qq'] },
      { kw: (title || '').replace(/[（(].*?[)）]/g, '').trim(), platforms: ['163', 'qq'] }
    ].filter(q => q.kw);
    let best = null, bestScore = 0;
    for (const { kw, platforms } of queries) {
      for (const plat of platforms) {
        try {
          const results = await searchPlatform(plat, kw);
          for (const r of results) {
            const s = scoreSong(r, title, artist);
            if (s > bestScore) { bestScore = s; best = r; }
          }
          if (bestScore >= 150) break;
        } catch(e) {}
      }
      if (bestScore >= 150) break;
    }
    if (!best || bestScore < 20) return res.status(404).json({ error: 'not found' });

    // 2. 通过配置的音乐API获取URL并立即下载
    const src = await oiapiDownload(best.title, best.artist, '128k', best.id);
    if (src && src.buf) {
      const tmpDir = path.join(DATA_DIR, 'preview');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + src.ext);
      fs.writeFileSync(tmpFile, src.buf);
      return res.json({ url: '/preview/' + path.basename(tmpFile), title: best.title, artist: best.artist });
    }
    res.status(404).json({ error: '未找到可播放资源', title: best.title, artist: best.artist });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== API路由 =====
app.get('/api/search', async (req, res) => {
  try { res.json({ results: await searchPlatform(req.query.platform || '163', req.query.keyword) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// 获取歌词
app.get('/api/lyric', async (req, res) => {
  try {
    const { title, artist } = req.query;
    // 先搜网易云
    const results = await search163(`${title} ${artist || ''}`);
    if (!results.length) return res.json({ lyric: '' });
    const id = results[0].id;
    const r = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
    const d = await r.json();
    res.json({ lyric: d.lrc?.lyric || '', pic: results[0].pic || '' });
  } catch(e) { res.json({ lyric: '' }); }
});

// 获取歌曲封面
app.get('/api/pic', async (req, res) => {
  try {
    const { title, artist } = req.query;
    const results = await search163(`${title} ${artist || ''}`);
    if (!results.length) return res.json({ pic: '' });
    // 获取歌曲详情拿封面
    const id = results[0].id;
    const r = await fetch(`https://music.163.com/api/song/detail?ids=[${id}]`, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
    const d = await r.json();
    const pic = d.songs?.[0]?.album?.picUrl || '';
    res.json({ pic, artistPic: pic });
  } catch(e) { res.json({ pic: '' }); }
});

// 通用排行榜接口：根据platform和listId从配置取API
app.get('/api/toplist', async (req, res) => {
  try {
    const pKey = req.query.platform || 'wy';
    const listId = req.query.listId || '';
    const plat = apiConfig.platforms.find(p => p.key === pKey);
    if (!plat) return res.status(400).json({ error: '未知平台' });
    const url = plat.api.replace('{id}', listId);
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (pKey === 'wy') headers['Referer'] = 'https://music.163.com/';
    if (pKey === 'qq') headers['Referer'] = 'https://y.qq.com/';
    const r = await fetch(url, { headers });
    const j = await r.json();
    let songs = [];
    if (pKey === 'wy') {
      songs = (j.result?.tracks || []).map(s => ({ id: s.id, name: s.name, artist: (s.artists||[]).map(a=>a.name).join(' / '), album: (s.album||{}).name, platform: '163' }));
    } else if (pKey === 'qq') {
      songs = (j.songlist||[]).map(s => ({ id: s.data.songmid, name: s.data.songname, artist: s.data.singer.map(x=>x.name).join(' / '), album: s.data.albumname, platform: 'qq' }));
    } else if (pKey === 'kg') {
      songs = (j.data.info||[]).map(s => ({ id: s.hash, name: s.songname, artist: s.singername, album: '', platform: 'kg' }));
    }
    const listName = plat.lists[listId] || '榜单';
    res.json({ results: songs, name: listName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ===== 下载历史（持久化到服务器） =====
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
let downloadHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
  try { downloadHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
}
function saveHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(downloadHistory.slice(-500))); }

app.get('/api/history', (req, res) => res.json({ history: downloadHistory }));
app.post('/api/history', (req, res) => {
  const { items } = req.body;
  if (Array.isArray(items)) {
    downloadHistory = items.concat(downloadHistory).slice(0, 500);
    saveHistory();
  }
  res.json({ ok: true });
});
app.delete('/api/history', (req, res) => {
  downloadHistory = [];
  saveHistory();
  res.json({ ok: true });
});

// ===== 歌单管理（多歌单） =====
app.get('/api/playlists', (req, res) => {
  const files = fs.readdirSync(PLAYLIST_DIR).filter(f => f.endsWith('.json'));
  const list = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(PLAYLIST_DIR, f), 'utf8'));
      return { name: f.replace('.json', ''), count: (data.songs || data).length, songs: data.songs || data };
    } catch { return { name: f, count: 0, songs: [] }; }
  });
  res.json({ playlists: list });
});

app.post('/api/playlists', (req, res) => {
  const { name, songs } = req.body;
  const safeName = name.replace(/[\/\\:*?"<>|]/g, '_');
  fs.writeFileSync(path.join(PLAYLIST_DIR, safeName + '.json'), JSON.stringify({ songs }));
  res.json({ ok: true });
});

app.post('/api/playlists/:name/songs', (req, res) => {
  const safeName = req.params.name.replace(/[\/\\:*?"<>|]/g, '_');
  const fp = path.join(PLAYLIST_DIR, safeName + '.json');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '歌单不存在' });
  const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const songs = data.songs || data;
  req.body.songs.forEach(s => {
    if (!songs.find(x => (x.title||x.name) === (s.title||s.name) && (x.artist||'') === (s.artist||''))) {
      songs.push({ title: s.title||s.name, artist: s.artist||'' });
    }
  });
  fs.writeFileSync(fp, JSON.stringify({ songs }));
  res.json({ ok: true });
});

app.delete('/api/playlists/:name', (req, res) => {
  const safeName = req.params.name.replace(/[\/\\:*?"<>|]/g, '_');
  try { fs.unlinkSync(path.join(PLAYLIST_DIR, safeName + '.json')); } catch(e) {}
  res.json({ ok: true });
});

// ===== 批量下载 =====
const tasks = new Map();
let taskId = 0;

// 本地下载：服务端通过配置的音乐API取到音频后直接回传文件
app.post('/api/local-download', checkAuth, async (req, res) => {
  try {
    const { song, quality } = req.body;
    if (!song) return res.status(400).json({ error: 'song不能为空' });
    const result = await oiapiDownload(song.title || song.name, song.artist || '', quality || '320k', song.id);
    if (!result || !result.buf) return res.status(404).json({ error: '未找到歌曲链接' });
    const title = (song.title || song.name || 'song').replace(/[\\\/:*?"<>|]/g, '_');
    const artist = (song.artist || '').replace(/[\\\/:*?"<>|]/g, '_');
    const filename = encodeURIComponent(title + ' - ' + artist + '.' + result.ext);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.setHeader('Content-Type', result.ext === 'flac' ? 'audio/flac' : (result.ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg'));
    res.send(result.buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 批量打包下载zip
app.post('/api/local-zip', checkAuth, async (req, res) => {
  try {
    const { songs, quality } = req.body;
    if (!songs || !songs.length) return res.status(400).json({ error: 'songs不能为空' });
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });
    res.setHeader('Content-Disposition', `attachment; filename="songs.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);
    const usedNames = {};
    for (const song of songs) {
      try {
        const result = await oiapiDownload(song.title || song.name, song.artist || '', quality || '320k', song.id);
        if (!result || !result.buf) continue;
        let name = ((song.title || song.name) + ' - ' + (song.artist || '')).replace(/[\\\/:*?"<>|]/g, '_') || 'song';
        if (usedNames[name]) { name = name + ' (' + (++usedNames[name]) + ')'; } else { usedNames[name] = 1; }
        archive.append(result.buf, { name: name + '.' + result.ext });
      } catch(e) { console.log('zip skip:', song.title, e.message); }
    }
    await archive.finalize();
  } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/api/download', requireDownload, async (req, res) => {
  const { songs, quality, type } = req.body;
  const dlType = type || 'nas';
  const id = ++taskId;
  // 去重：所有任务中相同歌曲跳过（包括已完成的）
  const existing = new Set();
  for (const [, t] of tasks) {
    for (const it of t.items) {
      existing.add(it.title + '|' + (it.artist||''));
    }
  }
  const newSongs = songs.filter(s => !existing.has((s.title||s.name)+'|'+(s.artist||'')));
  if (!newSongs.length) return res.json({ taskId: id, total: 0, done: 0, status: 'done', items: [], skipped: songs.length });
  const items = newSongs.map(s => ({ title: s.title || s.name, artist: s.artist, status: '排队中' }));
  tasks.set(id, { total: newSongs.length, done: 0, status: 'running', items, cancelled: false, paused: false, type: dlType });
  res.json({ taskId: id, total: newSongs.length, done: 0, status: 'running', items });

  (async () => {
    const concurrency = 3;
    let idx = 0;

    async function downloadOne(song, i) {
      const task = tasks.get(id);
      if (!task || task.cancelled) return;
      while (task.paused && !task.cancelled) { await new Promise(r => setTimeout(r, 500)); }

      const rawTitle = song.title || '';
      const cleanTitle = rawTitle.replace(/[（(].*?[)）]/g, '').trim();
      let musicUrl = null;
      let bestSong = null;

      // 如果song已有id（从搜索/排行榜来的），直接用
      if (song.id && song.platform === '163') {
        bestSong = { platform: '163', id: song.id, title: rawTitle, artist: song.artist || '' };
      } else {
        const keywords = [cleanTitle + ' ' + (song.artist || ''), rawTitle + ' ' + (song.artist || ''), cleanTitle, rawTitle];
        const platforms = ['163', 'qq'];
        for (const kw of keywords) {
          if (task.cancelled) return;
          for (const plat of platforms) {
            if (task.cancelled) return;
            items[i].status = `搜索中(${plat})`;
            try {
              const results = await searchPlatform(plat, kw);
              for (const r of results) {
                const s = scoreSong(r, rawTitle, song.artist || '');
                if (s >= 100) { bestSong = r; break; }
              }
              if (bestSong) break;
            } catch(e) {}
          }
          if (bestSong) break;
        }
      }

      if (bestSong) {
        items[i].status = '获取链接中';
        // 音质降级链：flac -> 320k -> 128k
        const qualityChain = quality === 'flac' ? ['flac', '320k', '128k'] : (quality === '320k' ? ['320k', '128k'] : ['128k']);
        for (const q of qualityChain) {
          if (task.cancelled) return;
          items[i].status = '获取链接(' + q + ')';
          const result = await oiapiDownload(bestSong.title, bestSong.artist, q, bestSong.id);
          if (result && result.buf) {
            musicUrl = result.url;
            items[i].buf = result.buf;
            items[i].ext = result.ext;
            items[i].status = '下载中';
            break;
          }
        }
      }

      if (!musicUrl) { items[i].status = '未找到资源'; task.done++; return; }
      try {
        if (dlType === 'local') {
          items[i].url = musicUrl;
          items[i].filename = `${song.artist || '未知'}-${rawTitle}.${items[i].ext}`.replace(/[\/\\:*?"<>|]/g, '_');
          items[i].format = items[i].ext;
          items[i].status = '完成';
        } else {
          const buf = items[i].buf;
          const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
          const safeName = `${song.artist || '未知'}-${rawTitle}`.replace(/[\/\\:*?"<>|]/g, '_');
          const filename = safeName + '.' + items[i].ext;
          fs.writeFileSync(path.join(DOWNLOAD_DIR, filename), buf);
          items[i].format = items[i].ext;
          items[i].sizeMB = sizeMB;
          items[i].status = '完成';
        }
      } catch(e) { console.log('download error:', e.message); items[i].status = '失败'; }
      task.done++;
    }

    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= newSongs.length) break;
        await downloadOne(newSongs[i], i);
      }
    }
    await Promise.all(Array(Math.min(concurrency, newSongs.length)).fill(null).map(worker));
    const t = tasks.get(id);
    if (t && !t.cancelled) {
      t.status = 'done';
      // NAS类型完成后自动写历史
      if (dlType !== 'local') {
        t.items.forEach(function(item){
          if(item.status==='完成'){
            downloadHistory.push({title:item.title, artist:item.artist||'', format:item.format||'', sizeMB:item.sizeMB||'', time:Date.now()});
          }
        });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(downloadHistory));
      }
    }
  })();
});

// 本地下载：获取单个已下载文件
app.get('/api/download-file/:taskId/:idx', checkAuth, (req, res) => {
  const task = tasks.get(parseInt(req.params.taskId));
  if (!task) return res.status(404).json({ error: 'not found' });
  const item = task.items[parseInt(req.params.idx)];
  if (!item || !item.filePath || !fs.existsSync(item.filePath)) return res.status(404).json({ error: 'file not found' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.filename || 'song.mp3')}`);
  res.setHeader('Content-Type', item.format === 'flac' ? 'audio/flac' : 'audio/mpeg');
  const stream = fs.createReadStream(item.filePath);
  stream.pipe(res);
  stream.on('end', () => { try { fs.unlinkSync(item.filePath); } catch(e){} });
});

app.get('/api/download/:id', (req, res) => {
  const task = tasks.get(parseInt(req.params.id));
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task);
});
app.post('/api/download/:id/cancel', (req, res) => {
  const task = tasks.get(parseInt(req.params.id));
  if (task) { task.cancelled = true; task.status = 'cancelled'; res.json({ ok: true }); }
});
app.post('/api/download/:id/pause', (req, res) => {
  const task = tasks.get(parseInt(req.params.id));
  if (task) { task.paused = !task.paused; res.json({ ok: true, paused: task.paused }); }
});

app.listen(PORT, () => {
  console.log(`LX Downloader on ${PORT}, ${(apiConfig.musicApis||[]).length} music APIs configured`);
});
