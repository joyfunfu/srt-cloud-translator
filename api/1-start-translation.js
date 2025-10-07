import { kv } from '@vercel/kv';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { smartChunkSrtBlocks, parseSrt } from '../../utils/srtParser.js';

export const config = { api: { bodyParser: false } };
const upload = multer({ storage: multer.memoryStorage() });

const runMiddleware = (req, res, fn) => new Promise((resolve, reject) => {
    fn(req, res, (result) => { if (result instanceof Error) return reject(result); return resolve(result); });
});

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    try {
        await runMiddleware(req, res, upload.array('srtFiles'));
        const newJobs = [];
        for (const file of req.files) {
            const jobId = uuidv4();
            const originalFilename = file.originalname;
            
            const fileContent = file.buffer.toString('utf-8');
            // KV has a 1MB limit per value. We check against 950KB to be safe.
            if (fileContent.length > 950 * 1024) {
                console.warn(`Skipping file ${originalFilename} because it is too large.`);
                continue; 
            }
            const allSrtBlocks = parseSrt(fileContent);
            if (allSrtBlocks.length === 0) continue;
            
            const chunks = smartChunkSrtBlocks(allSrtBlocks, 30);
            
            const job = {
                jobId,
                filename: originalFilename,
                status: 'pending',
                originalContent: fileContent,
                translatedContent: null,
                createdAt: new Date().toISOString(),
                chunks,
                chunksTotal: chunks.length,
                chunksCompleted: 0,
                translatedChunks: [],
                error: null,
            };
            
            await kv.set(`job:${jobId}`, job);
            newJobs.push(job);

            const protocol = process.env.VERCEL_ENV === 'development' ? 'http' : 'https';
            const host = process.env.VERCEL_URL || 'localhost:3000';

            fetch(`${protocol}://${host}/api/2-process-chunk`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.INTERNAL_SECRET}` 
                },
                body: JSON.stringify({ jobId }),
            });
        }
        res.status(202).json(newJobs);
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: 'File upload failed.' });
    }
}