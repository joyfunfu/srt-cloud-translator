import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    const { jobIds } = req.query;
    if (!jobIds) {
        return res.status(400).json({ error: 'jobIds query parameter is required' });
    }
    const ids = jobIds.split(',').map(id => `job:${id}`);
    if(ids.length === 0) return res.status(200).json([]);
    try {
        const jobs = await kv.mget(...ids);
        res.status(200).json(jobs.filter(Boolean));
    } catch (error) {
        console.error("KV mget error:", error);
        res.status(500).json({ error: 'Failed to retrieve job statuses.' });
    }
}