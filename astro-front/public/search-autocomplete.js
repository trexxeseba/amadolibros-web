(() => {
  const inputs = [...document.querySelectorAll('form[action="/catalogo"] input[name="q"]')];
  if (!inputs.length) return;

  inputs.forEach((input, index) => {
    const list = document.createElement('datalist');
    list.id = `amado-search-suggestions-${index + 1}`;
    document.body.appendChild(list);
    input.setAttribute('list', list.id);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');

    let timer;
    let controller;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < 2) {
        list.replaceChildren();
        return;
      }
      timer = setTimeout(async () => {
        controller?.abort();
        controller = new AbortController();
        try {
          const response = await fetch(`/api/search-suggestions?q=${encodeURIComponent(query)}`, {
            signal: controller.signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          list.replaceChildren(...(data.suggestions || []).map(suggestion => {
            const option = document.createElement('option');
            option.value = suggestion.value;
            option.label = suggestion.label;
            return option;
          }));
        } catch (error) {
          if (error.name !== 'AbortError') list.replaceChildren();
        }
      }, 180);
    });
  });
})();
