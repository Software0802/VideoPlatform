export interface HarnessOrchestrator {
  execute(jobId: string): Promise<never>;
}

export const harnessOrchestrator: HarnessOrchestrator = {
  async execute(jobId: string): Promise<never> {
    void jobId;
    throw new Error("HARNESS_NOT_ENABLED");
  },
};
