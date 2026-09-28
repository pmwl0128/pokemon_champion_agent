import { evaluateInference, type InferenceJob } from "./evaluate.ts";

self.onmessage = (event: MessageEvent<InferenceJob>) => {
  try { self.postMessage({ value: evaluateInference(event.data) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
