/**
 * Zero-dependency, proxy-aware HTTPS client for BLACK_WALL's egress.
 *
 * Why this exists: Node's global `fetch` (undici) IGNORES the HTTP_PROXY /
 * HTTPS_PROXY environment variables. In a default-deny / proxy-only-egress
 * network — NVIDIA NemoClaw's sandbox, most corporate proxies — a direct
 * `fetch('https://blackwalltier.com/...')` is dropped at the firewall and the
 * gate can never get a verdict. This routes the request through the proxy via an
 * HTTP CONNECT tunnel using only node:net + node:tls, so it adds no dependency
 * and stays tiny when bundled into the OpenClaw blueprint plugin.
 *
 * Exposes a `fetch`-compatible subset: the returned object has { ok, status,
 * statusText, headers.get(), json(), text() } — exactly what lib/forecast.mjs
 * and lib/observe.mjs consume. AbortSignal (the fail-closed timeout) is honored.
 */
import net from 'node:net';
import tls from 'node:tls';

/**
 * Pick the proxy for a target URL from the environment, honoring NO_PROXY.
 * Returns the proxy URL string, or null if no proxy applies / is configured.
 */
export function getProxyForUrl(targetUrl, env = process.env) {
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return null;
  }
  const noProxy = env.NO_PROXY || env.no_proxy || '';
  if (noProxy.trim()) {
    const host = u.hostname;
    for (const raw of noProxy.split(',')) {
      const entry = raw.trim();
      if (!entry) continue;
      if (entry === '*') return null;
      const bare = entry.replace(/^\./, '');
      if (host === bare || host.endsWith('.' + bare)) return null;
    }
  }
  const proxy =
    u.protocol === 'https:'
      ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
      : env.HTTP_PROXY || env.http_proxy;
  return proxy && proxy.trim() ? proxy.trim() : null;
}

// Strip CR/LF so a hostile header/key value can't inject extra headers into the
// manually-serialized request line.
const clean = (v) => String(v).replace(/[\r\n]/g, '');

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl === -1) break;
    const size = parseInt(buf.slice(i, nl).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = nl + 2;
    out.push(buf.slice(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * Build a fetch-like function that tunnels HTTPS requests through an HTTP CONNECT
 * proxy.
 *
 * @param {string} proxyUrl  e.g. "http://10.200.0.1:3128" (optional user:pass)
 * @param {object} [opts]
 * @param {object} [opts.tls]  extra options forwarded to tls.connect (tests only)
 * @returns {(url: string, init?: object) => Promise<object>} fetch-compatible subset
 */
export function proxyFetch(proxyUrl, opts = {}) {
  const proxy = new URL(proxyUrl);
  return function fetchViaProxy(targetUrl, init = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(targetUrl);
      if (target.protocol !== 'https:') {
        reject(new Error('proxyFetch supports https targets only'));
        return;
      }
      const targetHost = target.hostname;
      const targetPort = target.port || '443';
      const signal = init.signal;

      let settled = false;
      let proxySocket;
      let tlsSocket;
      const cleanup = () => {
        try { tlsSocket && tlsSocket.destroy(); } catch { /* ignore */ }
        try { proxySocket && proxySocket.destroy(); } catch { /* ignore */ }
        if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
      };
      const fail = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
      const done = (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } };
      const onAbort = () =>
        fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

      if (signal) {
        if (signal.aborted) return onAbort();
        if (signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
      }

      // 1) TCP connect to the proxy
      proxySocket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
      proxySocket.on('error', fail);

      proxySocket.once('connect', () => {
        // 2) Ask the proxy to open a raw tunnel to the target host:port
        let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
        if (proxy.username) {
          const creds = Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
          ).toString('base64');
          req += `Proxy-Authorization: Basic ${creds}\r\n`;
        }
        req += 'Connection: keep-alive\r\n\r\n';
        proxySocket.write(req);

        let buf = Buffer.alloc(0);
        const onConnectData = (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          proxySocket.removeListener('data', onConnectData);
          const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
          const m = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
          if (!m || m[1] !== '200') {
            fail(new Error(`proxy CONNECT rejected: ${statusLine || '(no status)'}`));
            return;
          }
          // Hand any bytes the proxy already sent past the CONNECT response back to
          // the socket so the TLS layer reads them.
          const rest = buf.slice(idx + 4);
          if (rest.length) proxySocket.unshift(rest);

          // 3) TLS over the tunnel (verifies the target cert by default; tests opt out)
          tlsSocket = tls.connect({
            socket: proxySocket,
            servername: targetHost,
            ...(opts.tls || {}),
          });
          tlsSocket.on('error', fail);
          tlsSocket.once('secureConnect', sendRequest);
        };
        proxySocket.on('data', onConnectData);
      });

      const sendRequest = () => {
        const method = (init.method || 'GET').toUpperCase();
        const path = target.pathname + target.search;
        const headers = init.headers || {};
        const bodyBuf =
          init.body == null
            ? null
            : Buffer.from(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));

        let req = `${method} ${path} HTTP/1.1\r\nHost: ${clean(targetHost)}\r\n`;
        for (const [k, v] of Object.entries(headers)) {
          if (['host', 'content-length', 'connection'].includes(k.toLowerCase())) continue;
          req += `${clean(k)}: ${clean(v)}\r\n`;
        }
        if (bodyBuf) req += `Content-Length: ${bodyBuf.length}\r\n`;
        req += 'Connection: close\r\n\r\n';
        tlsSocket.write(req);
        if (bodyBuf) tlsSocket.write(bodyBuf);

        const chunks = [];
        tlsSocket.on('data', (c) => chunks.push(c));
        tlsSocket.on('end', () => finish(Buffer.concat(chunks)));
        tlsSocket.on('close', () => { if (!settled) finish(Buffer.concat(chunks)); });
      };

      const finish = (raw) => {
        const sep = raw.indexOf('\r\n\r\n');
        if (sep === -1) { fail(new Error('malformed response: no header terminator')); return; }
        const headPart = raw.slice(0, sep).toString('latin1');
        let body = raw.slice(sep + 4);
        const lines = headPart.split('\r\n');
        const statusLine = lines.shift() || '';
        const sm = /^HTTP\/\d\.\d (\d{3})(?: (.*))?$/.exec(statusLine);
        const status = sm ? Number(sm[1]) : 0;
        const statusText = sm ? sm[2] || '' : '';
        const respHeaders = {};
        for (const line of lines) {
          const ci = line.indexOf(':');
          if (ci > 0) respHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
        }
        if ((respHeaders['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
          body = dechunk(body);
        }
        const text = body.toString('utf8');
        done({
          ok: status >= 200 && status < 300,
          status,
          statusText,
          headers: { get: (k) => respHeaders[String(k).toLowerCase()] ?? null },
          async text() { return text; },
          async json() { return JSON.parse(text); },
        });
      };
    });
  };
}
