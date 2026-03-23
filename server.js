const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const crypto = require("crypto");
const pLimit = require("p-limit").default;

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const limit = pLimit(2);
const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
});

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

async function compressImage(fileBuffer) {
  return sharp(fileBuffer)
    .resize({ width: 1800, withoutEnlargement: true })
    .avif({
      quality: 40,
      effort: 1,
    })
    .toBuffer();
}

async function createZipBuffer(files, slug, batchId) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const chunks = [];

  return new Promise((resolve, reject) => {
    archive.on("data", (chunk) => {
      chunks.push(chunk);
    });

    archive.on("warning", (error) => {
      reject(error);
    });

    archive.on("error", (error) => {
      reject(error);
    });

    archive.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    for (const [index, file] of files.entries()) {
      archive.append(file.buffer, {
        name: `${slug}-${batchId}-${index + 1}.avif`,
      });
    }

    archive.finalize().catch(reject);
  });
}

async function processJob(jobId, files, seoName) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  try {
    const slug = slugifySeoName(seoName) || "image";
    const compressedFiles = await Promise.all(
      files.map((file) =>
        limit(async () => {
          const buffer = await compressImage(file.buffer);

          job.progress.completed += 1;

          return { buffer };
        })
      )
    );

    const zipBuffer = await createZipBuffer(compressedFiles, slug, job.batchId);

    job.zipBuffer = zipBuffer;
    job.zipFilename = `${slug}-${job.batchId}-compressed.zip`;
    job.status = "done";
    job.completedFiles = job.progress.completed;
    job.totalFiles = job.progress.total;
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "Job processing failed";
  }
}

app.use(cors());

app.get("/", (req, res) => {
  res.send("API werkt");
});

app.post("/compress", upload.array("images", 50), async (req, res, next) => {
  try {
    const files = req.files || [];
    const seoName = req.body.seoName;

    if (!seoName || !String(seoName).trim()) {
      return res.status(400).json({ error: "seoName is required" });
    }

    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const invalidFile = files.find((file) => !ALLOWED_MIME_TYPES.has(file.mimetype));

    if (invalidFile) {
      return res.status(400).json({ error: "Only JPEG, PNG, and WEBP files are allowed" });
    }

    const jobId = generateJobId();
    const batchId = generateBatchId();
    const job = {
      jobId,
      status: "processing",
      seoName,
      batchId,
      createdAt: new Date().toISOString(),
      progress: {
        completed: 0,
        total: files.length,
      },
      totalFiles: files.length,
      completedFiles: 0,
      zipBuffer: null,
      zipFilename: null,
      error: null,
    };

    jobs.set(jobId, job);

    res.json({
      jobId,
      status: "processing",
    });

    setImmediate(() => {
      processJob(jobId, files, seoName);
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
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  if (job.status !== "done" || !job.zipBuffer || !job.zipFilename) {
    return res.status(409).json({ error: "Job is not ready for download" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${job.zipFilename}"`
  );
  res.send(job.zipBuffer);
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
