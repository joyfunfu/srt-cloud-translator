export function parseSrt(srtContent) {
    const blocks = srtContent.replace(/\r\n/g, '\n').split('\n\n');
    const subtitles = [];
    for (const block of blocks) {
        if (block.trim() === '') continue;
        const lines = block.split('\n');
        if (lines.length < 2 || !lines[0] || !lines[1] || !lines[1].includes('-->')) continue;
        const idMatch = lines[0].match(/^\d+/);
        if (!idMatch) continue;
        subtitles.push({ id: parseInt(idMatch[0]), time: lines[1], text: lines.slice(2).join('\n') });
    }
    return subtitles;
}

export function smartChunkSrtBlocks(allBlocks, targetSize) {
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
        if (chunkBlocks.length === 0) {
             if (currentIndex < allBlocks.length) {
                const singleChunk = allBlocks.slice(currentIndex, currentIndex + 1);
                const textForAI = singleChunk.map(b => `<id:${b.id}> ${b.text.replace(/[\r\n]+/g, ' ').trim()}`).join('\n');
                chunks.push({ originalBlocks: singleChunk, textForAI });
                currentIndex++;
             } else {
                break;
             }
        } else {
            const textForAI = chunkBlocks.map(b => `<id:${b.id}> ${b.text.replace(/[\r\n]+/g, ' ').trim()}`).join('\n');
            chunks.push({ originalBlocks: chunkBlocks, textForAI });
            currentIndex = actualEndIndex;
        }
    }
    return chunks;
}

export function parseAiTranslationOutput(aiOutput) {
    const translations = [];
    const regex = /<id:(\d+)>([\s\S]*?)(?=(?:<id:\d+>|$))/g;
    let match;
    while ((match = regex.exec(aiOutput)) !== null) {
        translations.push({ id: parseInt(match[1]), text: match[2].trim() });
    }
    return translations;
}

export function forceMergeChunk(originalBlocks, translatedBlocks) {
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