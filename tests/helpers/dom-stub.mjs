/**
 * DOM 桩：让 src/*.js 能在 node 里被真实 import 并驱动。
 * 各模块只在函数体内访问 document/window，故在调用前装好即可。
 *
 * 关键点：元素必须按 id 缓存（同一 id 多次 getElementById 返回同一对象），
 * 否则「注册监听 → 触发监听」会落在两个不同对象上，测试变成空跑。
 */
export function installDomStubs({ invoke, elements = {} } = {}) {
  const calls = [];
  const listeners = new Map();   // id -> { event: [fn, ...] }
  const cache = new Map();       // id -> element

  function mkEl(id) {
    if (cache.has(id)) return cache.get(id);
    const el = {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      title: '',
      disabled: false,
      hidden: false,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      dataset: {},
      style: {},
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k] ?? null; },
      addEventListener(ev, fn) {
        if (!listeners.has(id)) listeners.set(id, {});
        const m = listeners.get(id);
        (m[ev] = m[ev] || []).push(fn);
      },
      dispatch(ev, arg) {
        const fns = (listeners.get(id) || {})[ev] || [];
        return Promise.all(fns.map((f) => f(arg)));
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild() {}, append() {}, remove() {}, replaceChildren() {},
      closest: () => null,
      focus() {}, click() {},
      ...(elements[id] || {}),
    };
    cache.set(id, el);
    return el;
  }

  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          calls.push({ cmd, args });
          return invoke ? invoke(cmd, args) : {};
        },
      },
      shell: { open: async () => {} },
      event: { listen: async () => () => {} },
      window: { getCurrent: () => ({ setBackgroundColor: async () => {} }) },
    },
    addEventListener: () => {},
    open: () => {},
    matchMedia: () => ({ matches: false }),
    confirm: () => true,
  };

  const store = {};
  globalThis.document = {
    getElementById: (id) => mkEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => mkEl('_new' + Math.random()),
    body: { appendChild() {} },
    visibilityState: 'visible',
    documentElement: { dataset: {} },
  };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  globalThis.sessionStorage = globalThis.localStorage;
  // node 24 的 navigator/crypto 是只读 getter，必须 defineProperty 覆盖
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

  define('navigator', { clipboard: { writeText: async () => {} } });
  if (!globalThis.crypto) define('crypto', { getRandomValues: (b) => b });

  return { calls, listeners, getEl: mkEl, store };
}

/** 清掉模块缓存，让下一次 import 拿到全新实例（模块级状态需要重置时用） */
export async function freshImport(spec) {
  const url = new URL(spec, import.meta.url).href;
  return import(url + '?t=' + Date.now() + Math.random());
}
