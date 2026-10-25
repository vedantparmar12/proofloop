import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import mammoth from 'mammoth';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { dataDirectory } from './db.js';

const require = createRequire(import.meta.url);
const fontDirectory = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));

export async function extractCvText(buffer, mimeType, filename = '') {
  const extension = path.extname(filename).toLowerCase();
  const isPdf = mimeType === 'application/pdf' || extension === '.pdf';
  const isDocx = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === '.docx';

  if (isPdf) {
    if (buffer.subarray(0, 4).toString() !== '%PDF') throw new Error('Invalid PDF file');
    const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
    if (document.numPages > 20) throw new Error('Please upload a CV with 20 pages or fewer');
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    const text = pages.join('\n\n').trim();
    if (text.length < 50) throw new Error('No selectable text found. Please upload a text-based PDF or DOCX.');
    return text.slice(0, 100000);
  }

  if (isDocx) {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('Invalid DOCX file');
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    if (text.length < 50) throw new Error('Not enough text found in the DOCX file.');
    return text.slice(0, 100000);
  }

  if (mimeType === 'text/plain' || extension === '.txt' || extension === '.md') {
    const text = buffer.toString('utf8').trim();
    if (text.length < 50) throw new Error('Not enough CV text found.');
    return text.slice(0, 100000);
  }

  throw new Error('Upload a PDF, DOCX, TXT, or Markdown CV');
}

export async function createCvPdf(markdown, filename) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(path.join(fontDirectory, 'DejaVuSans.ttf')),
    readFile(path.join(fontDirectory, 'DejaVuSans-Bold.ttf')),
  ]);
  const regular = await pdf.embedFont(regularBytes);
  const bold = await pdf.embedFont(boldBytes);
  const pageSize = [595.28, 841.89];
  const margin = 48;
  const maxWidth = pageSize[0] - margin * 2;
  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;

  const addPage = () => {
    page = pdf.addPage(pageSize);
    y = pageSize[1] - margin;
  };

  for (const rawLine of markdown.replace(/\r/g, '').split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(rawLine);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(rawLine);
    const text = heading?.[2] || bullet?.[1] || rawLine.replace(/\*\*/g, '').trim();
    const font = heading || rawLine.startsWith('**') ? bold : regular;
    const size = heading?.[1].length === 1 ? 17 : heading ? 12 : 10;
    const lineHeight = size + 4;
    const prefix = bullet ? '• ' : '';
    const indent = bullet ? 10 : 0;
    const lines = wrapText(prefix + text, font, size, maxWidth - indent);

    if (!text) {
      y -= 6;
      continue;
    }
    if (y - lines.length * lineHeight < margin) addPage();
    if (heading && y < pageSize[1] - margin) y -= 4;

    for (const line of lines) {
      if (y < margin) addPage();
      page.drawText(line, { x: margin + indent, y, size, font, color: rgb(0.12, 0.14, 0.17) });
      y -= lineHeight;
    }
    if (heading) y -= 3;
  }

  const output = path.join(dataDirectory, filename);
  await writeFile(output, await pdf.save());
  return output;
}

export async function inspectCvPdf(file, profile) {
  let pages = 0;
  let characters = 0;
  let text = '';
  let readError = '';

  try {
    const bytes = await readFile(file);
    if (bytes.subarray(0, 4).toString() !== '%PDF') throw new Error('Invalid PDF file');
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
    pages = document.numPages;
    const parts = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => item.str).join(' '));
    }
    text = parts.join('\n\n').trim();
    characters = text.length;
  } catch {
    readError = 'The generated PDF could not be read as text.';
  }

  const checks = [];
  checks.push(readError
    ? { label: 'Selectable text', status: 'fail', detail: readError }
    : {
        label: 'Selectable text',
        status: characters >= 80 ? 'pass' : 'fail',
        detail: characters >= 80
          ? `${characters} characters across ${pages} page${pages === 1 ? '' : 's'}.`
          : 'Too little selectable text was found.',
      });

  if (!readError && characters >= 80) {
    checks.push({
      label: 'Clean text layer',
      status: text.includes('\uFFFD') || /\(cid:\d+\)/.test(text) ? 'fail' : 'pass',
      detail: text.includes('\uFFFD') || /\(cid:\d+\)/.test(text)
        ? 'Some characters are garbled in the text layer.'
        : 'No replacement glyphs or CID placeholders.',
    });

    const searchable = text.toLowerCase().replace(/\s+/g, ' ');
    const name = profile.name.trim().replace(/\s+/g, ' ');
    checks.push(name
      ? {
          label: 'Name',
          status: searchable.includes(name.toLowerCase()) ? 'pass' : 'warn',
          detail: searchable.includes(name.toLowerCase())
            ? 'Profile name is present as text.'
            : 'Profile name was not found as selectable text.',
        }
      : { label: 'Name', status: 'warn', detail: 'Add a name to the profile to check it.' });

    const email = profile.email.trim();
    checks.push(email
      ? {
          label: 'Email',
          status: searchable.includes(email.toLowerCase()) ? 'pass' : 'fail',
          detail: searchable.includes(email.toLowerCase())
            ? 'Profile email is present as text.'
            : 'Profile email was not found as selectable text.',
        }
      : { label: 'Email', status: 'warn', detail: 'Add an email to the profile to check it.' });

    const phoneDigits = profile.phone.replace(/\D/g, '');
    if (phoneDigits) {
      checks.push({
        label: 'Phone',
        status: searchable.replace(/\D/g, '').includes(phoneDigits) ? 'pass' : 'warn',
        detail: searchable.replace(/\D/g, '').includes(phoneDigits)
          ? 'Profile phone digits are present as text.'
          : 'Profile phone digits were not found; the template may omit the phone number.',
      });
    }
  }

  const status = checks.some((check) => check.status === 'fail') ? 'fail'
    : checks.some((check) => check.status === 'warn') ? 'warn' : 'pass';
  return { status, pages, characters, checks };
}

function wrapText(text, font, size, maxWidth) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
