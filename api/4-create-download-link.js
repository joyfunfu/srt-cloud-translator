import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
        const { jobId } = req.body;
        if (!jobId) return res.status(400).json({ error: 'jobId is required' });

        const jobKey = `job:${jobId}`;
        const job = await kv.get(jobKey);
        if (!job || job.status !== 'completed' || !job.translatedContent) {
            return res.status(404).json({ error: 'Job not found or not completed.' });
        }

        const translatedFilename = `translated-${job.filename}`;
        const { url } = await put(translatedFilename, job.translatedContent, {
            access: 'public',
            addRandomSuffix: true,
        });

        await kv.del(jobKey);

        res.status(200).json({ url, filename: translatedFilename });
    } catch (error) {
        console.error("Download link creation error:", error);
        res.status(500).json({ error: 'Failed to create download link.' });
    }
}