# Image Compressor API - SPEC

## Goal
Build a production-minded Node.js image compression API for a Webflow frontend using background processing.

## Stack
- Node.js
- Express
- Multer with memory storage
- Sharp
- CORS
- Archiver
- p-limit

## Output format
- use AVIF again
- resize images to max width 1800px
- do not enlarge smaller images

## Compression strategy
- use AVIF
- use single-pass compression for speed and stability
- use:
  - quality: 40
  - effort: 1
- process images fully in memory

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
- sanitize seoName into an SEO-friendly slug:
  - lowercase only
  - remove accents
  - remove special characters
  - replace spaces and separators with hyphens
  - remove duplicate hyphens
  - trim leading and trailing hyphens
- generate one short random batch id per job
- use the same batch id for all files in the job
- filename format inside zip:
  [slug]-[batchId]-[index].avif
- zip filename:
  [slug]-[batchId]-compressed.zip

## Processing model
- compression must run in the background
- POST /compress must NOT wait for the zip to finish
- POST /compress must create a job and return JSON immediately
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
  - zipBuffer when done
  - zipFilename when done
  - error when failed

## Concurrency
- use controlled parallel processing
- use p-limit with concurrency 2

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
  - returns the zip file directly
- if job is not done:
  - returns JSON error with proper status code

## Extra
- include proper error handling
- use one file only for app logic: server.js
