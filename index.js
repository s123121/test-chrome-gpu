import { chromium } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import mime from "mime-types";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration from environment variables
const CONFIG = {
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET: process.env.R2_BUCKET,
  R2_CDN_URL: process.env.R2_CDN_URL,
  MAPBOX_API_KEY: process.env.MAPBOX_API_KEY,
  CHROME_GL_MODE: process.env.CHROME_GL_MODE || "swiftshader",
};

// Initialize S3 client for R2
const s3Client = new S3Client({
  region: "auto",
  endpoint: CONFIG.R2_ENDPOINT,
  credentials: {
    accessKeyId: CONFIG.R2_ACCESS_KEY_ID,
    secretAccessKey: CONFIG.R2_SECRET_ACCESS_KEY,
  },
});

// Runpod handler function
export default async function handler(job) {
  const startTime = Date.now();
  console.log(
    `[Worker] Starting video rendering job:`,
    JSON.stringify(job.input, null, 2)
  );

  const { jobId, animationCode, dimensions, usesMapbox, webhookUrl } =
    job.input;

  if (!jobId || !animationCode || !dimensions || !webhookUrl) {
    const error =
      "Missing required parameters: jobId, animationCode, dimensions, webhookUrl";
    console.error(`[Worker] ${error}`);
    await notifyWebhook(webhookUrl, { status: "FAILED", error });
    throw new Error(error);
  }

  try {
    // 1. Create temp directory for rendering
    const tempDir = `/tmp/job-${jobId}-${Date.now()}`;
    await fs.mkdir(tempDir, { recursive: true });
    console.log(`[Worker] Created temp directory: ${tempDir}`);

    // 2. Create HTML page with animation code
    const htmlPath = path.join(tempDir, "animation.html");
    const htmlContent = createAnimationPage(animationCode);
    await fs.writeFile(htmlPath, htmlContent, "utf8");
    console.log(`[Worker] Created HTML file: ${htmlPath}`);

    // 3. Initialize browser and render video to disk
    const mp4Path = path.join(tempDir, "recording.mp4");
    const minDuration = Math.max(
      estimateDuration(animationCode.htmlContent),
      15
    );
    console.log(`[Worker] Video duration: ${minDuration}`);
    await recordAnimationWithScreencast(
      htmlPath,
      mp4Path,
      dimensions,
      minDuration,
      usesMapbox
    );
    console.log(`[Worker] Video recorded: ${mp4Path}`);

    // 4. Upload video file directly to R2
    const videoUrl = await uploadVideoFileToR2(mp4Path, jobId);
    console.log(`[Worker] Video uploaded: ${videoUrl}`);

    // 5. Clean up temp files
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(`[Worker] Cleaned up temp directory`);

    // 6. Notify DBOS workflow via webhook
    const result = {
      status: "COMPLETED",
      output: { videoUrl },
    };

    await notifyWebhook(webhookUrl, result);

    const totalTime = Date.now() - startTime;
    console.log(
      `[Worker] Job ${jobId} completed successfully in ${totalTime}ms`
    );
    return result;
  } catch (error) {
    console.error(`[Worker] Video rendering failed for job ${jobId}:`, error);

    // Clean up on error
    try {
      await fs.rm(`/tmp/job-${jobId}-${Date.now()}`, {
        recursive: true,
        force: true,
      });
    } catch (cleanupError) {
      console.warn(`[Worker] Cleanup warning:`, cleanupError);
    }

    // Notify DBOS workflow of failure via webhook
    const result = {
      status: "FAILED",
      error: error.message || "Unknown error during video rendering",
    };

    try {
      await notifyWebhook(webhookUrl, result);
    } catch (webhookError) {
      console.error(`[Worker] Failed to notify webhook:`, webhookError);
    }

    throw error;
  }
}

