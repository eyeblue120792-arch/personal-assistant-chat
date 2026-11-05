import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Tesseract from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3001;
const UPLOAD_DIR = path.join(__dirname, 'storage', 'uploads');
const METADATA_FILE = path.join(__dirname, 'storage', 'files.json');
const DIST_DIR = path.join(__dirname, 'dist');

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(path.dirname(METADATA_FILE), { recursive: true });

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '-');
    const suffix = Date.now() + '-' + Math.round(Math.random() * 10000);
    cb(null, `${suffix}-${safeName}`);
  },
});

const upload = multer({ storage });

const normalizeText = (value) =>
  String(value || '').replace(/\s+/g, ' ').trim();

async function ensureMetadataFile() {
  try {
    await fs.access(METADATA_FILE);
  } catch {
    await fs.writeFile(METADATA_FILE, JSON.stringify([], null, 2));
  }
}

async function readMetadata() {
  await ensureMetadataFile();
  const content = await fs.readFile(METADATA_FILE, 'utf-8');
  try {
    return JSON.parse(content || '[]');
  } catch {
    return [];
  }
}

async function writeMetadata(data) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(data, null, 2));
}

async function extractTextFromPdf(filePath) {
  const data = await fs.readFile(filePath);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(' ');
    pages.push(pageText);
  }

  return pages.join('\n\n');
}

async function extractTextFromImage(filePath) {
  const { data } = await Tesseract.recognize(filePath, 'eng');
  return data?.text || '';
}

async function extractTextFromFile(filePath, mimeType) {
  const type = mimeType.toLowerCase();

  if (type.includes('text') || type.includes('json') || type.includes('javascript') || type.includes('csv') || type.includes('xml') || type.includes('yaml')) {
    return fs.readFile(filePath, 'utf-8');
  }

  if (type.includes('pdf')) {
    return extractTextFromPdf(filePath);
  }

  if (type.includes('image')) {
    return extractTextFromImage(filePath);
  }

  return '';
}

async function summarizeText(text) {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return sentences.slice(0, 5).join(' ');
}

function buildLocalAssistantReply(message, files) {
  const lowerMsg = message.toLowerCase();
  const texts = files
    .filter((file) => file.text && file.text.length > 0)
    .map((file) => `${file.name}: ${file.text}`)
    .join('\n\n');

  if (!texts) {
    if (lowerMsg.includes('hai') || lowerMsg.includes('halo') || lowerMsg.includes('hello')) {
      return 'Halo! Saya siap membantu. Unggah dokumen atau foto Anda, lalu tanyakan hal yang ingin Anda ketahui.';
    }

    if (lowerMsg.includes('ringkas')) {
      return 'Belum ada file yang diunggah. Unggah dokumen pertama Anda, lalu saya akan meringkasnya.';
    }

    return 'Saya masih menunggu dokumen Anda. Unggah file terlebih dahulu, lalu saya bisa menjawab berdasarkan isinya.';
  }

  if (lowerMsg.includes('ringkas') || lowerMsg.includes('summary') || lowerMsg.includes('resume')) {
    const summary = summarizeText(texts);
    return `Berikut ringkasan inti dari dokumen yang Anda unggah:\n\n${summary}`;
  }

  if (lowerMsg.includes('siapa') || lowerMsg.includes('nama') || lowerMsg.includes('who')) {
    const match = texts.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
    if (match && match[0]) {
      return `Saya melihat nama yang mungkin relevan adalah: ${match[0]}. Saya sarankan kita fokus pada konteks dokumen yang Anda upload untuk konfirmasi lebih lanjut.`;
    }
    return 'Saya melihat beberapa entitas penting di dokumen Anda. Bisa saya bantu jelaskan lebih detail jika Anda ceritakan topik yang ingin dipahami.';
  }

  if (lowerMsg.includes('buat') || lowerMsg.includes('tulis') || lowerMsg.includes('draft')) {
    return 'Saya sudah memiliki konteks dari dokumen Anda. Saya bisa menyiapkan draft ringkas, poin penting, atau versi yang lebih formal dari isi dokumen tersebut.';
  }

  return `Saya melihat file yang Anda unggah berisi konten berikut: ${summarizeText(texts)}. Jika Anda ingin, saya bisa membantu menjelaskan poin utama, membuat ringkasan, atau menulis versi yang lebih rapi.`;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/api', express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', message: 'Server ready' });
});

app.post('/api/upload', upload.array('files', 12), async (req, res) => {
  try {
    const files = req.files || [];
    const existing = await readMetadata();

    const savedFiles = [];

    for (const file of files) {
      const text = await extractTextFromFile(path.join(file.destination, file.filename), file.mimetype);
      const record = {
        id: crypto.randomUUID(),
        name: file.originalname,
        filename: file.filename,
        path: `storage/uploads/${file.filename}`,
        type: file.mimetype,
        size: file.size,
        uploadedAt: new Date().toISOString(),
        text: normalizeText(text).slice(0, 12000),
      };

      savedFiles.push(record);
      existing.unshift(record);
    }

    await writeMetadata(existing);
    res.json({ message: 'Upload berhasil', files: savedFiles });
  } catch (error) {
    res.status(500).json({ message: 'Upload gagal', error: error.message });
  }
});

app.get('/api/files', async (_req, res) => {
  try {
    const metadata = await readMetadata();
    res.json(metadata);
  } catch (error) {
    res.status(500).json({ message: 'Gagal membaca file', error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    const files = await readMetadata();

    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: 'Pertanyaan tidak boleh kosong' });
    }

    const assistantReply = buildLocalAssistantReply(message, files);
    res.json({
      reply: assistantReply,
      sourceFiles: files.slice(0, 5).map((file) => ({ name: file.name, type: file.type })),
    });
  } catch (error) {
    res.status(500).json({ message: 'Gagal membuat jawaban', error: error.message });
  }
});

app.delete('/api/files/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const data = await readMetadata();
    const target = data.find((item) => item.id === id);

    if (target) {
      const fileLocation = path.join(__dirname, target.filename || target.path || '');
      try {
        await fs.unlink(fileLocation);
      } catch {
        // ignore if file is already missing
      }
    }

    const filtered = data.filter((item) => item.id !== id);
    await writeMetadata(filtered);
    res.json({ message: 'File dihapus', deletedId: id });
  } catch (error) {
    res.status(500).json({ message: 'Gagal menghapus file', error: error.message });
  }
});

app.use(express.static(DIST_DIR));

app.get('*', async (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ message: 'Endpoint tidak ditemukan' });
  }

  const indexFile = path.join(DIST_DIR, 'index.html');
  try {
    await fs.access(indexFile);
    res.sendFile(indexFile);
  } catch {
    res.send(`
      <html>
        <body>
          <h1>Smart Personal Assistant</h1>
          <p>Build frontend Anda dengan npm run build lalu jalankan server.</p>
        </body>
      </html>
    `);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});
