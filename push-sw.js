// Service worker for staff sign-up push notifications only. Registered
// at the site root (scope "/") by member.html when a staff account
// clicks "Enable sign-up alerts". Receives pushes sent by
// /api/send-signup-push via the Web Push protocol.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (err) { /* non-JSON payload, use defaults below */ }

  const title = data.title || 'New CareQuest sign-up';
  const options = {
    body: data.body || '',
    data: { url: data.url || '/member' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/member';

  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
