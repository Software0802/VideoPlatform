export interface MediaStore {
  writeJobFile(jobId: string, rel: string, bytes: Buffer | Uint8Array): Promise<string>;
  readJobFile(jobId: string, rel: string): Promise<Buffer>;
  statJobFile(jobId: string, rel: string): Promise<{ size: number }>;
  openJobFile(jobId: string, rel: string): Promise<NodeJS.ReadableStream>;
  publicPath(jobId: string, file: "video.mp4" | "poster.jpg" | "image.jpg"): string;
  listJobs(): Promise<string[]>;
  jobDir(jobId: string): string;
}
