import { kv } from '@vercel/kv';
import { del } from '@vercel/blob';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
        const { jobId } = req.body;
        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }
        console.log(`[Cleanup] Received request to clean up job: ${jobId}`);
        const jobKey = `job:${jobId}`;
        const job = await kv.get(jobKey);
        if (!job) {
            console.log(`[Cleanup] Job ${jobId} not found, assuming already cleaned up.`);
            return res.status(200).json({ message: 'Job not found, assumed already cleaned up.' });
        }
        const urlsToDelete = [];
        if (job.blobUrl) urlsToDelete.push(job.blobUrl);
        if (job.downloadUrl) urlsToDelete.push(job.downloadUrl);
        if (urlsToDelete.length > 0) {
            console.log(`[Cleanup] Deleting files from Blob:`, urlsToDelete);
            await del(urlsToDelete);
        }
        console.log(`[Cleanup] Deleting job record from KV: ${jobKey}`);
        await kv.del(jobKey);
        res.status(200).json({ message: `Successfully cleaned up job ${jobId}.` });
    } catch (error) {
        console.error(`[Cleanup] Error cleaning up job:`, error);
        res.status(200).json({ message: 'Cleanup process finished, errors logged on server.' });
    }
}