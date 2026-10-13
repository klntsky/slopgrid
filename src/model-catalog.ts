import type { ModelInfo } from "../server/model-catalog";

declare global {
  interface Window {
    __SLOPGRID_MODELS__?: ModelInfo[];
  }
}

export const modelCatalog = window.__SLOPGRID_MODELS__ ?? [];
