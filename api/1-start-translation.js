import { put } from '@vercel/blob';
import { kv } from '@vercel/kv';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';

export const config = { api: { bodyParser: false } };

const upload = multer({ storage: multer.memoryStorage() });

const runMiddleware = (req, res, fn) => new Promise((resolve, reject) => {
    fn(req, res, (result) => {
        if (result instanceof Error) return reject(result);
        return resolve(result);
    });
});

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
        await runMiddleware(req, res, upload.array('srtFiles'));
        const newJobs = [];
        for (const file of req.files) {
            const jobId = uuidv4();
            const originalFilename = file.originalname;
            const newFilename = `${jobId}-${originalFilename}`;
            const blob = await put(newFilename, file.buffer, { access: 'public', addRandomSuffix: false });
            const job = {
                jobId,
                filename: originalFilename,
                status: 'pending',
                blobUrl: blob.url,
                downloadUrl: null,
                createdAt: new Date().toISOString(),
                chunksTotal: 0,
                chunksCompleted: 0,
                error: null,
            };
            await kv.set(`job:${jobId}`, job);
            newJobs.push(job);
        }
        res.status(202).json(newJobs);
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: 'File upload failed.' });
    }
}