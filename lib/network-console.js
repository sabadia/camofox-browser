/**
 * Network & Console capture for Camofox Browser
 * Enables API request interception via Playwright events + JS injection
 */

const MAX_CONSOLE_LOGS = 500;
const MAX_NETWORK_ENTRIES = 500;

/**
 * Attach console and network listeners to a Playwright page.
 * Mutates tabState in place (adds .consoleLogs and .networkEntries).
 */
export function attachNetworkConsole(page, tabState) {
  tabState.consoleLogs = [];
  tabState.networkEntries = [];

  // --- Console capture ---
  page.on('console', (msg) => {
    const entry = {
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      timestamp: Date.now(),
    };
    tabState.consoleLogs.push(entry);
    if (tabState.consoleLogs.length > MAX_CONSOLE_LOGS) {
      tabState.consoleLogs.shift();
    }
  });

  page.on('pageerror', (err) => {
    tabState.consoleLogs.push({
      type: 'pageerror',
      text: err.message,
      timestamp: Date.now(),
    });
  });

  // --- Network capture ---
  page.on('request', (req) => {
    const entry = {
      id: req.url() + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData: req.postData(),
      resourceType: req.resourceType(),
      timestamp: Date.now(),
      response: null,
    };
    tabState.networkEntries.push(entry);
    if (tabState.networkEntries.length > MAX_NETWORK_ENTRIES) {
      tabState.networkEntries.shift();
    }

    // Link response to entry
    req._ncEntryId = entry.id;
  });

  page.on('response', (res) => {
    const req = res.request();
    const entryId = req?._ncEntryId;
    if (!entryId) return;

    const entry = tabState.networkEntries.find((e) => e.id === entryId);
    if (!entry) return;

    try {
      const headers = res.headers();
      entry.response = {
        status: res.status(),
        statusText: res.statusText(),
        headers,
        timestamp: Date.now(),
      };
    } catch (_) {}
  });

  page.on('requestfailed', (req) => {
    const entryId = req?._ncEntryId;
    if (!entryId) return;
    const entry = tabState.networkEntries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.response = {
      failed: true,
      failureText: req.failure()?.errorText || 'unknown',
      timestamp: Date.now(),
    };
  });
}

/**
 * Inject a fetch/XHR interceptor into the page so subsequent requests
 * are logged to window.__camofox_network_log (accessible via /evaluate).
 */
export async function injectNetworkInterceptor(page) {
  await page.evaluate(() => {
    if (window.__camofox_network_injected) return;
    window.__camofox_network_injected = true;
    window.__camofox_network_log = window.__camofox_network_log || [];

    const push = (data) => {
      window.__camofox_network_log.push({ ...data, timestamp: Date.now() });
      if (window.__camofox_network_log.length > 500) {
        window.__camofox_network_log.shift();
      }
    };

    // Intercept fetch
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const [url, options = {}] = args;
      const start = performance.now();
      try {
        const res = await origFetch.apply(this, args);
        push({
          type: 'fetch',
          url: String(url),
          method: options.method || 'GET',
          body: options.body ? String(options.body).slice(0, 5000) : undefined,
          status: res.status,
          statusText: res.statusText,
          durationMs: Math.round(performance.now() - start),
        });
        return res;
      } catch (err) {
        push({
          type: 'fetch',
          url: String(url),
          method: options.method || 'GET',
          error: err.message,
          durationMs: Math.round(performance.now() - start),
        });
        throw err;
      }
    };

    // Intercept XHR
    const OrigXHR = window.XMLHttpRequest;
    const XHRProxy = new Proxy(OrigXHR, {
      construct(target, args) {
        const xhr = new target(...args);
        const origOpen = xhr.open;
        const origSend = xhr.send;
        let method = 'GET';
        let url = '';
        let body = null;

        xhr.open = function (m, u, ...rest) {
          method = m;
          url = String(u);
          return origOpen.apply(this, [m, u, ...rest]);
        };

        xhr.send = function (data) {
          body = data ? String(data).slice(0, 5000) : undefined;
          const start = performance.now();
          const onload = () => {
            push({
              type: 'xhr',
              url,
              method,
              body,
              status: xhr.status,
              statusText: xhr.statusText,
              responseText: xhr.responseText?.slice(0, 5000),
              durationMs: Math.round(performance.now() - start),
            });
          };
          const onerror = () => {
            push({
              type: 'xhr',
              url,
              method,
              body,
              error: 'XHR error',
              durationMs: Math.round(performance.now() - start),
            });
          };
          xhr.addEventListener('load', onload);
          xhr.addEventListener('error', onerror);
          return origSend.apply(this, [data]);
        };

        return xhr;
      },
    });
    window.XMLHttpRequest = XHRProxy;
  });
}

/**
 * Return console logs (optionally filtered by type).
 */
export function getConsoleLogs(tabState, { type, limit = 100, clear = false } = {}) {
  let logs = tabState.consoleLogs || [];
  if (type) {
    logs = logs.filter((l) => l.type === type);
  }
  logs = logs.slice(-limit);
  if (clear) {
    tabState.consoleLogs = [];
  }
  return logs;
}

/**
 * Return network entries (optionally filtered by resourceType or method).
 */
export function getNetworkEntries(tabState, { resourceType, method, limit = 100, clear = false } = {}) {
  let entries = tabState.networkEntries || [];
  if (resourceType) {
    entries = entries.filter((e) => e.resourceType === resourceType);
  }
  if (method) {
    entries = entries.filter((e) => e.method === method.toUpperCase());
  }
  entries = entries.slice(-limit);
  if (clear) {
    tabState.networkEntries = [];
  }
  return entries;
}
