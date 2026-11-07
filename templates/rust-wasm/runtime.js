import init, { App } from "./pkg/game.js";

// Supply Uint8Array/ArrayBuffer bytes for offline startup without a WASM fetch.
export async function start(canvas, { wasm, onError = console.error } = {}) {
  await init({ module_or_path: wasm ?? new URL("./pkg/game_bg.wasm", import.meta.url) });
  const app = new App(canvas);
  const listeners = new AbortController();
  let stopped = false;
  let animation = 0;
  let audio;
  let observer;
  let width = -1;
  let height = -1;
  let scale = -1;

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animation);
    observer?.disconnect();
    listeners.abort();
    for (const id of pointers) {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    }
    pointers.clear();
    app.free();
    if (audio) void audio.close().catch(onError);
  }

  function fail(error) {
    stop();
    onError(error);
  }

  function listen(target, type, handler, options = {}) {
    target.addEventListener(type, (event) => {
      if (stopped) return;
      try { handler(event); } catch (error) { fail(error); }
    }, { ...options, signal: listeners.signal });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nextScale = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.round(rect.width * nextScale));
    const nextHeight = Math.max(1, Math.round(rect.height * nextScale));
    if (nextWidth === width && nextHeight === height && nextScale === scale) return;
    width = nextWidth;
    height = nextHeight;
    scale = nextScale;
    canvas.width = width;
    canvas.height = height;
    app.resize(width, height, scale);
  }

  function redraw(timestamp) {
    if (stopped) return;
    try {
      // Also catches DPR changes that do not change the CSS dimensions.
      if ((window.devicePixelRatio || 1) !== scale) resize();
      app.frame(timestamp / 1000);
      animation = requestAnimationFrame(redraw);
    } catch (error) { fail(error); }
  }

  function activateAudio() {
    if (!audio) {
      audio = new AudioContext();
      app.set_audio(audio);
    }
    if (audio.state === "suspended") void audio.resume().catch(onError);
  }

  const pointers = new Set();
  for (const type of ["keydown", "keyup"]) {
    listen(canvas, type, (event) => {
      if (type === "keydown") activateAudio();
      if (app.key(event, type === "keydown")) event.preventDefault();
    });
  }
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    listen(canvas, type, (event) => {
      if (type === "pointerdown") {
        canvas.focus({ preventScroll: true });
        activateAudio();
        canvas.setPointerCapture(event.pointerId);
        pointers.add(event.pointerId);
      }
      const rect = canvas.getBoundingClientRect();
      if (app.pointer(event, event.clientX - rect.left, event.clientY - rect.top)) {
        event.preventDefault();
      }
      if (type === "pointerup" || type === "pointercancel") {
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        pointers.delete(event.pointerId);
      }
    });
  }
  listen(canvas, "wheel", (event) => {
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    if (app.wheel(event.deltaX * unit, event.deltaY * unit)) event.preventDefault();
  }, { passive: false });
  listen(canvas, "lostpointercapture", (event) => {
    if (pointers.delete(event.pointerId)) app.reset();
  });
  listen(canvas, "focus", () => app.focus(true));
  listen(canvas, "blur", () => app.focus(false));
  listen(window, "blur", () => app.focus(false));
  listen(window, "focus", () => app.focus(document.activeElement === canvas));
  listen(document, "visibilitychange", () => {
    cancelAnimationFrame(animation);
    app.reset();
    if (!document.hidden) animation = requestAnimationFrame(redraw);
  });
  listen(canvas, "webglcontextlost", (event) => {
    event.preventDefault();
    fail(new Error("WebGL context lost. Reload to restart."));
  });
  observer = new ResizeObserver(() => {
    if (!stopped) {
      try { resize(); } catch (error) { fail(error); }
    }
  });
  observer.observe(canvas);
  try {
    resize();
    app.focus(document.activeElement === canvas);
    if (!document.hidden) animation = requestAnimationFrame(redraw);
  } catch (error) {
    stop();
    throw error;
  }
  return { app, stop, get audio() { return audio; } };
}
