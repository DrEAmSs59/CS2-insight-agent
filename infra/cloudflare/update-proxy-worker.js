/**
 * Cloudflare Worker: 智能增量更新代理 (支持大规模 Block 合并)
 * 
 * 核心优化：
 * 解决 Cloudflare Worker 50 次子请求限制。当 Electron 索要数百个块时，
 * 该脚本会自动将邻近的块合并为单个请求，确保不报 500 错误，并实现极速差量下载。
 */

const R2_ORIGIN = "https://pub-89edf85ff1b84f7bac561f78ec51f15b.r2.dev";
const MAX_SUB_REQUESTS = 40; // 预留 10 个名额给其他开销

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const r2Url = `${R2_ORIGIN}${url.pathname}${url.search}`;
    const rangeHeader = request.headers.get("Range");

    if (!rangeHeader || !rangeHeader.includes(",")) {
      return fetch(r2Url, request);
    }

    try {
      // 1. 解析原始请求的所有 Range 块
      let rawRanges = rangeHeader.replace("bytes=", "").split(",").map(r => {
        const [start, end] = r.trim().split("-").map(Number);
        return { start, end };
      });

      // 2. 智能合并算法：将几百个碎块压缩到 40 个以内的请求
      // 我们通过允许下载少量“间隙数据”来换取请求次数的减少
      rawRanges.sort((a, b) => a.start - b.start);
      
      let mergedRanges = [];
      if (rawRanges.length > 0) {
        let current = { ...rawRanges[0] };
        
        // 计算合并阈值：如果碎块太多，加大合并力度
        const gapThreshold = rawRanges.length > MAX_SUB_REQUESTS ? 1024 * 512 : 1024 * 64; 

        for (let i = 1; i < rawRanges.length; i++) {
          const next = rawRanges[i];
          // 如果两个块之间的间隙小于阈值，或者合并后总数依然太多，则强行合并
          if ((next.start - current.end <= gapThreshold) || 
              (rawRanges.length - i + mergedRanges.length > MAX_SUB_REQUESTS)) {
            current.end = Math.max(current.end, next.end);
          } else {
            mergedRanges.push(current);
            current = { ...next };
          }
        }
        mergedRanges.push(current);
      }

      // 如果合并后依然超过限制（极端情况），进行二次强力压缩
      while (mergedRanges.length > MAX_SUB_REQUESTS) {
        let minGapIndex = -1;
        let minGap = Infinity;
        for (let i = 0; i < mergedRanges.length - 1; i++) {
          let gap = mergedRanges[i+1].start - mergedRanges[i].end;
          if (gap < minGap) { minGap = gap; minGapIndex = i; }
        }
        mergedRanges[minGapIndex].end = mergedRanges[minGapIndex+1].end;
        mergedRanges.splice(minGapIndex + 1, 1);
      }

      console.log(`[Worker] Compressed ${rawRanges.length} blocks into ${mergedRanges.length} requests.`);

      // 3. 并行获取合并后的数据块
      const boundary = `insight_agent_${Math.random().toString(36).slice(2)}`;
      const parts = await Promise.all(mergedRanges.map(async (r) => {
        const resp = await fetch(r2Url, {
          headers: { "Range": `bytes=${r.start}-${r.end}` }
        });
        if (!resp.ok) throw new Error(`R2 Fetch failed: ${resp.status}`);
        
        const buffer = await resp.arrayBuffer();
        const data = new Uint8Array(buffer);

        // 4. 从合并后的数据中，精准切出原始请求需要的碎片（可选优化，目前直接返回合并段更稳）
        // 这里我们按照 RFC 标准返回合并后的段落
        let part = `--${boundary}\r\n`;
        part += `Content-Type: application/octet-stream\r\n`;
        part += `Content-Range: bytes ${r.start}-${r.end}/*\r\n\r\n`;
        
        return {
          header: new TextEncoder().encode(part),
          data: data,
          footer: new TextEncoder().encode("\r\n")
        };
      }));

      // 5. 拼装最终响应
      const finalFooter = new TextEncoder().encode(`--${boundary}--\r\n`);
      let totalSize = finalFooter.byteLength;
      for (const p of parts) totalSize += p.header.byteLength + p.data.byteLength + p.footer.byteLength;

      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const p of parts) {
        combined.set(p.header, offset); offset += p.header.byteLength;
        combined.set(p.data, offset); offset += p.data.byteLength;
        combined.set(p.footer, offset); offset += p.footer.byteLength;
      }
      combined.set(finalFooter, offset);

      return new Response(combined, {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "Content-Type": `multipart/byteranges; boundary=${boundary}`,
          "Cache-Control": "no-store"
        }
      });

    } catch (err) {
      console.error("[Worker Error]", err);
      return fetch(r2Url); // 保底方案：返回全量
    }
  }
};
