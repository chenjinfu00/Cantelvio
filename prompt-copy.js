document.querySelectorAll('[data-copy-prompt]').forEach(button => {
  button.addEventListener('click', async () => {
    const panel = button.closest('details');
    const prompt = panel.querySelector('.prompt-text');
    const status = panel.querySelector('.copy-status');
    const english = document.documentElement.lang === 'en';
    try {
      await navigator.clipboard.writeText(prompt.innerText);
      status.textContent = english ? 'Copied' : '已复制';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(prompt);
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = english ? 'Text selected; copy it using your device.' : '已选中，请使用设备的复制功能。';
    }
  });
});
