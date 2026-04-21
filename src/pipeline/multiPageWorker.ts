import { parentPort, workerData } from 'node:worker_threads';
import {
  runPipeline,
  runPipelineWithVerification,
  type PipelineOptions,
} from './d2cPipeline';

interface SerializedWorkerError {
  name?: string;
  message: string;
  stack?: string;
}

interface WorkerTaskData {
  pageRaw: unknown;
  opts: PipelineOptions;
  verify: boolean;
}

function serializeError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: typeof error === 'string' ? error : JSON.stringify(error),
  };
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('Multi-page worker requires a parent port');
  }

  const { pageRaw, opts, verify } = workerData as WorkerTaskData;

  try {
    const result = verify
      ? await runPipelineWithVerification(pageRaw, opts)
      : await runPipeline(pageRaw, opts);
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: serializeError(error) });
  }
}

void main();