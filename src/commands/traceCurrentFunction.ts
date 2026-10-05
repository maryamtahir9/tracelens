import { TraceService } from '../services/TraceService';
import { traceFromEditor } from './traceExecution';

export function traceCurrentFunction(service: TraceService): Promise<void> {
  return traceFromEditor(service, { currentFunctionOnly: true });
}
