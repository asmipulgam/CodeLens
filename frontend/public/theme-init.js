// Applies the saved theme before first paint to avoid a light/dark flash.
(function () {
  var theme = null;
  try {
    theme = window.localStorage.getItem('codelens.theme');
  } catch (e) {
    theme = null;
  }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (theme === 'dark' || ((theme === null || theme === 'system') && prefersDark)) {
    document.documentElement.classList.add('dark');
  }
})();
