(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // When an updated worker takes control of this page, reload once so the
  // page runs the code matching the new caches. Skip the very first
  // install (no previous controller) and never reload more than once.
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) { hadController = true; return; }
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(function (registration) { registration.update(); })
      .catch(function () {});
  });
})();
