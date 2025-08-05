import puppeteer from "puppeteer";
import express from "express";
import fs from "fs";
import path from "path";

// Configuration
const SCREENSHOT_FILE = "./chrome-gpu-screenshot_container.png";
const PORT = process.env.PORT || 8080;

async function autoScrollPage(page) {
  await page.evaluate(async () => {
    return new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const delay = 100;

      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          setTimeout(resolve, 500);
        }
      }, delay);
    });
  });
}

/**
 * Takes a screenshot of chrome://gpu using Puppeteer with auto-downloaded Chrome
 */
async function screenshotGpuPage(outputPath = SCREENSHOT_FILE) {
  let browser = null;

  try {
    console.log("Launching Chrome with Puppeteer (auto-download if needed)...");

    // Launch browser - Use system Chromium in container
    browser = await puppeteer.launch({
      headless: true, // Set to false if you want to see the browser
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-extensions",
        "--disable-sync",
        "--disable-translate",
        "--no-first-run",
        // '--no-zygote',
        "--mute-audio",
        // '--enable-unsafe-swiftshader',
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
        "--enable-gpu",
        "--use-gl=angle",
        "--use-angle=gl-egl",
        "--headless=new",
        "--enable-webgl",
        "--enable-webgl2-compute-context",
        "--ignore-gpu-blocklist",
        "--disable-frame-rate-limit",
        "--disable-gpu-vsync",
        // '--disable-accelerated-2d-canvas=false',
        // '--disable-accelerated-video-decode=false',
        "--enable-accelerated-2d-canvas",
        "--enable-accelerated-video-decode",
        "--disable-software-rasterizer",
      ],
    });

    console.log("Chrome launched successfully");
    console.log("Opening new page...");

    const page = await browser.newPage();

    // Set viewport size for consistent screenshots
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
    });

    console.log("Navigating to chrome://gpu...");

    // Navigate to chrome://gpu
    await page.goto("https://webglreport.com/?v=2", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    await autoScrollPage(page);

    // Scroll back to top for consistent screenshot
    await page.evaluate(() => window.scrollTo(0, 0));

    console.log("Page loaded, taking screenshot...");

    // Take full-page screenshot
    await page.screenshot({
      path: outputPath,
      fullPage: true,
      type: "png",
    });

    console.log(`Screenshot saved: ${outputPath}`);

    // Optional: Get page title
    const title = await page.title();
    console.log(`Page title: ${title}`);

    // Optional: Extract GPU information from the page
    try {
      const gpuInfo = await page.evaluate(() => {
        // Extract GPU feature status information
        const infoSections = [];

        // Look for feature status table
        const tables = document.querySelectorAll("table");
        tables.forEach((table) => {
          const caption = table.querySelector("caption");
          if (
            caption &&
            caption.textContent.includes("Graphics Feature Status")
          ) {
            const rows = table.querySelectorAll("tr");
            rows.forEach((row) => {
              const cells = row.querySelectorAll("td, th");
              if (cells.length >= 2) {
                infoSections.push(
                  `${cells[0].textContent.trim()}: ${cells[1].textContent.trim()}`
                );
              }
            });
          }
        });

        // Also look for basic GPU info
        const basicInfo = [];
        const divs = document.querySelectorAll("div");
        divs.forEach((div) => {
          const text = div.textContent;
          if (
            text.includes("GPU0") ||
            text.includes("VENDOR") ||
            text.includes("DEVICE")
          ) {
            basicInfo.push(text.trim());
          }
        });

        return {
          featureStatus: infoSections.slice(0, 5), // First 5 features
          basicInfo: basicInfo.slice(0, 3), // First 3 basic info items
        };
      });

      if (gpuInfo.featureStatus.length > 0) {
        console.log("\nGPU Feature Status (first 5):");
        gpuInfo.featureStatus.forEach((feature) => console.log(`  ${feature}`));
      }

      if (gpuInfo.basicInfo.length > 0) {
        console.log("\nBasic GPU Info:");
        gpuInfo.basicInfo.forEach((info) => console.log(`  ${info}`));
      }
    } catch (e) {
      console.log(
        "Could not extract detailed GPU info, but screenshot was taken successfully"
      );
    }

    return outputPath;
  } catch (error) {
    throw new Error(`Failed to take screenshot: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed");
    }
  }
}

/**
 * Express server setup
 */
const app = express();

// Middleware
app.use(express.static("public"));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Main screenshot endpoint
app.get("/screenshot", async (req, res) => {
  try {
    console.log("📷 Screenshot request received");

    // Take the screenshot
    const screenshotPath = await screenshotGpuPage();

    // Check if file exists
    if (!fs.existsSync(screenshotPath)) {
      return res.status(500).json({ error: "Screenshot file not found" });
    }

    // Send the screenshot file
    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="gpu-screenshot.png"'
    );

    const fileStream = fs.createReadStream(screenshotPath);
    fileStream.pipe(res);

    console.log("✅ Screenshot served successfully");
  } catch (error) {
    console.error("❌ Screenshot error:", error.message);
    res.status(500).json({
      error: "Failed to take screenshot",
      message: error.message,
    });
  }
});

// Endpoint to get screenshot info without serving the image
app.get("/screenshot-info", async (req, res) => {
  try {
    const screenshotPath = await screenshotGpuPage();

    if (!fs.existsSync(screenshotPath)) {
      return res.status(500).json({ error: "Screenshot file not found" });
    }

    const stats = fs.statSync(screenshotPath);

    res.json({
      success: true,
      file: path.basename(screenshotPath),
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      downloadUrl: "/screenshot",
    });
  } catch (error) {
    console.error("❌ Screenshot info error:", error.message);
    res.status(500).json({
      error: "Failed to get screenshot info",
      message: error.message,
    });
  }
});

// Root endpoint with usage info
app.get("/", (req, res) => {
  res.json({
    message: "GPU Screenshot Service",
    endpoints: {
      "/": "This help message",
      "/health": "Health check",
      "/screenshot": "Take and download GPU screenshot (PNG)",
      "/screenshot-info": "Get screenshot metadata",
    },
    usage:
      "Visit /screenshot to capture and download a WebGL report screenshot",
  });
});

/**
 * Start the server
 */
function startServer() {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 GPU Screenshot Service running on port ${PORT}`);
    console.log(`📋 API endpoints available:`);
    console.log(`   • GET /health - Health check`);
    console.log(`   • GET /screenshot - Take and download screenshot`);
    console.log(`   • GET /screenshot-info - Get screenshot metadata`);
    console.log(`   • GET / - Usage information`);
  });
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Process interrupted");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Process terminated");
  process.exit(0);
});

startServer();
