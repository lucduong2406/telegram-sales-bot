const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const START_TIMEOUT_MS = 30000;

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
        const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        state.proc = proc;
        let settled = false;
        let buf = '';

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            proc.kill();
            reject(new Error('Hết thời gian chờ cloudflared tạo domain (30s)'));
        }, START_TIMEOUT_MS);

        const onData = (chunk) => {
            if (settled) return;
            buf += chunk.toString();
            const url = parseTunnelUrl(buf);
            if (url) {
                settled = true;
                clearTimeout(timer);
                resolve(url);
            }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);

        proc.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        proc.on('exit', (code) => {
            if (state.proc === proc) {
                state.proc = null;
                state.url = null;
            }
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(new Error(`cloudflared thoát sớm (mã ${code})`));
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

module.exports = { parseTunnelUrl, ensureBinary, start, stop, getStatus, setOnUrl };
