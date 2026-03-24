const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const allowedOrigins = [
  "https://bauwens-vastgoed.webflow.io",
  "https://bauwensvastgoed.be",
  "https://www.bauwensvastgoed.be",
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  optionsSuccessStatus: 204,
};
const PORT = process.env.PORT || 3000;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TMP_DIR = path.join(__dirname, "tmp");
const UPLOADS_DIR = path.join(TMP_DIR, "uploads");
const PROCESSED_DIR = path.join(TMP_DIR, "processed");
const ZIPS_DIR = path.join(TMP_DIR, "zips");
const JOB_TTL = 60 * 60 * 1000;
const jobs = new Map();
const limit = pLimit(2);
const compressRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
});

sharp.concurrency(2);
sharp.cache(false);

function slugifySeoName(seoName) {
  return String(seoName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateBatchId() {
  return crypto.randomBytes(3).toString("base64url").slice(0, 4).toLowerCase();
}

function generateJobId() {
  return crypto.randomBytes(6).toString("base64url").toLowerCase();
}

function ensureDirectories() {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  fs.mkdirSync(ZIPS_DIR, { recursive: true });
}

async function writeAvifVariant(inputPath, outputPath, width, quality) {
  await sharp(inputPath)
    .resize({ width, withoutEnlargement: true })
    .avif({
      quality,
      effort: 3,
    })
    .toFile(outputPath);

  const stats = await fs.promises.stat(outputPath);

  return stats.size;
}

async function compressImageToFile(inputPath, outputPath) {
  const maxSizeBytes = 250 * 1024;
  const candidates = [
    { width: 1800, quality: 55 },
    { width: 1800, quality: 48 },
    { width: 1600, quality: 48 },
  ];
  const tempPaths = [];
  let chosenPath = null;
  let chosenSize = Infinity;

  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const tempPath = `${outputPath}.tmp-${index}`;
      const size = await writeAvifVariant(
        inputPath,
        tempPath,
        candidate.width,
        candidate.quality
      );

      tempPaths.push(tempPath);

      if (size < chosenSize) {
        chosenPath = tempPath;
        chosenSize = size;
      }

      if (size <= maxSizeBytes) {
        chosenPath = tempPath;
        chosenSize = size;
        break;
      }
    }

    await fs.promises.rename(chosenPath, outputPath);
  } finally {
    for (const tempPath of tempPaths) {
      if (tempPath !== chosenPath) {
        safeUnlink(tempPath);
      }
    }
  }
}

async function createZipFromFiles(filePaths, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 1 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const filePath of filePaths) {
      archive.file(filePath, { name: path.basename(filePath) });
    }

    archive.finalize().catch(reject);
  });
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Cleanup error:", error);
  }
}

function cleanupFolder(folderPath) {
  try {
    const files = fs.readdirSync(folderPath);

    files.forEach((file) => {
      const filePath = path.join(folderPath, file);

      try {
        const stats = fs.statSync(filePath);

        if (Date.now() - stats.mtimeMs > JOB_TTL) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        console.error("Folder cleanup error:", error);
      }
    });
  } catch (error) {
    console.error("Folder cleanup error:", error);
  }
}

function cleanupOldJobs() {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL) {
      if (job.zipPath) {
        safeUnlink(job.zipPath);
      }

      jobs.delete(jobId);
    }
  }

  cleanupFolder(UPLOADS_DIR);
  cleanupFolder(PROCESSED_DIR);
}

ensureDirectories();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(
      file.originalname
    )}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
});

async function processJob(jobId, files, seoName) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const slug = slugifySeoName(seoName) || "image";
  const processedPaths = new Array(files.length);
  const originalPaths = files.map((file) => file.path);

  try {
    const results = await Promise.allSettled(
      files.map((file, index) =>
        limit(async () => {
          const outputPath = path.join(
            PROCESSED_DIR,
            `${slug}-${job.batchId}-${index + 1}.avif`
          );

          await compressImageToFile(file.path, outputPath);
          processedPaths[index] = outputPath;
          job.progress.completed += 1;
          job.completedFiles = job.progress.completed;
          safeUnlink(file.path);
        })
      )
    );

    const failedResult = results.find((result) => result.status === "rejected");

    if (failedResult) {
      throw failedResult.reason;
    }

    const zipFilename = `${slug}-${job.batchId}-compressed.zip`;
    const zipPath = path.join(ZIPS_DIR, zipFilename);

    await createZipFromFiles(processedPaths, zipPath);

    for (const processedPath of processedPaths) {
      safeUnlink(processedPath);
    }

    job.zipPath = zipPath;
    job.zipFilename = zipFilename;
    job.status = "done";
  } catch (error) {
    console.error("Job error:", error);
    job.status = "failed";
    job.error = error.message || "Job processing failed";

    for (const filePath of [...originalPaths, ...processedPaths]) {
      try {
        safeUnlink(filePath);
      } catch (unlinkError) {
        console.error("Failed to remove temp file:", unlinkError);
      }
    }
  }
}

setInterval(cleanupOldJobs, 10 * 60 * 1000);

app.use(cors(corsOptions));

app.get("/", (req, res) => {
  res.send("API werkt");
});

app.post("/compress", compressRateLimit, upload.array("images", 50), async (req, res, next) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const ua = req.headers["user-agent"];
    const files = req.files || [];
    const seoName = req.body.seoName;

    console.log(`New job from IP: ${ip} | UA: ${ua} | files: ${files.length}`);

    if (!seoName || !String(seoName).trim()) {
      for (const file of files) {
        safeUnlink(file.path);
      }

      return res.status(400).json({ error: "seoName is required" });
    }

    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const invalidFile = files.find((file) => !ALLOWED_MIME_TYPES.has(file.mimetype));

    if (invalidFile) {
      for (const file of files) {
        safeUnlink(file.path);
      }

      return res.status(400).json({ error: "Only JPEG, PNG, and WEBP files are allowed" });
    }

    const jobId = generateJobId();
    const batchId = generateBatchId();

    jobs.set(jobId, {
      jobId,
      status: "processing",
      seoName,
      batchId,
      createdAt: Date.now(),
      progress: {
        completed: 0,
        total: files.length,
      },
      totalFiles: files.length,
      completedFiles: 0,
      zipPath: null,
      zipFilename: null,
      error: null,
    });

    res.json({
      jobId,
      status: "processing",
    });

    setImmediate(() => {
      processJob(jobId, files, seoName).catch((error) => {
        console.error("Job error:", error);
        const job = jobs.get(jobId);

        if (job) {
          job.status = "failed";
          job.error = error.message || "Job processing failed";
        }
      });
    });
  } catch (error) {
    next(error);
  }
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    progress: {
      completed: job.progress.completed,
      total: job.progress.total,
    },
    downloadUrl: job.status === "done" ? `/download/${job.jobId}` : null,
    error: job.error,
  });
});

app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  if (job.status !== "done" || !job.zipPath || !job.zipFilename) {
    return res.status(409).json({ error: "Job is not ready for download" });
  }

  console.log("Download by IP:", req.ip, "job:", jobId);

  res.download(job.zipPath, job.zipFilename, (error) => {
    if (error) {
      return;
    }

    setTimeout(() => {
      safeUnlink(job.zipPath);
      jobs.delete(jobId);
    }, 60 * 1000);
  });
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({ error: error.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
