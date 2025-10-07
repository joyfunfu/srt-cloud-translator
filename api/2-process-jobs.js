import { kv } from '@vercel/kv';
import { put } from '@vercel/blob';
import ZhipuAI from "zhipuai";

// --- AI Prompts ---
const TRANSLATION_PROMPT = `You are an expert subtitle translator. Your task is to translate the provided SRT subtitle blocks into high-quality, natural-sounding simplified Chinese. CRITICAL FORMATTING INSTRUCTIONS: 1. Each translated block MUST correspond to an original block ID. You will receive input text prefixed with block IDs like "<id:X> original text". 2. Your output MUST consist ONLY of the translated text, prefixed with the *exact same* block IDs. For each original "<id:X> text", you must output "<id:X> translated Chinese text". 3. The sequence and total count of block IDs in your output MUST BE IDENTICAL to the input. 4. Do NOT include any explanations or comments. --- START OF TEXT TO TRANSLATE ---`;
const RETRY_PROMPT_TEMPLATE = (originalText, errorMessage) => `You are an expert subtitle translator. Your previous attempt failed validation. You MUST correct your mistake. # The Error You Made: ${errorMessage}. # The Original Text to Translate (AGAIN): --- ${originalText} --- # Critical Instructions (Re-read Carefully): 1. Re-translate the original text provided above. 2. The total count of block IDs in your output MUST BE IDENTICAL to the original text's block ID count. 3. Your output must ONLY be the translated lines, each prefixed with its correct <id:X> tag. 4. Do NOT include explanations, apologies, or any other text. Now, provide the correct translation:`;

export default async function handler(req, res) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const allJobKeys = await kv.keys('job:*');
    if (allJobKeys.length === 0) {
        return res.status(200).json({ message: 'No jobs found.' });
    }
    const allJobs = await kv.mget(...allJobKeys);
    const pendingJob = allJobs.find(job => job && job.status === 'pending');
    if (!pendingJob) {
        return res.status(200).json({ message: 'No pending jobs.' });
    }
    const { jobId } = pendingJob;
    try {
        pendingJob.status = 'processing';
        await kv.set(`job:${jobId}`, pendingJob);
        const zhipuai = new ZhipuAI({ apiKey: process.env.ZHIPU_API_KEY });
        const response = await fetch(pendingJob.blobUrl);
        const originalContent = await response.text();
        const translatedContent = await translateFileChunkByChunk(originalContent, zhipuai, jobId);
        const translatedFilename = `translated-${jobId}.srt`;
        const translatedBlob = await put(translatedFilename, translatedContent, { access: 'public', addRandomSuffix: false });
        const finalJob = await kv.get(`job:${jobId}`);
        finalJob.status = 'completed';
        finalJob.downloadUrl = translatedBlob.url;
        await kv.set(`job:${jobId}`, finalJob);
        res.status(200).json({ message: `Job ${jobId} completed.` });
    } catch (error) {
        console.error(`[Job ${jobId}] Failed to process:`, error);
        const failedJob = await kv.get(`job:${jobId}`);
        failedJob.status = 'failed';
        failedJob.error = error.message;
        await kv.set(`job:${jobId}`, failedJob);
        res.status(500).json({ message: `Failed to process job ${jobId}.` });
    }
}

async function translateFileChunkByChunk(fileContent, zhipuai, jobId) {
    const allSrtBlocks = parseSrt(fileContent);
    if (allSrtBlocks.length === 0) throw new Error("No valid SRT blocks found.");
    const chunks = smartChunkSrtBlocks(allSrtBlocks, 30);
    const job = await kv.get(`job:${jobId}`);
    job.chunksTotal = chunks.length;
    await kv.set(`job:${jobId}`, job);
    let allTranslatedSrt = '';
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`[Job ${jobId}] Translating chunk ${i + 1}/${chunks.length}`);
        const translatedBlocks = await translateSingleChunkWithRetry(chunk, zhipuai);
        allTranslatedSrt += forceMergeChunk(chunk.originalBlocks, translatedBlocks);
        const currentJob = await kv.get(`job:${jobId}`);
        currentJob.chunksCompleted = i + 1;
        await kv.set(`job:${jobId}`, currentJob);
    }
    return allTranslatedSrt;
}

