import { probeDurationSec, runFfmpegCapture } from "@/lib/ffmpeg";

/**
 * Technical QC for one harness clip (design.md §7.2 QC ①②):
 * duration within ±0.4s of the shot plan, no black segment, no frozen segment.
 * Visual consistency scoring lives in visual-qc.ts.
 */

export const QC_DURATION_TOLERANCE_SEC = 0.4;
export const QC_BLACK_MIN_SEC = 0.5;
export const QC_FREEZE_MIN_SEC = 2;

export type QcSegment = { start: number; end: number; duration: number };

export type ShotQcReport = {
  durationSec: number;
  durationOk: boolean;
  blackFrameFree: boolean;
  freezeFree: boolean;
  blackSegments: QcSegment[];
  freezeSegments: QcSegment[];
  visualScore?: number;
};

export type ShotQcOptions = {
  expectedDurationSec: number;
  toleranceSec?: number;
  blackMinSec?: number;
  freezeMinSec?: number;
};

export class ShotQcFailure extends Error {
  constructor(
    readonly code: "qc_duration" | "qc_black_frames" | "qc_frozen_frames" | "qc_visual",
    message: string,
    readonly report: ShotQcReport,
  ) {
    super(message);
    this.name = "ShotQcFailure";
  }
}

export function parseBlackdetect(stderr: string): QcSegment[] {
  const out: QcSegment[] = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g;
  for (const m of stderr.matchAll(re)) {
    out.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return out;
}

export function parseFreezedetect(stderr: string): QcSegment[] {
  const out: QcSegment[] = [];
  const starts = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const durations = [...stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  for (const [i, start] of starts.entries()) {
    const end = ends[i];
    const duration = durations[i] ?? (end != null ? end - start : Number.NaN);
    out.push({ start, end: end ?? start + (Number.isFinite(duration) ? duration : 0), duration });
  }
  return out;
}

export function evaluateShotQc(
  measured: { durationSec: number; blackSegments: QcSegment[]; freezeSegments: QcSegment[] },
  options: ShotQcOptions,
): ShotQcReport {
  const tolerance = options.toleranceSec ?? QC_DURATION_TOLERANCE_SEC;
  const blackMin = options.blackMinSec ?? QC_BLACK_MIN_SEC;
  const freezeMin = options.freezeMinSec ?? QC_FREEZE_MIN_SEC;
  const blackSegments = measured.blackSegments.filter((s) => s.duration >= blackMin);
  const freezeSegments = measured.freezeSegments.filter(
    (s) => !Number.isFinite(s.duration) || s.duration >= freezeMin,
  );
  return {
    durationSec: measured.durationSec,
    durationOk: Math.abs(measured.durationSec - options.expectedDurationSec) <= tolerance,
    blackFrameFree: blackSegments.length === 0,
    freezeFree: freezeSegments.length === 0,
    blackSegments,
    freezeSegments,
  };
}

export function assertShotQc(report: ShotQcReport, expectedDurationSec: number): void {
  if (!report.durationOk) {
    throw new ShotQcFailure(
      "qc_duration",
      `成片时长 ${report.durationSec.toFixed(2)}s 与计划 ${expectedDurationSec}s 偏差超过 ${QC_DURATION_TOLERANCE_SEC}s`,
      report,
    );
  }
  if (!report.blackFrameFree) {
    const s = report.blackSegments[0]!;
    throw new ShotQcFailure(
      "qc_black_frames",
      `检测到黑帧 ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`,
      report,
    );
  }
  if (!report.freezeFree) {
    const s = report.freezeSegments[0]!;
    throw new ShotQcFailure(
      "qc_frozen_frames",
      `检测到冻帧 ${s.start.toFixed(2)}s 起`,
      report,
    );
  }
}

/** Probe + blackdetect/freezedetect a clip. Throws ShotQcFailure when it does not pass. */
export async function runShotQc(clipPath: string, options: ShotQcOptions): Promise<ShotQcReport> {
  const probe = await probeDurationSec(clipPath);
  const blackMin = options.blackMinSec ?? QC_BLACK_MIN_SEC;
  const freezeMin = options.freezeMinSec ?? QC_FREEZE_MIN_SEC;
  const stderr = await runFfmpegCapture([
    "-hide_banner",
    "-i",
    clipPath,
    "-an",
    "-vf",
    `blackdetect=d=${blackMin}:pic_th=0.98,freezedetect=n=-60dB:d=${freezeMin}`,
    "-f",
    "null",
    "-",
  ]);
  const report = evaluateShotQc(
    {
      durationSec: probe.durationSec,
      blackSegments: parseBlackdetect(stderr),
      freezeSegments: parseFreezedetect(stderr),
    },
    options,
  );
  assertShotQc(report, options.expectedDurationSec);
  return report;
}