// Browser rendering functions
async function recordAnimationWithScreencast(
  htmlPath,
  outputPath,
  dimensions,
  duration,
  usesMapbox = false
) {
  console.log(
    `[Worker] Starting browser recording for ${duration}s at ${dimensions.width}x${dimensions.height}`
  );

  // 1. Launch browser with appropriate flags
  const baseArgs = [
    "--disable-setuid-sandbox",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--no-first-run",
    "--no-zygote",
    "--mute-audio",
    "--enable-unsafe-swiftshader",
    "--force-device-scale-factor=2",
    "--high-dpi-support=1",
    "--font-render-hinting=full",
    "--enable-font-antialiasing",
    "--disable-lcd-text",
    "--enable-accelerated-2d-canvas",
    "--enable-zero-copy",
    "--disable-web-security",
    "--allow-running-insecure-content",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-media-suspend",
    "--disable-backgrounding-occluded-windows",
  ];

  if (usesMapbox) {
    baseArgs.push(
      "--headless=new",
      "--enable-webgl",
      "--enable-webgl2-compute-context",
      `--use-gl=${CONFIG.CHROME_GL_MODE}`,
      "--use-angle=gl-egl",
      "--ignore-gpu-blocklist",
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync"
    );
  } else {
    baseArgs.push(
      `--use-gl=${CONFIG.CHROME_GL_MODE}`,
      "--use-angle=gl-egl",
      "--enable-webgl-software-rendering",
      "--memory-pressure-off",
      "--disable-frame-rate-limit"
    );
  }

  const browser = await chromium.launch({
    headless: true,
    args: baseArgs,
  });

  try {
    // 2. Create context and page
    const context = await browser.newContext({
      viewport: dimensions,
      deviceScaleFactor: 2,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      permissions: ["camera", "microphone"],
      reducedMotion: "no-preference",
      colorScheme: "no-preference",
      forcedColors: "none",
    });

    const page = await context.newPage();

    // Add essential scripts and error handling
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      console.log(`[Browser Console ${type}]:`, text);
    });

    page.on("pageerror", (error) => {
      console.error(`[Page Error]:`, error.message);
    });

    await page.addInitScript(() => {
      // Optimize for high-quality rendering
      Object.defineProperty(globalThis, "scrollBehavior", {
        value: "auto",
        writable: false,
      });

      globalThis.document.addEventListener("DOMContentLoaded", () => {
        const style = globalThis.document.createElement("style");
        style.textContent = `
          * {
            -webkit-backface-visibility: hidden;
            backface-visibility: hidden;
            image-rendering: auto;
            text-rendering: optimizeLegibility;
            animation-fill-mode: both;
          }
          body {
            will-change: transform, opacity;
            margin: 0;
            padding: 0;
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            image-rendering: optimizeQuality;
            text-rendering: optimizeLegibility;
          }
          .mapboxgl-canvas {
            image-rendering: auto !important;
            image-rendering: optimizeQuality !important;
          }
        `;
        globalThis.document.head.appendChild(style);
      });
    });

    // 3. Set up CDP screencast for frame capture
    const screenshotsDir = path.join(path.dirname(outputPath), "frames");
    await fs.mkdir(screenshotsDir, { recursive: true });

    const cdp = await page.context().newCDPSession(page);
    let frameCount = 0;
    let recordingFinished = false;

    // Set up completion detection
    let stopRecordingPromiseResolver;
    const stopRecordingPromise = new Promise((resolve) => {
      stopRecordingPromiseResolver = resolve;
    });

    await page.exposeFunction("onComplete", async () => {
      console.log(`[Worker] Animation completion signal received`);
      stopRecordingPromiseResolver();
    });

    cdp.on("Page.screencastFrame", async ({ data, sessionId }) => {
      if (recordingFinished) return;

      try {
        const paddedFrameNumber = frameCount.toString().padStart(6, "0");
        const screenshotPath = path.join(
          screenshotsDir,
          `frame_${paddedFrameNumber}.jpg`
        );
        await fs.writeFile(screenshotPath, Buffer.from(data, "base64"));
        frameCount++;
        await cdp.send("Page.screencastFrameAck", { sessionId });
      } catch (error) {
        console.error(`[Worker] Error saving frame ${frameCount}:`, error);
        await cdp
          .send("Page.screencastFrameAck", { sessionId })
          .catch(() => {});
      }
    });

    // 4. Start recording and wait for completion
    await page.goto(`file://${htmlPath}`);

    // Wait for GSAP to load
    await page.waitForFunction(() => typeof globalThis.gsap !== "undefined", {
      timeout: 10000,
    });

    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      everyNthFrame: 1,
      maxWidth: dimensions.width,
      maxHeight: dimensions.height,
    });

    console.log(`[Worker] Started screencast recording`);

    // Wait for animation completion or timeout
    const maxDurationMs = duration * 2000;
    await Promise.race([
      stopRecordingPromise,
      new Promise((resolve) => setTimeout(resolve, maxDurationMs)),
    ]);

    recordingFinished = true;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});

    console.log(`[Worker] Captured ${frameCount} frames`);

    await browser.close();

    // 5. Stitch frames to video using FFmpeg
    if (frameCount > 0) {
      const actualDuration = Math.min(duration, maxDurationMs / 1000);
      const fps = Math.max(frameCount / actualDuration, 1);
      await stitchFramesToVideo(screenshotsDir, outputPath, Math.round(fps));
    } else {
      throw new Error("No frames were captured during recording");
    }

    // 6. Clean up frame files
    await fs.rm(screenshotsDir, { recursive: true, force: true });
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function stitchFramesToVideo(screenshotsDir, outputPath, frameRate) {
  return new Promise((resolve, reject) => {
    console.log(
      `[Worker] Stitching frames to video at ${frameRate}fps: ${screenshotsDir} -> ${outputPath}`
    );

    const ffmpeg = spawn("ffmpeg", [
      "-framerate",
      frameRate.toString(),
      "-i",
      path.join(screenshotsDir, "frame_%06d.jpg"),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      outputPath,
    ]);

    let stderrOutput = "";
    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      stderrOutput += output;
      console.log(`[FFmpeg] ${output}`);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log(`[Worker] Successfully stitched video at ${frameRate}fps`);
        resolve();
      } else {
        reject(
          new Error(`FFmpeg failed with code ${code}. Output: ${stderrOutput}`)
        );
      }
    });

    ffmpeg.on("error", (error) => {
      reject(new Error(`FFmpeg error: ${error.message}`));
    });
  });
}

