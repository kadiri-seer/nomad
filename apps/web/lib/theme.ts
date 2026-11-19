/** Where the chosen mode is kept. The script in the root layout reads it before the page paints. */
export const THEME_KEY = "nomad-theme";

/** Sets the saved mode on <html> before the first paint, so a dark page never flashes light. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
