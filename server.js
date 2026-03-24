const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
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

sharp.concurrency(1);
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

async function compressImageToFile(inputPath, outputPath) {
  await sharp(inputPath)
    .resize({ width: 1800, withoutEnlargement: true })
    .avif({
      quality: 40,
      effort: 1,
    })
    .toFile(outputPath);
}

async function createZipFromFiles(filePaths, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

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
  const processedPaths = [];
  const originalPaths = files.map((file) => file.path);

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const outputPath = path.join(
        PROCESSED_DIR,
        `${slug}-${job.batchId}-${index + 1}.avif`
      );

      await compressImageToFile(file.path, outputPath);
      processedPaths.push(outputPath);
      job.progress.completed += 1;
      job.completedFiles = job.progress.completed;

      safeUnlink(file.path);
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

app.post("/compress", upload.array("images", 50), async (req, res, next) => {
  try {
    const files = req.files || [];
    const seoName = req.body.seoName;

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
