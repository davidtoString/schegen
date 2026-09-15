// Attach the server-rendered CSRF token only to same-origin mutations.
(() => {
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : input, window.location.href);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (target.origin === window.location.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('X-CSRF-Token', document.querySelector('meta[name="csrf-token"]')?.content || '');
      init = { ...init, headers };
    }
    const response = await fetchOriginal(input, init);
    if (response.status === 401 && target.origin === window.location.origin) window.location.assign('/login');
    return response;
  };
})();
