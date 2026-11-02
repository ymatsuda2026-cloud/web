// 書庫のサービスワーカー：画面一式と、GitHub から取った暗号化済みのデータを端末に置く
const SHELL = "shoko-shell-v1", DATA = "shoko-data", FONTS = "shoko-fonts";
const SHELL_FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("shoko-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // GitHub の本文・目録（.age は暗号化されたまま保存。トークンは保存しない）
  if (url.host === "api.github.com" && url.pathname.includes("/contents/") && url.pathname.endsWith(".age")) {
    e.respondWith((async () => {
      const c = await caches.open(DATA);
      try {
        const res = await fetch(req);
        if (res.ok) await c.put(req.url, res.clone());   // URL だけを鍵にし、Authorization ヘッダーは残さない
        return res;
      } catch (err) {
        const hit = await c.match(req.url);
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }

  // 文字（Google Fonts）は一度取れば使い回す
  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // 画面一式：通信できれば最新を取り、できなければ保存分を使う
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (err) {
        return (await c.match(req, { ignoreSearch:true })) || (req.mode === "navigate" ? await c.match("index.html") : undefined) || Response.error();
      }
    })());
  }
});
