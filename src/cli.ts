import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import os from "node:os";

import fsp from "node:fs/promises";
import { execa } from "execa";
import { exiftool } from "exiftool-vendored";

function logf(message: string, ...args: unknown[]) {
  const formatted = `[photo-mcp-node] ${message}`;
  if (args.length) {
    let i = 0;
    const out = formatted.replace(/%[sdjf]/g, () => String(args[i++])) + "\n";
    process.stderr.write(out);
  } else {
    process.stderr.write(formatted + "\n");
  }
}

const DateRange = z.object({ from: z.string().optional(), to: z.string().optional() }).strict();
const TimeOfDay = z.object({ from: z.string(), to: z.string() }).partial().strict();
const IsoRange = z.object({ min: z.number().optional(), max: z.number().optional() }).strict();
const AltRange = z.object({ min: z.number().optional(), max: z.number().optional() }).strict();
const CameraModel = z.object({ make: z.string().optional(), model: z.string().optional() }).strict();
const Location = z.object({
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), // [minLon, minLat, maxLon, maxLat]
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  radius_m: z.number().positive().optional(),
}).strict();

const FilterAndCopyInput = z.object({
  base_dir: z.string().min(1).optional(),
  output_root: z.string().optional(),
  original_prompt: z.string(),
  copy_mode: z.literal("copy").optional(),
  date_range: DateRange.optional(),
  time_of_day: TimeOfDay.optional(),
  iso: IsoRange.optional(),
  artist: z.string().optional(),
  camera: CameraModel.optional(),
  location: Location.optional(),
  altitude: AltRange.optional(),
}).strict();

type FilterAndCopyInputT = z.infer<typeof FilterAndCopyInput>;

const MatchReport = z.object({
  scanned: z.number(),
  matched: z.number(),
  skipped_missing_meta: z.number(),
  output_dir: z.string(),
  files: z.array(z.string()),
});

type MatchReportT = z.infer<typeof MatchReport>;

