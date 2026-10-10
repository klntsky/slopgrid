// Apply the saved choice before the app and its styles render.
(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("slopgrid-theme");
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {}
  document.documentElement.dataset.theme =
    preference === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preference;
})();
