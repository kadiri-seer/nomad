/** The website, and links to pages that only exist there (the local app is a static copy without the server). */
export const WEBSITE = "https://www.thenomad.website";
export const webOnly = (path: string) => (process.env.NEXT_PUBLIC_NOMAD_EXPORT === "1" ? `${WEBSITE}${path}` : path);
