# Image Compressor API - SPEC

## Goal
Build a production-minded Node.js image compression API for a Webflow frontend using background processing and disk-based temporary storage.

## Stack
- Node.js
- Express
- Multer with disk storage
- Sharp
- CORS
- Archiver

## Output format
- use AVIF
- resize images to max width 1800px
- do not enlarge smaller images

## Compression strategy
- use AVIF
- single-pass compression
- use:
  - quality: 40
  - effort: 1
- process one image at a time
- prioritize stability and lower memory usage

## Input
- multipart/form-data
- field name for files: images
- field name for SEO name: seoName
- max 50 files
- allowed mime types:
  - image/jpeg
  - image/png
  - image/webp

## Filename rules
- do not use original uploaded filenames as base
- use req.body.seoName as the filename base
- sanitize seoName into an SEO-friendly slug
- generate one short random batch id per job
- filename format inside zip:
  [slug]-[batchId]-[index].avif
- zip filename:
  [slug]-[batchId]-compressed.zip

## Processing model
- compression runs in the background
- POST /compress creates a job and returns immediately
- uploaded originals are stored temporarily on disk
- compressed files are written temporarily to disk
- final zip file is written to disk
- completed jobs keep only metadata and file paths in memory
- no zip buffers in RAM
- jobs are stored in memory
- each job must have:
  - jobId
  - status
  - seoName
  - batchId
  - createdAt
  - progress
  - totalFiles
  - completedFiles
  - zipPath when done
  - zipFilename when done
  - error when failed

## Endpoints

### GET /
- returns plain text:
  API werkt

### POST /compress
- accepts files + seoName
- validates input
- creates a job
- immediately returns JSON:
  {
    "jobId": "...",
    "status": "processing"
  }

### GET /status/:jobId
- returns JSON:
  {
    "jobId": "...",
    "status": "processing" | "done" | "failed",
    "progress": {
      "completed": 0,
      "total": 0
    },
    "downloadUrl": "/download/:jobId" or null,
    "error": null or "..."
  }

### GET /download/:jobId
- if job is done:
  - returns the zip file directly from disk
- if job is not done:
  - returns JSON error

## Cleanup
- create temporary directories if they do not exist
- remove original uploaded files after compression
- remove temporary compressed files after zip creation
- optionally keep the final zip for download
- include a simple cleanup strategy for old jobs/files

## Extra
- include proper error handling
- use one file only for app logic: server.js
