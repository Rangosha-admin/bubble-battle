self.addEventListener('install', (e) => {
    console.log('Фоновый воркер установлен!');
});

self.addEventListener('fetch', (e) => {
    // Оставляем пустым, чтобы пропускать все сетевые запросы к серверу
});