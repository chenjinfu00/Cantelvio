// KaTeX and its fonts are served locally, including when the network is unavailable.
export function renderMath(root = document) {
  const elements = [...root.querySelectorAll("[data-tex]")];
  for (const element of elements) {
    if (element.dataset.mathRendered === "true") continue;
    try {
      window.katex.render(element.dataset.tex, element, {
        displayMode: element.dataset.display === "true",
        output: "htmlAndMathml",
        throwOnError: true,
        trust: false,
        strict: "error"
      });
      element.dataset.mathRendered = "true";
    } catch (error) {
      element.dataset.mathRendered = "error";
      element.textContent = element.dataset.tex;
      console.error("Formula rendering failed", error);
    }
  }
}

if (document.readyState === "loading" || !window.katex) {
  document.addEventListener("DOMContentLoaded", () => renderMath(), { once: true });
} else {
  renderMath();
}
