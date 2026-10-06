export const DESIGN_WIDTH = 1440;
export const DESIGN_HEIGHT = 810;
export const FLOW_BREAKPOINT = 680;
export const STAGE_INSET = 5;

export function computeStageFit(width, height, inset = STAGE_INSET) {
  const availableWidth = Math.max(0, width - inset * 2);
  const availableHeight = Math.max(0, height - inset * 2);
  const scale = Math.max(0, Math.min(availableWidth / DESIGN_WIDTH, availableHeight / DESIGN_HEIGHT));
  return {
    scale,
    width: DESIGN_WIDTH * scale,
    height: DESIGN_HEIGHT * scale
  };
}

export function installStageFitter(stage, shell, win = window) {
  const flowQuery = win.matchMedia(`(max-width: ${FLOW_BREAKPOINT}px)`);

  const fit = () => {
    if (flowQuery.matches) {
      stage.style.removeProperty("--stage-scale");
      return;
    }
    const { scale } = computeStageFit(shell.clientWidth, shell.clientHeight);
    stage.style.setProperty("--stage-scale", String(scale || 1));
  };

  const observer = new win.ResizeObserver(fit);
  observer.observe(shell);
  flowQuery.addEventListener?.("change", fit);
  fit();

  return () => {
    observer.disconnect();
    flowQuery.removeEventListener?.("change", fit);
  };
}