type ExifData = {
  SourceFile: string;
  DateTimeOriginal: string;
  ISO?: number;
  Artist?: string;
  "By-line"?: string;
  Creator?: string;
  Make?: string;
  Model?: string;
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;
  GPSAltitudeRef?: number; // 0 above, 1 below sea level
};

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function todayKST(): string {
  try {
    // Use system local timezone; en-CA yields YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA").format(new Date());
  } catch {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

function parseExifDateTime(dto: string): { dateStr: string; hhmm: string } | null {
  // Expected formats: YYYY:MM:DD HH:MM:SS or YYYY:MM:DD HH:MM
  const m = dto.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  // Use recorded local components directly
  return { dateStr: `${y}-${mo}-${d}`, hhmm: `${hh}:${mm}` };
}

function promptSlug(s: string): string {
  let v = s.replace(/\s+/g, "-");
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    v = v.split(ch).join("-");
  }
  v = v.replace(/--+/g, "-");
  return v;
}

function inDateRange(dateStr: string, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

function inTimeWindow(hhmm: string, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (from && hhmm < from) return false;
  if (to && hhmm > to) return false;
  return true;
}

function firstNonEmpty(...vals: Array<string | undefined>): string {
  for (const v of vals) {
    if (v && v.trim() !== "") return v;
  }
  return "";
}

function norm(v?: string): string {
  return (v ?? "").trim().toLowerCase();
}

function expandTilde(p?: string): string {
  const v = (p ?? "").trim();
  if (v === "") return "";
  if (v === "~") return os.homedir();
  if (v.startsWith("~/")) return path.join(os.homedir(), v.slice(2));
  return v;
}

async function copyOne(src: string, dst: string): Promise<void> {
  await fsp.copyFile(src, dst);
}

async function resolveExiftoolPath(): Promise<string | undefined> {
  if (process.env.EXIFTOOL_PATH && process.env.EXIFTOOL_PATH.trim() !== "") {
    return process.env.EXIFTOOL_PATH;
  }
  try {
    // Use vendored binary path
    return await exiftool.exiftoolPath();
  } catch {
    return undefined;
  }
}

async function exiftoolIndex(baseDir: string): Promise<ExifData[]> {
  const args = [
    "-json", "-n", "-r",
    "-q", "-q",
    "-m",
    "-charset", "System=UTF8",
    "-charset", "filename=UTF8",
    "-charset", "exif=UTF8",
    "-charset", "iptc=UTF8",
    baseDir,
  ];
  const env = {
    ...process.env,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PERL_UNICODE: "SDL",
  } as NodeJS.ProcessEnv;

  // Prefer EXIFTOOL_PATH, else vendored binary path, else PATH
  const binPath = await resolveExiftoolPath();
  logf("exiftool exec: %s %s", binPath ?? "PATH:exiftool", args.join(" "));
  try {
    const res = await execa(binPath ?? "exiftool", args, { env });
    const stdout = res.stdout;
    const trimmed = stdout.replace(/^\s*[\uFEFF\s]*/, "");
    if (!trimmed || !(trimmed.startsWith("[") || trimmed.startsWith("{"))) {
      throw new Error(`exiftool JSON parse failed: out(head): ${trimmed.slice(0, 200)}`);
    }
    const parsed = JSON.parse(trimmed) as ExifData[] | ExifData;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    logf("exiftool parsed items=%d", items.length);
    return items;
  } catch (err: any) {
    const stderr = err?.stderr ? String(err.stderr) : "";
    throw new Error(`exiftool error: ${err?.message || err} stderr: ${stderr}`);
  }
}

async function filterAndCopy(outRoot: string, input: FilterAndCopyInputT): Promise<MatchReportT> {
  if (!input.base_dir || input.base_dir.trim() === "") {
    throw new Error("base_dir required");
  }
  const outDir = path.join(outRoot, `${todayKST()}_${promptSlug(input.original_prompt)}`);
  await fsp.mkdir(outDir, { recursive: true, mode: 0o755 });
  logf("filter start base_dir=%s prompt=\"%s\" out_dir=%s", input.base_dir, input.original_prompt, outDir);

  const items = await exiftoolIndex(input.base_dir);
  logf("exif items=%d", items.length);

  let scanned = 0, matched = 0, skipped = 0;
  const files: string[] = [];

  for (const it of items) {
    scanned++;
    const dto = it.DateTimeOriginal;
    if (!dto) {
      skipped++;
      continue;
    }
    const parsed = parseExifDateTime(dto);
    if (!parsed) {
      logf("skip parse time: file=%s dto=\"%s\"", it.SourceFile, dto);
      skipped++;
      continue;
    }
    const { dateStr, hhmm } = parsed;

    const from = input.date_range?.from || "";
    const to = input.date_range?.to || "";
    if (!inDateRange(dateStr, from, to)) {
      logf("skip date range: file=%s date=%s from=%s to=%s", it.SourceFile, dateStr, from, to);
      continue;
    }
    if (input.time_of_day && !inTimeWindow(hhmm, input.time_of_day.from, input.time_of_day.to)) {
      logf("skip time window: file=%s time=%s", it.SourceFile, hhmm);
      continue;
    }

    if (input.iso) {
      if (typeof it.ISO === "number") {
        if (input.iso.min !== undefined && it.ISO < input.iso.min) {
          logf("skip iso min: file=%s iso=%d min=%d", it.SourceFile, it.ISO, input.iso.min);
          continue;
        }
        if (input.iso.max !== undefined && it.ISO > input.iso.max) {
          logf("skip iso max: file=%s iso=%d max=%d", it.SourceFile, it.ISO, input.iso.max);
          continue;
        }
      }
    }

    if (input.artist && input.artist.trim() !== "") {
      const a = norm(firstNonEmpty(it.Artist, it.Creator, it["By-line"]));
      const needle = norm(input.artist);
      if (a === "" || !a.includes(needle)) {
        logf("skip artist: file=%s artist=\"%s\" needle=\"%s\"", it.SourceFile, a, needle);
        continue;
      }
    }

    if (input.camera) {
      if (input.camera.make) {
        const mk = norm(input.camera.make);
        if (!norm(it.Make).includes(mk)) {
          logf("skip camera make: file=%s make=\"%s\" needle=\"%s\"", it.SourceFile, it.Make || "", mk);
          continue;
        }
      }
      if (input.camera.model) {
        const md = norm(input.camera.model);
        if (!norm(it.Model).includes(md)) {
          logf("skip camera model: file=%s model=\"%s\" needle=\"%s\"", it.SourceFile, it.Model || "", md);
          continue;
        }
      }
    }

    if (input.location) {
      const hasBbox = Array.isArray(input.location.bbox);
      const hasCenterRadius = !!(input.location.center && input.location.radius_m);
      if (hasBbox || hasCenterRadius) {
        if (typeof it.GPSLatitude !== "number" || typeof it.GPSLongitude !== "number") {
          logf("skip gps missing: file=%s", it.SourceFile);
          continue;
        }
        if (hasCenterRadius) {
          const { lat, lon } = input.location.center!;
          const dist = haversineMeters(lat, lon, it.GPSLatitude, it.GPSLongitude);
          if (dist > (input.location.radius_m as number)) {
            logf("skip gps outside radius: file=%s lon=%d lat=%d center=(%d,%d) r=%dm d=%.1fm", it.SourceFile, it.GPSLongitude, it.GPSLatitude, lon, lat, input.location.radius_m, dist);
            continue;
          }
        } else if (hasBbox) {
          const [minLon, minLat, maxLon, maxLat] = input.location.bbox!;
          if (!(it.GPSLongitude >= minLon && it.GPSLongitude <= maxLon && it.GPSLatitude >= minLat && it.GPSLatitude <= maxLat)) {
            logf("skip gps outside bbox: file=%s lon=%d lat=%d bbox=[%d %d %d %d]", it.SourceFile, it.GPSLongitude, it.GPSLatitude, minLon, minLat, maxLon, maxLat);
            continue;
          }
        }
      }
    }

    if (input.altitude && (input.altitude.min !== undefined || input.altitude.max !== undefined)) {
      if (typeof it.GPSAltitude !== "number") {
        logf("skip altitude missing: file=%s", it.SourceFile);
        continue;
      }
      let alt = it.GPSAltitude;
      if (typeof it.GPSAltitudeRef === "number" && it.GPSAltitudeRef === 1) {
        alt = -alt;
      }
      if (input.altitude.min !== undefined && alt < input.altitude.min) {
        logf("skip altitude min: file=%s alt=%d min=%d", it.SourceFile, alt, input.altitude.min);
        continue;
      }
      if (input.altitude.max !== undefined && alt > input.altitude.max) {
        logf("skip altitude max: file=%s alt=%d max=%d", it.SourceFile, alt, input.altitude.max);
        continue;
      }
    }

    const src = it.SourceFile;
    if (!src) {
      logf("skip empty src: item has no SourceFile");
      continue;
    }
    try {
      await fsp.stat(src);
    } catch {
      logf("skip stat error: file=%s", src);
      continue;
    }
    const dst = path.join(outDir, path.basename(src));
    await copyOne(src, dst);
    files.push(dst);
    matched++;
  }

  logf("filter done scanned=%d matched=%d skipped=%d", scanned, matched, skipped);
  return { scanned, matched, skipped_missing_meta: skipped, output_dir: outDir, files };
}

async function main() {
  const defaultPicturesDir = path.join(os.homedir(), "Pictures");
  const baseDirEnv = expandTilde(process.env.PHOTO_MCP_BASE_DIR);
  const baseDirFlag = baseDirEnv || defaultPicturesDir;
  logf("server start base_dir=%s", baseDirFlag);

  const mcpServer = new McpServer({ name: "photo-mcp-node", version: "1.0.0" });

  mcpServer.registerTool(
    "filter_and_copy",
    {
      description: "Filter photos by EXIF and copy them into a dated prompt folder",
      inputSchema: {
        base_dir: z.string().min(1).optional().describe("Base directory for photos"),
        output_root: z.string().optional().describe("Root folder to place output directory"),
        original_prompt: z.string().describe("Prompt text for output folder naming"),
        copy_mode: z.literal("copy").optional().describe("Copy only; hard links are not supported"),
        date_range: DateRange.optional(),
        time_of_day: TimeOfDay.optional(),
        iso: IsoRange.optional(),
        artist: z.string().optional(),
        camera: CameraModel.optional(),
        location: Location.optional(),
        altitude: AltRange.optional(),
      },
      outputSchema: {
        scanned: z.number(),
        matched: z.number(),
        skipped_missing_meta: z.number(),
        output_dir: z.string(),
        files: z.array(z.string()),
      },
    },
    async (args: FilterAndCopyInputT) => {
      const parsed = FilterAndCopyInput.parse(args);
      let baseDir = expandTilde(parsed.base_dir) || baseDirFlag;
      if (!baseDir) {
        return { isError: true, content: [{ type: "text", text: "error: base_dir required" }] };
      }
      let outRoot = expandTilde(parsed.output_root) || path.join(os.homedir(), "Desktop");
      if (!outRoot) outRoot = baseDir;
      try {
        const rep = await filterAndCopy(outRoot, { ...parsed, base_dir: baseDir });
        return {
          content: [{ type: "text", text: `scanned=${rep.scanned} matched=${rep.matched} skipped=${rep.skipped_missing_meta} output_dir=${rep.output_dir}` }],
          structuredContent: rep,
        };
      } catch (err: any) {
        logf("tool error: %s", err?.message || String(err));
        return { isError: true, content: [{ type: "text", text: `error: ${err?.message || err}` }] };
      }
    }
  );

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`server error: ${String(err?.stack || err)}\n`);
  process.exit(1);
});


