# Image Compressor API - SPEC

## Goal
Build a simple Node.js image compression API for a Webflow frontend.

## Stack
- Node.js
- Express
- Multer with memory storage
- Sharp
- CORS
- Archiver

## Endpoint
POST /compress

## Input
- multipart/form-data
- field name for files: images
- field name for SEO name: seoName
- max 50 files
- allowed mime types:
  - image/jpeg
  - image/png
  - image/webp

## Processing
- convert all images to WebP
- resize images to max width 1800px
- do not enlarge smaller images
- process images fully in memory
- target about 200 KB using a 2-step WebP compression strategy
- first try WebP quality 75
- if the result is above 200 KB, try WebP quality 65
- use the first version that is at or under 200 KB
- if both versions are above 200 KB, use the smaller version
- process multiple images in parallel with a controlled concurrency limit
- limit parallel processing to avoid memory overload
- prioritize speed and a good compression balance

## Filename rules
- do not use the original uploaded filename as the base
- use req.body.seoName as the filename base
- sanitize seoName into an SEO-friendly slug:
  - lowercase only
  - remove accents
  - remove special characters
  - replace spaces and separators with hyphens
  - remove duplicate hyphens
  - trim leading and trailing hyphens
- generate one short random batch id per request
- append the same batch id to every file in that request
- append the file index starting from 1
- extension must always be .webp

## Filename example
If seoName is:
appartement te koop antwerpen

And batch id is:
x7k2

Then filenames inside the zip should look like:
appartement-te-koop-antwerpen-x7k2-1.webp
appartement-te-koop-antwerpen-x7k2-2.webp

## Zip filename
The zip filename should also include the batch id:
appartement-te-koop-antwerpen-x7k2-compressed.zip

## Output
- return one zip file directly in the response

## Extra
- GET / returns: API werkt
- include proper error handling
- use one file only for app logic: server.js
