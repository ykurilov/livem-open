// Сервис-воркер веб-чата лидмагнита: показывает уведомления о новых сообщениях и открывает чат по нажатию.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Новое сообщение", {
      body: data.body || "",
      tag: data.tag || "web-chat",
      renotify: true,
      icon: "/web-chat/icon-192.png",
      badge: "/web-chat/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.split("?")[0] === url.split("?")[0]);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
