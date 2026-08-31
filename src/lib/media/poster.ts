import { runFfmpeg } from "@/lib/ffmpeg";

export async function extractPoster(videoPath: string, posterPath: string) {
  await runFfmpeg([
    "-y",
    "-ss",
    "0.1",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "4",
    posterPath,
  ]);
}
