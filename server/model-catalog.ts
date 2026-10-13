import type { Provider, Model } from "./provider.js";
import type { ImageEndpoint } from "./image-settings.js";

export type ModelInfo = Model & { imageEndpoints?: ImageEndpoint[] };
export type ModelCatalog = ReturnType<typeof createModelCatalog>;

export function createModelCatalog(provider: Provider) {
  let snapshot: ModelInfo[] | undefined;
  let pending: Promise<ModelInfo[]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const listeners = new Set<(models: ModelInfo[]) => void>();

  async function load() {
    const models = await provider.models();
    return Promise.all(
      models.map(async (model): Promise<ModelInfo> => {
        if (!model.image) return model;
        try {
          return {
            ...model,
            imageEndpoints: await provider.imageEndpoints(model.id),
          };
        } catch {
          return {
            ...model,
            imageEndpoints: snapshot?.find((old) => old.id === model.id)
              ?.imageEndpoints,
          };
        }
      }),
    );
  }

  function refresh(): Promise<ModelInfo[]> {
    return (pending ??= load()
      .then((models) => {
        snapshot = models;
        for (const listener of listeners) listener(models);
        return models;
      })
      .finally(() => {
        pending = undefined;
        if (!closed)
          timer = setTimeout(() => {
            void refresh().catch(() => {});
          }, 300000).unref();
      }));
  }
  return {
    read: () => (snapshot ? Promise.resolve(snapshot) : refresh()),
    subscribe(listener: (models: ModelInfo[]) => void) {
      listeners.add(listener);
      if (snapshot) listener(snapshot);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
