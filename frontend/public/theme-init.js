// Blocking head script: restore appearance before CSS paints. No account data is stored.
(function () {
  var theme = 'dark';
  try {
    var saved = document.cookie.split(';').map(function (part) { return part.trim(); })
      .find(function (part) { return part.indexOf('shensi_theme=') === 0; });
    if (saved) theme = saved.slice('shensi_theme='.length) === 'light' ? 'light' : 'dark';
    else if (localStorage.getItem('shensi.theme') === 'light') theme = 'light';
  } catch (_) { /* Storage restrictions must not block startup. */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}());
