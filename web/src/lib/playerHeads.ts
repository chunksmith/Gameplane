const CACHE_NAME = "player-heads-v1";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const loaded = new Map<string, Promise<string>>();

export function playerHeadUrl(name: string): Promise<string> {
  const key = name.toLowerCase();
  let url = loaded.get(key);
  if (!url) {
    url = loadHead(key).catch((err: unknown) => {
      loaded.delete(key);
      throw err;
    });
    loaded.set(key, url);
  }
  return url;
}

async function loadHead(name: string): Promise<string> {
  const src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`;
  if (typeof caches === "undefined") return src;
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(src);
  if (hit && Date.now() - Number(hit.headers.get("x-cached-at")) < TTL_MS)
    return URL.createObjectURL(await hit.blob());
  const res = await fetch(src, { referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`player head ${res.status}`);
  const blob = await res.blob();
  await cache.put(src, new Response(blob, { headers: { "x-cached-at": String(Date.now()) } }));
  return URL.createObjectURL(blob);
}