async function translateSingleChunkWithRetry(chunk, zhipuai) {
    let lastFaultyParsedTranslation = [];
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let promptContent;
            if (attempt === 1) {
                promptContent = TRANSLATION_PROMPT + chunk.textForAI;
            } else {
                const errorMessage = `ID数量不匹配。原文应有 ${chunk.originalBlocks.length} 个ID，但你返回了 ${lastFaultyParsedTranslation.length} 个。`;
                promptContent = RETRY_PROMPT_TEMPLATE(chunk.textForAI, errorMessage);
            }
            const response = await zhipuai.chat.completions.create({
                model: "glm-4.5-flash",
                messages: [{ role: "user", content: promptContent }],
            });
            const aiResponse = response.choices[0].message.content;
            const translatedBlocks = parseAiTranslationOutput(aiResponse);
            if (chunk.originalBlocks.length === translatedBlocks.length) {
                return translatedBlocks;
            } else {
                lastFaultyParsedTranslation = translatedBlocks;
            }
        } catch (error) {
            console.error(`Chunk translation attempt ${attempt} failed:`, error);
            if (attempt === MAX_RETRIES) throw error;
        }
    }
    return lastFaultyParsedTranslation;
}

function parseSrt(srtContent) {
    const blocks = srtContent.replace(/\r\n/g, '\n').split('\n\n');
    const subtitles = [];
    for (const block of blocks) {
        if (block.trim() === '') continue;
        const lines = block.split('\n');
        if (!lines[0] || !lines[1] || !lines[1].includes('-->')) continue;
        subtitles.push({ id: parseInt(lines[0]), time: lines[1], text: lines.slice(2).join('\n') });
    }
    return subtitles;
}

function smartChunkSrtBlocks(allBlocks, targetSize) {
    const chunks = [];
    let currentIndex = 0;
    while (currentIndex < allBlocks.length) {
        let potentialEndIndex = Math.min(currentIndex + targetSize, allBlocks.length);
        let actualEndIndex = potentialEndIndex;
        for (let i = potentialEndIndex - 1; i > currentIndex; i--) {
            const text = allBlocks[i].text.trim();
            if (/[.!?]$/.test(text)) {
                actualEndIndex = i + 1;
                break;
            }
        }
        const chunkBlocks = allBlocks.slice(currentIndex, actualEndIndex);
        const textForAI = chunkBlocks.map(b => `<id:${b.id}> ${b.text.replace(/[\r\n]+/g, ' ').trim()}`).join('\n');
        chunks.push({ originalBlocks: chunkBlocks, textForAI });
        currentIndex = actualEndIndex;
    }
    return chunks;
}

function parseAiTranslationOutput(aiOutput) {
    const translations = [];
    const regex = /<id:(\d+)>([\s\S]*?)(?=(?:<id:\d+>|$))/g;
    let match;
    while ((match = regex.exec(aiOutput)) !== null) {
        translations.push({ id: parseInt(match[1]), text: match[2].trim() });
    }
    return translations;
}

function forceMergeChunk(originalBlocks, translatedBlocks) {
    const translatedMap = new Map((translatedBlocks || []).map(b => [b.id, b]));
    let finalSrt = '';
    for (const oBlock of originalBlocks) {
        const tBlock = translatedMap.get(oBlock.id);
        const translatedText = tBlock ? tBlock.text.trim().replace(/[\r\n]+/g, ' ') : oBlock.text.trim().replace(/[\r\n]+/g, ' ');
        const originalText = oBlock.text.trim().replace(/[\r\n]+/g, ' ');
        finalSrt += `${oBlock.id}\n${oBlock.time}\n${translatedText}\n${originalText}\n\n`;
    }
    return finalSrt;
}