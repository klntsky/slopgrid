import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { validateDraftInput } from "./draft-input";
import type { ReferenceImage } from "../../server/image-settings";
import { queryClient } from "../queries";
import { useInferenceMutation } from "../use-inference-mutation";
import { clearDraft, creationSubmission, type Draft } from "./draft";
import { removeReferenceFile, uploadReferences } from "./reference-files";

export function useCreateSubmission({
  draft,
  blocked,
  parallelWorkers,
  onReferenceUploaded,
}: {
  draft: Draft;
  blocked: boolean;
  parallelWorkers: number | undefined;
  onReferenceUploaded: (localId: string, image: ReferenceImage) => void;
}) {
  const [validationError, setError] = useState("");
  const [uploads, setUploads] = useState(0);
  const pendingUploads = useRef(0);
  const uploading = uploads > 0;
  const uploadController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => uploadController.current?.abort(), []);
  const navigate = useNavigate();
  const inference = useInferenceMutation<{
    id: string;
    startOutcome: "started" | "not_started" | "unknown";
  }>(async (grid) => {
    await queryClient.invalidateQueries({ queryKey: ["grids"] });
    clearDraft();
    await navigate({ to: "/grid/$id", params: { id: grid.id } });
  });
  const busy = inference.isPending;

  function onUploading(busy: boolean) {
    pendingUploads.current += busy ? 1 : -1;
    setUploads(pendingUploads.current);
  }
  function reset() {
    setError("");
    inference.reset();
  }
  async function generate(continueWithLowBalance = false) {
    if (blocked || pendingUploads.current || busy || uploadController.current)
      return;
    const { parsed } = validateDraftInput({
      ...draft.input,
      parallelWorkers,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError("");
    const controller = new AbortController();
    uploadController.current = controller;
    onUploading(true);
    try {
      const prepared = await uploadReferences(
        parsed.data,
        (localId, image) => {
          onReferenceUploaded(localId, image);
          void removeReferenceFile(localId).catch(() => {});
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        inference.mutate({
          path: "/grids",
          body: creationSubmission({
            ...prepared,
            parallelWorkers,
            sourceGridId: draft.sourceGridId,
            reuseArtifacts: draft.reuseArtifacts !== false,
          }),
          continueWithLowBalance,
        });
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      uploadController.current = undefined;
      onUploading(false);
    }
  }

  return {
    generate,
    reset,
    onUploading,
    uploading,
    busy,
    error: validationError || inference.message,
    lowBalance: inference.lowBalance,
    setLowBalance: inference.setLowBalance,
  };
}
