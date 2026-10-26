// Content script side of the page bridge (src/page/bridge.js, MAIN world): request → answer
// over window.postMessage. Only the methods the bridge allows exist.

let seq = 0;
/** @type {Map<string, (v: any) => void>} */
const pending = new Map();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.__ywl !== 'res' || typeof m.id !== 'string') return;
    const done = pending.get(m.id);
    if (done) {
      pending.delete(m.id);
      done(m.result);
    }
  });
}

/**
 * @param {'browse' | 'edit' | 'navigate' | 'status'} method
 * @param {any} [body]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
export function call(method, body, timeoutMs = 45000) {
  listen();
  const id = `ywl-${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ status: 0, error: 'timeout' });
    }, timeoutMs);
    pending.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    window.postMessage({ __ywl: 'req', id, method, body }, location.origin);
  });
}
