// fetch with a timeout and a readable error
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export async function fetchJson(url, { timeout = 12000, headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'user-agent': BROWSER_UA, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(`${res.status} from ${new URL(url).host}: ${(json && (json.message || json.error?.message || json.error)) || text.slice(0, 160)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}
