const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

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

async function compressToTargetAvif(buffer) {
  const qualities = [45, 35, 30];
  let smallestBuffer = null;

  for (const quality of qualities) {
    const outputBuffer = await sharp(buffer)
      .rotate()
      .resize({
        width: 1800,
        withoutEnlargement: true,
        fit: "inside",
      })
      .avif({ quality })
      .toBuffer();

    if (!smallestBuffer || outputBuffer.length < smallestBuffer.length) {
      smallestBuffer = outputBuffer;
    }

    if (outputBuffer.length <= 200 * 1024) {
      return outputBuffer;
    }
  }

  return smallestBuffer;
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

    const slug = slugifySeoName(seoName) || "image";
    const batchId = generateBatchId();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${slug}-${batchId}-compressed.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (error) => {
      next(error);
    });

    archive.pipe(res);

    for (const [index, file] of files.entries()) {
      const compressedBuffer = await compressToTargetAvif(file.buffer);
      const filename = `${slug}-${batchId}-${index + 1}.avif`;

      archive.append(compressedBuffer, { name: filename });
    }

    await archive.finalize();
  } catch (error) {
    next(error);
  }
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
