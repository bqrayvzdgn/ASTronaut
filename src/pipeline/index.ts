import { analysisQueue } from "../queue/analysisQueue";
import { processAnalysis } from "./processAnalysis";

export function initializePipeline(): void {
  analysisQueue.setProcessor(processAnalysis);
}
