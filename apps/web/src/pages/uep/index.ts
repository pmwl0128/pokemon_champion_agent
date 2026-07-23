/** Barrel for the local-only UEP panel chunk: App.tsx lazy-imports BOTH pages from this one
 * module so Vite emits a single dynamic chunk the online runtime never downloads (design §2
 * — capability-gated dynamic import, no build-time switch). */
export { SessionsPage } from "./SessionsPage.tsx";
export { SessionPage } from "./SessionPage.tsx";
