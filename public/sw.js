self.addEventListener('push', (event) => {
  let data = { title: 'Word of the Day', body: 'Tap to view', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  const { title, body, url } = data;
  event.waitUntil(self.registration.showNotification(title, {
    body, icon: '/icon-192.png', badge: '/badge.png', data: { url }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil(self.clients.openWindow(url));
});