function createAnimationPage(animationCode) {
  let htmlContent = animationCode.htmlContent;

  // Replace Mapbox API key with environment variable
  if (htmlContent.includes("mapboxgl.accessToken")) {
    htmlContent = htmlContent.replace(
      /mapboxgl\.accessToken\s*=\s*[^;]+;?/g,
      `mapboxgl.accessToken = '${CONFIG.MAPBOX_API_KEY}';`
    );
  } else if (CONFIG.MAPBOX_API_KEY) {
    // Add API key if not present
    htmlContent = htmlContent.replace(
      "<body>",
      `<body><script>mapboxgl.accessToken = '${CONFIG.MAPBOX_API_KEY}';</script>`
    );
  }

  return htmlContent.trim();
}

async function uploadVideoFileToR2(filePath, jobId) {
  const fileName = `videos/${jobId}/${Date.now()}.mp4`;
  const fileContent = await fs.readFile(filePath);

  console.log(`[Worker] Uploading video to R2: ${fileName}`);

  const command = new PutObjectCommand({
    Bucket: CONFIG.R2_BUCKET,
    Key: fileName,
    Body: fileContent,
    ContentType: "video/mp4",
    CacheControl: "max-age=31536000",
    ACL: "public-read",
    Metadata: {
      "Content-Disposition": "inline",
    },
  });

  await s3Client.send(command);
  const videoUrl = `${CONFIG.R2_CDN_URL}/${fileName}`;

  console.log(`[Worker] Video uploaded successfully: ${videoUrl}`);
  return videoUrl;
}

async function notifyWebhook(webhookUrl, result) {
  console.log(`[Worker] Notifying webhook: ${webhookUrl}`);

  try {
    const response = await axios.post(webhookUrl, result, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000, // 10 second timeout
    });

    console.log(`[Worker] Webhook notification successful: ${response.status}`);
  } catch (error) {
    console.error(`[Worker] Webhook notification failed:`, error.message);
    throw error;
  }
}

function estimateDuration(gsapCode) {
  // Try to extract duration from GSAP timeline
  const durationMatch = gsapCode.match(/duration[:\s]*(\d+(?:\.\d+)?)/i);
  if (durationMatch) {
    return parseFloat(durationMatch[1]);
  }

  // Look for timeline with explicit duration
  const timelineMatch = gsapCode.match(
    /timeline\.to\([^,]+,\s*\{[^}]*duration[:\s]*(\d+(?:\.\d+)?)/i
  );
  if (timelineMatch) {
    return parseFloat(timelineMatch[1]);
  }

  // Look for repeat duration
  const repeatMatch = gsapCode.match(
    /repeat[:\s]*-1[^}]*duration[:\s]*(\d+(?:\.\d+)?)/i
  );
  if (repeatMatch) {
    return parseFloat(repeatMatch[1]);
  }

  // Default estimation based on code complexity
  const codeLength = gsapCode.length;
  if (codeLength < 1000) return 5;
  if (codeLength < 2000) return 8;
  if (codeLength < 3000) return 12;
  return 15;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post("/", async (req, res) => {
  try {
    console.log(
      "[Worker] Received request:",
      JSON.stringify(req.body, null, 2)
    );
    const result = await handler({ input: req.body });
    res.json(result);
  } catch (error) {
    console.error("[Worker] Error processing request:", error);
    res.status(500).json({
      status: "FAILED",
      error: error.message || "Unknown error during processing",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Worker] Server listening on port ${PORT}`);
});
