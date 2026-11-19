const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 45000;

const state = {
    proc: null,
    starting: null, // in-flight start promise (prevents duplicate spawns)
    url: null,
    error: null,
    wanted: false, // desired state: restart on unexpected exit
    restartTimer: null,
    onUrl: null,
};

/** Extract the quick-tunnel URL from cloudflared output, or null. */
function parseTunnelUrl(text) {
    const m = URL_RE.exec(text || '');
    return m ? m[0].toLowerCase() : null;
}

function findInPath() {
    try {
        const out = execFileSync('which', ['cloudflared'], { encoding: 'utf8' }).trim();
        return out || null;
    } catch (_) {
        return null;
    }
}

/** Locate cloudflared, downloading the Linux binary into ./bin when missing. */
async function ensureBinary() {
    const inPath = findInPath();
    if (inPath) return inPath;

    const local = path.join(BIN_DIR, 'cloudflared');
    if (fs.existsSync(local)) return local;

    if (process.platform !== 'linux') {
        throw new Error('Chưa cài cloudflared. Tự động tải chỉ hỗ trợ Linux — hãy cài cloudflared thủ công.');
    }
    const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch];
    if (!arch) throw new Error(`Kiến trúc CPU không được hỗ trợ: ${process.arch}`);

    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    console.log(`⬇️ Đang tải cloudflared (${arch})...`);
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Tải cloudflared thất bại: HTTP ${resp.status}`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const tmp = local + '.part';
    fs.writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, local);
    return local;
}

function spawnTunnel(bin, port) {
    return new Promise((resolve, reject) => {
        // Quick tunnels ignore-or-break when a named-tunnel ~/.cloudflared/config.yml exists
        // (edge answers 530/1033). Point cloudflared at an empty config to isolate it.
        const emptyCfg = path.join(os.tmpdir(), 'cloudflared-quick-empty.yml');
        fs.writeFileSync(emptyCfg, '# intentionally empty: quick tunnel\n');
        // http2 (TCP) works on networks/LXC where QUIC (UDP) is blocked or throttled
        const proc = spawn(bin, ['tunnel', '--config', emptyCfg, '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        state.proc = proc;
        let settled = false;
        let buf = '';
        let url = null;
        let connected = false;
        const tail = [];

        const fail = (msg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            proc.kill();
            const hint = tail.length ? ` — log cloudflared: ${tail.slice(-3).join(' | ')}` : '';
            reject(new Error(msg + hint));
        };

        const timer = setTimeout(() => {
            fail(url
                ? 'cloudflared có domain nhưng không kết nối được tới Cloudflare (kiểm tra firewall: cho phép TCP/UDP cổng 7844 ra ngoài)'
                : 'Hết thời gian chờ cloudflared tạo domain (45s)');
        }, START_TIMEOUT_MS);

        const onData = (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                const clean = line.replace(/^\S+\s+/, '').trim();
                if (clean) { tail.push(clean.slice(0, 160)); if (tail.length > 8) tail.shift(); }
                // Surface connection problems in the service log for diagnosis
                if (/\b(ERR|WRN)\b|Registered tunnel connection/.test(line)) console.log('[cloudflared]', line.trim().slice(0, 240));
                url = url || parseTunnelUrl(line);
                if (/Registered tunnel connection/i.test(line)) connected = true;
            }
            if (!settled && url && connected) {
                settled = true;
                clearTimeout(timer);
                resolve(url);
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);

        proc.on('error', (err) => fail(err.message));
        proc.on('exit', (code) => {
            if (state.proc === proc) {
                state.proc = null;
                state.url = null;
            }
            if (!settled) {
                fail(`cloudflared thoát sớm (mã ${code})`);
                return;
            }
            if (state.wanted) scheduleRestart(port);
        });
    });
}

function scheduleRestart(port) {
    clearTimeout(state.restartTimer);
    state.error = 'Tunnel bị ngắt, đang kết nối lại...';
    state.restartTimer = setTimeout(() => {
        if (state.wanted) start(port).catch(() => {});
    }, 5000);
}

/**
 * cloudflared prints the URL before the edge routes it to us (404/530 for a few
 * seconds). Poll our own health route through the tunnel until it answers.
 */
async function waitUntilReachable(url, { fetchFn = fetch, attempts = 30, delayMs = 2000 } = {}) {
    for (let i = 0; i < attempts; i++) {
        try {
            const r = await fetchFn(url + '/', { signal: AbortSignal.timeout(5000) });
            if (r.ok) return true;
        } catch (_) { /* DNS/edge not ready yet */ }
        if (i < attempts - 1) await new Promise((res) => setTimeout(res, delayMs));
    }
    return false;
}

/**
 * Start the quick tunnel (idempotent). Resolves with the public https URL.
 * Calls the registered onUrl callback every time a (new) URL becomes available.
 */
function start(port) {
    state.wanted = true;
    if (state.url && state.proc) return Promise.resolve(state.url);
    if (state.starting) return state.starting;

    state.starting = (async () => {
        try {
            const bin = await ensureBinary();
            const url = await spawnTunnel(bin, port);
            // cloudflared reports the connection as registered, so the tunnel is up. The
            // self-check below only warms the edge route; it can fail on VMs whose own DNS
            // can't resolve the new name, so it must not block registration.
            if (!(await waitUntilReachable(url, { attempts: 8 }))) {
                console.warn('⚠️ Tunnel: không tự gọi được domain từ máy chủ, vẫn tiếp tục đăng ký');
            }
            state.url = url;
            state.error = null;
            console.log(`🌐 Cloudflare Tunnel: ${url}`);
            if (state.onUrl) {
                try { await state.onUrl(url); } catch (e) { state.error = e.message; console.error('⚠️ Tunnel onUrl:', e.message); }
            }
            return url;
        } catch (err) {
            state.error = err.message;
            console.error('❌ Cloudflare Tunnel:', err.message);
            if (state.wanted) scheduleRestartAfterFailure(port);
            throw err;
        } finally {
            state.starting = null;
        }
    })();
    return state.starting;
}

function scheduleRestartAfterFailure(port) {
    clearTimeout(state.restartTimer);
    state.restartTimer = setTimeout(() => {
        if (state.wanted) start(port).catch(() => {});
    }, 30000);
}

function stop() {
    state.wanted = false;
    clearTimeout(state.restartTimer);
    if (state.proc) state.proc.kill();
    state.proc = null;
    state.url = null;
    state.error = null;
}

function setOnUrl(fn) { state.onUrl = fn; }

function getStatus() {
    return {
        wanted: state.wanted,
        running: !!(state.proc && state.url),
        starting: !!state.starting,
        url: state.url,
        error: state.error,
    };
}

process.on('exit', () => { if (state.proc) state.proc.kill(); });

module.exports = { parseTunnelUrl, waitUntilReachable, ensureBinary, start, stop, getStatus, setOnUrl };
